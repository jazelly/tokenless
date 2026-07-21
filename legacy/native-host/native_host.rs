use crate::config::{write_json_atomic_secure, ConfigStore, ConfigUpdate};
use crate::{ClaimNextJob, CompleteJob, DaemonError, Job, JobStatus, JobStore, JobSummary, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use uuid::Uuid;

pub const NATIVE_PROTOCOL: &str = "tokenless.native.v1";
pub const BRIDGE_MARKER_PROTOCOL: &str = "tokenless.extension-bridge-state.v1";
pub const BRIDGE_MARKER_FILE_NAME: &str = "extension-bridge.json";
pub const MAX_NATIVE_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_NATIVE_OUTPUT_BYTES: usize = 1024 * 1024;
pub const NATIVE_INPUT_QUEUE_CAPACITY: usize = 4;
pub const VISIBLE_ATTACHMENT_PROTOCOL: &str = "tokenless.visible-attachment.v1";
pub const MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;
const MAX_VISIBLE_ATTACHMENTS: usize = 100;
const MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES: u64 = 512 * 1024 * 1024;

const BRIDGE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const BRIDGE_ERROR_INTERVAL: Duration = Duration::from_secs(1);
const BRIDGE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const CLAIM_RENEW_INTERVAL: Duration = Duration::from_secs(10);
const EVENT_LOOP_INTERVAL: Duration = Duration::from_millis(50);
const HISTORY_LIMIT: usize = 60;
const BRIDGE_MARKER_LOCK_FILE_NAME: &str = ".extension-bridge.lock";
const VISIBLE_ATTACHMENT_DIRECTORY: &str = "attachments";
const VISIBLE_ATTACHMENT_ORPHAN_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_OPEN_ATTACHMENT_HANDLES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMarker {
    pub protocol: String,
    pub session_id: String,
    pub pid: u32,
    pub connected_at: String,
    pub heartbeat_at: String,
}

#[derive(Debug, Clone, Serialize)]
struct CompactJobSummary {
    job_id: String,
    provider: String,
    action: String,
    status: JobStatus,
    created_at: String,
    updated_at: String,
}

impl CompactJobSummary {
    fn from_job(job: &Job) -> Self {
        Self {
            job_id: limited(&job.job_id, 256),
            provider: limited(&job.provider, 64),
            action: limited(&job.action, 128),
            status: job.status,
            created_at: limited(&job.created_at, 64),
            updated_at: limited(&job.updated_at, 64),
        }
    }

    fn from_summary(summary: &JobSummary) -> Self {
        Self {
            job_id: summary.job_id.clone(),
            provider: summary.provider.clone(),
            action: summary.action.clone(),
            status: summary.status,
            created_at: summary.created_at.clone(),
            updated_at: summary.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct HistorySummary {
    #[serde(flatten)]
    job: CompactJobSummary,
    metadata: HistoryMetadata,
}

impl HistorySummary {
    fn from_summary(summary: &JobSummary) -> Self {
        Self {
            job: CompactJobSummary::from_summary(summary),
            metadata: HistoryMetadata {
                task_id: summary.task_id.clone(),
                project_name: summary.project_name.clone(),
                chat_name: summary.chat_name.clone(),
                idempotency_key: summary.idempotency_key.clone(),
            },
        }
    }
}

#[derive(Debug, Clone)]
struct ActiveClaim {
    job_id: String,
    claim_token: String,
    renewal_failed: bool,
    request_json: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VisibleAttachmentDescriptor {
    protocol: String,
    bundle_id: String,
    attachment_id: String,
    name: String,
    #[serde(rename = "type")]
    media_type: String,
    size: u64,
    sha256: String,
}

#[derive(Debug)]
struct AttachmentHandle {
    job_id: String,
    claim_token: String,
    descriptor: VisibleAttachmentDescriptor,
    file: File,
    next_offset: u64,
    digest: Sha256,
    integrity_verified: bool,
}

#[derive(Debug)]
struct BridgeState {
    provider: Option<String>,
    action: Option<String>,
    has_capacity: bool,
    current_claim: Option<ActiveClaim>,
    next_poll: Instant,
    next_heartbeat: Instant,
    next_renewal: Instant,
    _ownership_lock: fs::File,
}

pub struct NativeHost {
    store: JobStore,
    config_store: ConfigStore,
    marker_path: PathBuf,
    session_id: String,
    connected_at: String,
    bridge: Option<BridgeState>,
    attachment_handles: HashMap<String, AttachmentHandle>,
}

impl NativeHost {
    pub fn new(store: JobStore) -> Self {
        let _ = store.active_request_jsons().and_then(|requests| {
            let active_bundle_ids = visible_attachment_bundle_ids(&requests)?;
            cleanup_orphaned_visible_attachment_bundles(
                store.home_dir(),
                VISIBLE_ATTACHMENT_ORPHAN_TTL,
                &active_bundle_ids,
            )
        });
        Self {
            config_store: ConfigStore::new(store.home_dir()),
            marker_path: store.home_dir().join(BRIDGE_MARKER_FILE_NAME),
            store,
            session_id: Uuid::new_v4().to_string(),
            connected_at: timestamp(),
            bridge: None,
            attachment_handles: HashMap::new(),
        }
    }

    pub fn handle_message(&mut self, message: Value) -> Value {
        let request_type = message
            .get("type")
            .and_then(Value::as_str)
            .map(|value| limited(value, 160))
            .unwrap_or_else(|| "tokenless.native.error".to_owned());
        let request_id = message
            .get("requestId")
            .and_then(Value::as_str)
            .map(|value| limited(value, 256));
        match self.validate_and_handle(&message, &request_type) {
            Ok((response_type, result)) => {
                success_response(&response_type, result, request_id.as_deref())
            }
            Err(error) => error_response(&request_type, &error, request_id.as_deref()),
        }
    }

    fn validate_and_handle(
        &mut self,
        message: &Value,
        request_type: &str,
    ) -> Result<(String, Value)> {
        let object = message.as_object().ok_or_else(|| {
            DaemonError::InvalidInput("native message must be a JSON object".to_owned())
        })?;
        if object.get("protocol").and_then(Value::as_str) != Some(NATIVE_PROTOCOL) {
            return Err(DaemonError::InvalidInput(format!(
                "missing or unsupported native protocol; expected {NATIVE_PROTOCOL}"
            )));
        }

        match request_type {
            "tokenless.native.ping" => Ok((
                "tokenless.native.pong".to_owned(),
                json!({
                    "status": "ready",
                    "version": env!("CARGO_PKG_VERSION"),
                }),
            )),
            "tokenless.native.daemon_connect" => {
                let provider = optional_nonempty_string(object, "provider")?;
                let action = optional_nonempty_string(object, "action")?;
                self.connect_bridge(provider, action)?;
                Ok((
                    "tokenless.native.daemon_connected".to_owned(),
                    json!({
                        "status": "connected",
                        "sessionId": self.session_id,
                    }),
                ))
            }
            "tokenless.native.daemon_ready" => {
                let job_id = required_string(object, "jobId")?;
                let claim_token = required_string(object, "claimToken")?;
                self.mark_bridge_ready(&job_id, &claim_token)?;
                Ok((
                    request_type.to_owned(),
                    json!({ "status": "ready", "jobId": job_id }),
                ))
            }
            "tokenless.native.daemon_complete_job" => {
                let job_id = required_string(object, "jobId")?;
                let claim_token = required_string(object, "claimToken")?;
                let completion = match (object.get("result"), object.get("error")) {
                    (Some(result), None) => CompleteJob::Succeeded {
                        result_json: result.clone(),
                    },
                    (None, Some(error)) => CompleteJob::Failed {
                        error_json: error.clone(),
                    },
                    _ => {
                        return Err(DaemonError::InvalidInput(
                            "pass exactly one of result or error".to_owned(),
                        ))
                    }
                };
                let job = self.store.complete_job(&job_id, &claim_token, completion)?;
                self.close_attachment_handles_for_job(&job_id);
                let _ = cleanup_visible_attachment_bundles_for_request(
                    self.store.home_dir(),
                    &job.request_json,
                );
                Ok((
                    request_type.to_owned(),
                    serde_json::to_value(CompactJobSummary::from_job(&job))?,
                ))
            }
            "tokenless.native.attachment_open" => {
                ensure_only_fields(
                    object,
                    &[
                        "protocol",
                        "type",
                        "requestId",
                        "jobId",
                        "claimToken",
                        "bundleId",
                        "attachmentId",
                    ],
                )?;
                self.open_visible_attachment(object)
                    .map(|result| (request_type.to_owned(), result))
            }
            "tokenless.native.attachment_read" => {
                ensure_only_fields(
                    object,
                    &[
                        "protocol",
                        "type",
                        "requestId",
                        "jobId",
                        "claimToken",
                        "handleId",
                        "offset",
                        "maxBytes",
                    ],
                )?;
                self.read_visible_attachment(object)
                    .map(|result| (request_type.to_owned(), result))
            }
            "tokenless.native.attachment_close" => {
                ensure_only_fields(
                    object,
                    &[
                        "protocol",
                        "type",
                        "requestId",
                        "jobId",
                        "claimToken",
                        "handleId",
                    ],
                )?;
                self.close_visible_attachment(object)
                    .map(|result| (request_type.to_owned(), result))
            }
            "tokenless.native.read_config" => Ok((
                request_type.to_owned(),
                serde_json::to_value(self.config_store.read()?)?,
            )),
            "tokenless.native.write_config" => {
                let update = config_update(object)?;
                Ok((
                    request_type.to_owned(),
                    serde_json::to_value(self.config_store.write(update)?)?,
                ))
            }
            "tokenless.native.list_history" => {
                let limit = object
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| usize::try_from(value).unwrap_or(usize::MAX))
                    .unwrap_or(50)
                    .clamp(1, HISTORY_LIMIT);
                let summaries = self
                    .store
                    .list_job_summaries(Some(limit))?
                    .iter()
                    .map(HistorySummary::from_summary)
                    .collect::<Vec<_>>();
                Ok((request_type.to_owned(), serde_json::to_value(summaries)?))
            }
            _ => Err(DaemonError::InvalidInput(format!(
                "unsupported native message type: {request_type}"
            ))),
        }
    }

    fn connect_bridge(&mut self, provider: Option<String>, action: Option<String>) -> Result<()> {
        if self.bridge.is_none() {
            let now = Instant::now();
            let ownership_lock = self.acquire_bridge_ownership()?;
            self.write_marker_unlocked()?;
            self.bridge = Some(BridgeState {
                provider,
                action,
                has_capacity: true,
                current_claim: None,
                next_poll: now,
                next_heartbeat: now + BRIDGE_HEARTBEAT_INTERVAL,
                next_renewal: now + CLAIM_RENEW_INTERVAL,
                _ownership_lock: ownership_lock,
            });
        }
        Ok(())
    }

    fn mark_bridge_ready(&mut self, job_id: &str, claim_token: &str) -> Result<()> {
        let bridge = self.bridge.as_ref().ok_or_else(|| {
            DaemonError::InvalidInput("daemon bridge is not connected".to_owned())
        })?;
        let active = bridge.current_claim.clone().ok_or_else(|| {
            DaemonError::InvalidInput("daemon bridge has no active claim".to_owned())
        })?;
        if active.job_id != job_id
            || !crate::constant_time_eq(active.claim_token.as_bytes(), claim_token.as_bytes())
        {
            return Err(DaemonError::ClaimRejected(job_id.to_owned()));
        }
        let completed = self.store.get_job(job_id)?;
        if !matches!(
            completed.status,
            JobStatus::Succeeded | JobStatus::Failed | JobStatus::Canceled | JobStatus::TimedOut
        ) {
            return Err(DaemonError::InvalidInput(
                "daemon bridge cannot release a claim before the job is terminal".to_owned(),
            ));
        }
        self.close_attachment_handles_for_job(job_id);
        let _ = cleanup_visible_attachment_bundles_for_request(
            self.store.home_dir(),
            &active.request_json,
        );
        let bridge = self.bridge.as_mut().ok_or_else(|| {
            DaemonError::InvalidInput("daemon bridge is not connected".to_owned())
        })?;
        bridge.current_claim = None;
        bridge.has_capacity = true;
        bridge.next_poll = Instant::now();
        Ok(())
    }

    fn require_active_attachment_claim(
        &mut self,
        object: &Map<String, Value>,
    ) -> Result<ActiveClaim> {
        let job_id = required_string(object, "jobId")?;
        let claim_token = required_string(object, "claimToken")?;
        let active = self
            .bridge
            .as_ref()
            .ok_or_else(|| {
                DaemonError::InvalidInput("visible attachment bridge is not connected".to_owned())
            })?
            .current_claim
            .clone()
            .ok_or_else(|| {
                DaemonError::InvalidInput(
                    "visible attachment bridge has no active claim".to_owned(),
                )
            })?;
        if active.job_id != job_id
            || !crate::constant_time_eq(active.claim_token.as_bytes(), claim_token.as_bytes())
        {
            return Err(DaemonError::ClaimRejected(job_id));
        }
        if active.renewal_failed {
            return Err(DaemonError::ClaimExpired(active.job_id));
        }
        self.store
            .renew_claim(&active.job_id, &active.claim_token)?;
        if let Some(bridge) = self.bridge.as_mut() {
            bridge.next_renewal = Instant::now() + CLAIM_RENEW_INTERVAL;
        }
        Ok(active)
    }

    fn open_visible_attachment(&mut self, object: &Map<String, Value>) -> Result<Value> {
        let active = self.require_active_attachment_claim(object)?;
        let bundle_id = required_safe_attachment_id(object, "bundleId")?;
        let attachment_id = required_safe_attachment_id(object, "attachmentId")?;
        let descriptor = visible_attachment_descriptors(&active.request_json)?
            .into_iter()
            .find(|descriptor| {
                descriptor.bundle_id == bundle_id && descriptor.attachment_id == attachment_id
            })
            .ok_or_else(|| {
                DaemonError::InvalidInput(
                    "visible attachment is not declared by the active job".to_owned(),
                )
            })?;
        if self.attachment_handles.len() >= MAX_OPEN_ATTACHMENT_HANDLES {
            return Err(DaemonError::InvalidInput(format!(
                "visible attachment handle limit is {MAX_OPEN_ATTACHMENT_HANDLES}"
            )));
        }
        if self.attachment_handles.values().any(|handle| {
            handle.job_id == active.job_id
                && handle.descriptor.bundle_id == descriptor.bundle_id
                && handle.descriptor.attachment_id == descriptor.attachment_id
        }) {
            return Err(DaemonError::InvalidInput(
                "visible attachment is already open for the active job".to_owned(),
            ));
        }
        let file = open_staged_visible_attachment(self.store.home_dir(), &descriptor)?;
        let handle_id = Uuid::new_v4().to_string();
        self.attachment_handles.insert(
            handle_id.clone(),
            AttachmentHandle {
                job_id: active.job_id,
                claim_token: active.claim_token,
                descriptor: descriptor.clone(),
                file,
                next_offset: 0,
                digest: Sha256::new(),
                integrity_verified: false,
            },
        );
        Ok(json!({
            "handleId": handle_id,
            "protocol": VISIBLE_ATTACHMENT_PROTOCOL,
            "bundleId": descriptor.bundle_id,
            "attachmentId": descriptor.attachment_id,
            "name": descriptor.name,
            "type": descriptor.media_type,
            "size": descriptor.size,
            "sha256": descriptor.sha256,
            "maxChunkBytes": MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES,
        }))
    }

    fn read_visible_attachment(&mut self, object: &Map<String, Value>) -> Result<Value> {
        let active = self.require_active_attachment_claim(object)?;
        let handle_id = required_string(object, "handleId")?;
        if !safe_attachment_id(&handle_id) {
            return Err(DaemonError::InvalidInput(
                "visible attachment handleId is invalid".to_owned(),
            ));
        }
        let offset = required_u64(object, "offset")?;
        let max_bytes = required_u64(object, "maxBytes")?;
        if max_bytes == 0 || max_bytes > MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES as u64 {
            return Err(DaemonError::InvalidInput(format!(
                "visible attachment maxBytes must be between 1 and {MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES}"
            )));
        }
        let handle = self.attachment_handles.get_mut(&handle_id).ok_or_else(|| {
            DaemonError::InvalidInput("visible attachment handle does not exist".to_owned())
        })?;
        if handle.job_id != active.job_id
            || !crate::constant_time_eq(
                handle.claim_token.as_bytes(),
                active.claim_token.as_bytes(),
            )
        {
            return Err(DaemonError::ClaimRejected(active.job_id));
        }
        if offset != handle.next_offset {
            return Err(DaemonError::InvalidInput(format!(
                "visible attachment reads must be sequential; expected offset {}",
                handle.next_offset
            )));
        }
        if handle.file.metadata()?.len() != handle.descriptor.size {
            return Err(DaemonError::InvalidInput(
                "visible attachment size changed after opening".to_owned(),
            ));
        }
        let remaining = handle.descriptor.size.saturating_sub(handle.next_offset);
        let read_bytes = remaining.min(max_bytes) as usize;
        let mut bytes = vec![0_u8; read_bytes];
        if read_bytes > 0 {
            handle.file.read_exact(&mut bytes)?;
            handle.digest.update(&bytes);
            handle.next_offset = handle
                .next_offset
                .checked_add(read_bytes as u64)
                .ok_or_else(|| {
                    DaemonError::InvalidInput("visible attachment offset overflowed".to_owned())
                })?;
        }
        let eof = handle.next_offset == handle.descriptor.size;
        if eof {
            let actual_sha256 = hex_lower(&handle.digest.clone().finalize());
            if !crate::constant_time_eq(
                actual_sha256.as_bytes(),
                handle.descriptor.sha256.as_bytes(),
            ) {
                return Err(DaemonError::InvalidInput(
                    "visible attachment SHA-256 integrity check failed".to_owned(),
                ));
            }
        }
        let result = json!({
            "handleId": handle_id,
            "offset": offset,
            "nextOffset": handle.next_offset,
            "eof": eof,
            "dataBase64": STANDARD.encode(bytes),
        });
        if encoded_message_size(&success_response(
            "tokenless.native.attachment_read",
            result.clone(),
            None,
        ))? > MAX_NATIVE_OUTPUT_BYTES
        {
            return Err(DaemonError::InvalidInput(
                "visible attachment chunk exceeded the native output frame".to_owned(),
            ));
        }
        if eof {
            handle.integrity_verified = true;
        }
        Ok(result)
    }

    fn close_visible_attachment(&mut self, object: &Map<String, Value>) -> Result<Value> {
        let active = self.require_active_attachment_claim(object)?;
        let handle_id = required_string(object, "handleId")?;
        let handle = self.attachment_handles.get(&handle_id).ok_or_else(|| {
            DaemonError::InvalidInput("visible attachment handle does not exist".to_owned())
        })?;
        if handle.job_id != active.job_id
            || !crate::constant_time_eq(
                handle.claim_token.as_bytes(),
                active.claim_token.as_bytes(),
            )
        {
            return Err(DaemonError::ClaimRejected(active.job_id));
        }
        if handle.next_offset != handle.descriptor.size || !handle.integrity_verified {
            return Err(DaemonError::InvalidInput(
                "visible attachment cannot close before a complete, integrity-verified read"
                    .to_owned(),
            ));
        }
        self.attachment_handles.remove(&handle_id);
        Ok(json!({ "handleId": handle_id, "status": "closed" }))
    }

    fn close_attachment_handles_for_job(&mut self, job_id: &str) {
        self.attachment_handles
            .retain(|_, handle| handle.job_id != job_id);
    }

    fn tick(&mut self) -> Result<Vec<Value>> {
        let mut messages = Vec::new();
        let now = Instant::now();
        let Some(bridge) = self.bridge.as_ref() else {
            return Ok(messages);
        };
        let heartbeat_due = now >= bridge.next_heartbeat;
        let renewal_due = now >= bridge.next_renewal;
        let poll_due = now >= bridge.next_poll && bridge.has_capacity;

        if heartbeat_due {
            if let Some(bridge) = self.bridge.as_mut() {
                bridge.next_heartbeat = now + BRIDGE_HEARTBEAT_INTERVAL;
            }
            if !self.heartbeat_marker()? {
                self.bridge = None;
                return Ok(vec![bridge_error_push(
                    "bridge_superseded",
                    "A newer extension bridge session replaced this native host.",
                    false,
                )]);
            }
        }

        if renewal_due {
            let active = self
                .bridge
                .as_ref()
                .and_then(|bridge| bridge.current_claim.clone());
            if let Some(active) = active.filter(|claim| !claim.renewal_failed) {
                match self.store.renew_claim(&active.job_id, &active.claim_token) {
                    Ok(_) => {}
                    Err(DaemonError::InvalidJobState { .. }) => {
                        // Completion can happen through a separate short-lived native host.
                    }
                    Err(error) => {
                        if let Some(claim) = self
                            .bridge
                            .as_mut()
                            .and_then(|bridge| bridge.current_claim.as_mut())
                        {
                            claim.renewal_failed = true;
                        }
                        messages.push(error_push(&error));
                    }
                }
            }
            if let Some(bridge) = self.bridge.as_mut() {
                bridge.next_renewal = now + CLAIM_RENEW_INTERVAL;
            }
        }

        if poll_due {
            match self.poll_bridge_now() {
                Ok(Some(message)) => messages.push(message),
                Ok(None) => {}
                Err(error) => {
                    if let Some(bridge) = self.bridge.as_mut() {
                        bridge.next_poll = now + BRIDGE_ERROR_INTERVAL;
                    }
                    messages.push(error_push(&error));
                }
            }
        }
        Ok(messages)
    }

    fn poll_bridge_now(&mut self) -> Result<Option<Value>> {
        let Some(bridge) = self.bridge.as_ref() else {
            return Ok(None);
        };
        if !bridge.has_capacity {
            return Ok(None);
        }
        let query = ClaimNextJob {
            provider: bridge.provider.clone(),
            action: bridge.action.clone(),
        };
        let Some(claimed) = self.store.claim_next_job(query)? else {
            if let Some(bridge) = self.bridge.as_mut() {
                bridge.next_poll = Instant::now() + BRIDGE_POLL_INTERVAL;
            }
            return Ok(None);
        };
        let running = self
            .store
            .mark_running(&claimed.job_id, &claimed.claim_token)?;
        let push = success_response(
            "tokenless.native.daemon_job",
            json!({ "job": running.with_claim_token() }),
            None,
        );
        let encoded_size = encoded_message_size(&push)?;
        if encoded_size > MAX_NATIVE_OUTPUT_BYTES {
            self.store.complete_job(
                &running.job_id,
                &running.claim_token,
                CompleteJob::Failed {
                    error_json: json!({
                        "code": "native_message_too_large",
                        "message": "Claimed job exceeds the Chrome Native Messaging output limit.",
                        "retryable": false,
                        "maxBytes": MAX_NATIVE_OUTPUT_BYTES,
                        "actualBytes": encoded_size,
                    }),
                },
            )?;
            if let Some(bridge) = self.bridge.as_mut() {
                bridge.has_capacity = true;
                bridge.current_claim = None;
                bridge.next_poll = Instant::now();
            }
            return Ok(Some(bridge_error_push(
                "native_message_too_large",
                "A daemon job was failed because its native message exceeded 1 MiB.",
                false,
            )));
        }

        if let Some(bridge) = self.bridge.as_mut() {
            bridge.has_capacity = false;
            bridge.current_claim = Some(ActiveClaim {
                job_id: running.job_id.clone(),
                claim_token: running.claim_token.clone(),
                renewal_failed: false,
                request_json: running.request_json.clone(),
            });
            bridge.next_renewal = Instant::now() + CLAIM_RENEW_INTERVAL;
        }
        Ok(Some(push))
    }

    fn write_marker_unlocked(&self) -> Result<()> {
        let now = timestamp();
        write_json_atomic_secure(
            &self.marker_path,
            &BridgeMarker {
                protocol: BRIDGE_MARKER_PROTOCOL.to_owned(),
                session_id: self.session_id.clone(),
                pid: std::process::id(),
                connected_at: self.connected_at.clone(),
                heartbeat_at: now,
            },
        )
    }

    fn marker_belongs_to_session_unlocked(&self) -> Result<bool> {
        let bytes = match fs::read(&self.marker_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let marker: BridgeMarker = serde_json::from_slice(&bytes)?;
        Ok(marker.protocol == BRIDGE_MARKER_PROTOCOL && marker.session_id == self.session_id)
    }

    fn heartbeat_marker(&self) -> Result<bool> {
        if !self.marker_belongs_to_session_unlocked()? {
            return Ok(false);
        }
        self.write_marker_unlocked()?;
        Ok(true)
    }

    fn acquire_bridge_ownership(&self) -> Result<fs::File> {
        let lock_path = self.store.home_dir().join(BRIDGE_MARKER_LOCK_FILE_NAME);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        open_secure_file(&mut options);
        let lock = options.open(&lock_path)?;
        crate::restrict_file_permissions(&lock_path)?;
        match lock.try_lock_exclusive() {
            Ok(()) => Ok(lock),
            Err(error) if error.kind() == ErrorKind::WouldBlock => Err(DaemonError::BridgeBusy),
            Err(error) => Err(error.into()),
        }
    }

    pub fn disconnect(&mut self) -> Result<()> {
        let Some(bridge) = self.bridge.take() else {
            return Ok(());
        };
        if self.marker_belongs_to_session_unlocked()? {
            match fs::remove_file(&self.marker_path) {
                Ok(()) => sync_parent(self.store.home_dir())?,
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        drop(bridge);
        Ok(())
    }
}

impl Drop for NativeHost {
    fn drop(&mut self) {
        let _ = self.disconnect();
    }
}

enum InputEvent {
    Message(Value),
    End,
    Error(DaemonError),
}

pub fn run_native_host<R, W>(store: JobStore, mut reader: R, mut writer: W) -> Result<()>
where
    R: Read + Send + 'static,
    W: Write,
{
    let (sender, receiver) = mpsc::sync_channel(NATIVE_INPUT_QUEUE_CAPACITY);
    thread::spawn(move || loop {
        match read_native_message(&mut reader) {
            Ok(Some(message)) => {
                if sender.send(InputEvent::Message(message)).is_err() {
                    break;
                }
            }
            Ok(None) => {
                let _ = sender.send(InputEvent::End);
                break;
            }
            Err(error) => {
                let _ = sender.send(InputEvent::Error(error));
                break;
            }
        }
    });

    let mut host = NativeHost::new(store);
    loop {
        match receiver.recv_timeout(EVENT_LOOP_INTERVAL) {
            Ok(InputEvent::Message(message)) => {
                let response = host.handle_message(message);
                write_with_fallback(&mut writer, &response)?;
            }
            Ok(InputEvent::End) | Err(RecvTimeoutError::Disconnected) => {
                host.disconnect()?;
                return Ok(());
            }
            Ok(InputEvent::Error(error)) => {
                let response = error_response("tokenless.native.error", &error, None);
                write_with_fallback(&mut writer, &response)?;
                host.disconnect()?;
                return Ok(());
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        match host.tick() {
            Ok(messages) => {
                for message in messages {
                    write_with_fallback(&mut writer, &message)?;
                }
            }
            Err(error) => write_with_fallback(&mut writer, &error_push(&error))?,
        }
    }
}

pub fn run_native_host_stdio(store: JobStore) -> Result<()> {
    run_native_host(store, std::io::stdin(), std::io::stdout())
}

pub fn read_native_message(reader: &mut impl Read) -> Result<Option<Value>> {
    let mut header = [0_u8; 4];
    let mut header_bytes = 0;
    while header_bytes < header.len() {
        match reader.read(&mut header[header_bytes..]) {
            Ok(0) if header_bytes == 0 => return Ok(None),
            Ok(0) => {
                return Err(std::io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "native message ended during length header",
                )
                .into())
            }
            Ok(read) => header_bytes += read,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_NATIVE_INPUT_BYTES {
        return Err(DaemonError::InvalidInput(format!(
            "native input frame exceeds {MAX_NATIVE_INPUT_BYTES} bytes"
        )));
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

pub fn write_native_message(writer: &mut impl Write, message: &Value) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    if body.len() > MAX_NATIVE_OUTPUT_BYTES {
        return Err(DaemonError::InvalidInput(format!(
            "native output frame exceeds {MAX_NATIVE_OUTPUT_BYTES} bytes"
        )));
    }
    let length = u32::try_from(body.len()).map_err(|_| {
        DaemonError::InvalidInput("native output frame length exceeds u32".to_owned())
    })?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}

pub fn resolve_native_host_home(
    tokenless_home: Option<OsString>,
    executable: &Path,
) -> Result<PathBuf> {
    if let Some(home) = tokenless_home.filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home));
    }
    let bin_dir = executable.parent().ok_or_else(|| {
        DaemonError::InvalidInput(format!(
            "cannot infer Tokenless home from {}",
            executable.display()
        ))
    })?;
    if !bin_dir
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("bin"))
    {
        return Err(DaemonError::InvalidInput(format!(
            "native host executable must be installed under <home>/bin: {}",
            executable.display()
        )));
    }
    bin_dir.parent().map(Path::to_path_buf).ok_or_else(|| {
        DaemonError::InvalidInput(format!(
            "cannot infer Tokenless home from {}",
            executable.display()
        ))
    })
}

pub fn resolve_native_host_home_from_environment() -> Result<PathBuf> {
    resolve_native_host_home(env::var_os("TOKENLESS_HOME"), &env::current_exe()?)
}

fn visible_attachment_descriptors(request: &Value) -> Result<Vec<VisibleAttachmentDescriptor>> {
    let Some(attachments) = request.get("attachments") else {
        return Ok(Vec::new());
    };
    let values = attachments.as_array().ok_or_else(|| {
        DaemonError::InvalidInput("visible attachment descriptors must be an array".to_owned())
    })?;
    if values.is_empty() || values.len() > MAX_VISIBLE_ATTACHMENTS {
        return Err(DaemonError::InvalidInput(format!(
            "visible attachment requests must contain between 1 and {MAX_VISIBLE_ATTACHMENTS} files"
        )));
    }
    let mut descriptors = Vec::with_capacity(values.len());
    let mut attachment_ids = HashSet::new();
    let mut bundle_id: Option<String> = None;
    let mut total_bytes = 0_u64;
    for value in values {
        let descriptor: VisibleAttachmentDescriptor = serde_json::from_value(value.clone())
            .map_err(|_| {
                DaemonError::InvalidInput(
                    "visible attachment descriptor has invalid or unknown fields".to_owned(),
                )
            })?;
        validate_visible_attachment_descriptor(&descriptor)?;
        if bundle_id
            .as_ref()
            .is_some_and(|expected| expected != &descriptor.bundle_id)
        {
            return Err(DaemonError::InvalidInput(
                "visible attachments in one request must share one bundle identifier".to_owned(),
            ));
        }
        bundle_id.get_or_insert_with(|| descriptor.bundle_id.clone());
        if !attachment_ids.insert(descriptor.attachment_id.clone()) {
            return Err(DaemonError::InvalidInput(
                "visible attachment descriptor identity is duplicated".to_owned(),
            ));
        }
        if descriptor.size > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES {
            return Err(DaemonError::InvalidInput(format!(
                "visible attachment size exceeds {MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES} bytes"
            )));
        }
        total_bytes = total_bytes.checked_add(descriptor.size).ok_or_else(|| {
            DaemonError::InvalidInput("visible attachment aggregate size overflowed".to_owned())
        })?;
        if total_bytes > MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES {
            return Err(DaemonError::InvalidInput(format!(
                "visible attachment aggregate size exceeds {MAX_VISIBLE_ATTACHMENT_REQUEST_BYTES} bytes"
            )));
        }
        descriptors.push(descriptor);
    }
    Ok(descriptors)
}

fn validate_visible_attachment_descriptor(descriptor: &VisibleAttachmentDescriptor) -> Result<()> {
    if descriptor.protocol != VISIBLE_ATTACHMENT_PROTOCOL {
        return Err(DaemonError::InvalidInput(format!(
            "visible attachment protocol must be {VISIBLE_ATTACHMENT_PROTOCOL}"
        )));
    }
    if !safe_attachment_id(&descriptor.bundle_id) || !safe_attachment_id(&descriptor.attachment_id)
    {
        return Err(DaemonError::InvalidInput(
            "visible attachment descriptor contains an unsafe identifier".to_owned(),
        ));
    }
    if descriptor.name.is_empty()
        || descriptor.name.as_bytes().len() > 512
        || descriptor.name.contains('\0')
        || descriptor.name.contains('/')
        || descriptor.name.contains('\\')
    {
        return Err(DaemonError::InvalidInput(
            "visible attachment descriptor contains an unsafe name".to_owned(),
        ));
    }
    if !safe_media_type(&descriptor.media_type) {
        return Err(DaemonError::InvalidInput(
            "visible attachment descriptor contains an invalid media type".to_owned(),
        ));
    }
    if descriptor.size > 9_007_199_254_740_991 {
        return Err(DaemonError::InvalidInput(
            "visible attachment descriptor size exceeds a safe integer".to_owned(),
        ));
    }
    if descriptor.sha256.len() != 64
        || !descriptor
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(DaemonError::InvalidInput(
            "visible attachment descriptor contains an invalid SHA-256".to_owned(),
        ));
    }
    Ok(())
}

fn safe_media_type(value: &str) -> bool {
    if value.is_empty() || value.len() > 255 || !value.is_ascii() {
        return false;
    }
    let mut parts = value.split('/');
    let Some(primary) = parts.next() else {
        return false;
    };
    let Some(subtype) = parts.next() else {
        return false;
    };
    if parts.next().is_some() || primary.is_empty() || subtype.is_empty() {
        return false;
    }
    primary
        .bytes()
        .chain(subtype.bytes())
        .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
}

fn safe_attachment_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn required_safe_attachment_id(object: &Map<String, Value>, field: &'static str) -> Result<String> {
    let value = required_string(object, field)?;
    if !safe_attachment_id(&value) {
        return Err(DaemonError::InvalidInput(format!(
            "visible attachment {field} contains unsafe characters"
        )));
    }
    Ok(value)
}

fn required_u64(object: &Map<String, Value>, field: &'static str) -> Result<u64> {
    object.get(field).and_then(Value::as_u64).ok_or_else(|| {
        DaemonError::InvalidInput(format!(
            "visible attachment {field} must be a nonnegative integer"
        ))
    })
}

fn ensure_only_fields(object: &Map<String, Value>, allowed: &[&str]) -> Result<()> {
    for field in object.keys() {
        if !allowed.contains(&field.as_str()) {
            return Err(DaemonError::InvalidInput(format!(
                "unsupported native message field: {field}"
            )));
        }
    }
    Ok(())
}

fn open_staged_visible_attachment(
    home_dir: &Path,
    descriptor: &VisibleAttachmentDescriptor,
) -> Result<File> {
    validate_visible_attachment_descriptor(descriptor)?;
    let expected_root = home_dir.join(VISIBLE_ATTACHMENT_DIRECTORY);
    require_regular_non_symlink_directory(&expected_root, "visible attachment root")?;
    let root = fs::canonicalize(&expected_root)?;
    if root != expected_root || !root.starts_with(home_dir) {
        return Err(DaemonError::InvalidInput(
            "visible attachment root escaped Tokenless home".to_owned(),
        ));
    }
    let expected_bundle = root.join(&descriptor.bundle_id);
    require_regular_non_symlink_directory(&expected_bundle, "visible attachment bundle")?;
    let bundle = fs::canonicalize(&expected_bundle)?;
    if bundle != expected_bundle || !bundle.starts_with(&root) {
        return Err(DaemonError::InvalidInput(
            "visible attachment bundle escaped its staging root".to_owned(),
        ));
    }
    let expected_file = bundle.join(format!("{}.bin", descriptor.attachment_id));
    let before = fs::symlink_metadata(&expected_file)?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(DaemonError::InvalidInput(
            "visible attachment staging entry must be a regular non-symlink file".to_owned(),
        ));
    }
    let canonical_file = fs::canonicalize(&expected_file)?;
    if canonical_file != expected_file || !canonical_file.starts_with(&bundle) {
        return Err(DaemonError::InvalidInput(
            "visible attachment staging entry escaped its bundle".to_owned(),
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    open_attachment_file_without_following(&mut options);
    let file = options.open(&canonical_file)?;
    let opened = file.metadata()?;
    let after = fs::symlink_metadata(&expected_file)?;
    if after.file_type().is_symlink()
        || !after.is_file()
        || opened.len() != descriptor.size
        || after.len() != descriptor.size
        || !same_opened_file_identity(&opened, &before)
        || !same_opened_file_identity(&opened, &after)
    {
        return Err(DaemonError::InvalidInput(
            "visible attachment staging entry changed while opening".to_owned(),
        ));
    }
    Ok(file)
}

fn require_regular_non_symlink_directory(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DaemonError::InvalidInput(format!(
            "{label} must be a regular non-symlink directory"
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn open_attachment_file_without_following(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn open_attachment_file_without_following(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn open_attachment_file_without_following(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn same_opened_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_opened_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
}

pub(crate) fn cleanup_visible_attachment_bundles_for_request(
    home_dir: &Path,
    request: &Value,
) -> Result<usize> {
    let bundles = visible_attachment_descriptors(request)?
        .into_iter()
        .map(|descriptor| descriptor.bundle_id)
        .collect::<HashSet<_>>();
    let mut removed = 0;
    for bundle_id in bundles {
        if remove_visible_attachment_bundle(home_dir, &bundle_id)? {
            removed += 1;
        }
    }
    Ok(removed)
}

fn visible_attachment_bundle_ids(requests: &[Value]) -> Result<HashSet<String>> {
    let mut bundle_ids = HashSet::new();
    for request in requests {
        bundle_ids.extend(
            visible_attachment_descriptors(request)?
                .into_iter()
                .map(|descriptor| descriptor.bundle_id),
        );
    }
    Ok(bundle_ids)
}

fn cleanup_orphaned_visible_attachment_bundles(
    home_dir: &Path,
    ttl: Duration,
    active_bundle_ids: &HashSet<String>,
) -> Result<usize> {
    let expected_root = home_dir.join(VISIBLE_ATTACHMENT_DIRECTORY);
    let root_metadata = match fs::symlink_metadata(&expected_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(DaemonError::InvalidInput(
            "visible attachment root must be a regular non-symlink directory".to_owned(),
        ));
    }
    let root = fs::canonicalize(&expected_root)?;
    if root != expected_root || !root.starts_with(home_dir) {
        return Err(DaemonError::InvalidInput(
            "visible attachment root escaped Tokenless home".to_owned(),
        ));
    }
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(bundle_id) = name.to_str() else {
            continue;
        };
        if !safe_attachment_id(bundle_id) || active_bundle_ids.contains(bundle_id) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let expired = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= ttl);
        if expired && remove_visible_attachment_bundle(home_dir, bundle_id)? {
            removed += 1;
        }
    }
    Ok(removed)
}

fn remove_visible_attachment_bundle(home_dir: &Path, bundle_id: &str) -> Result<bool> {
    if !safe_attachment_id(bundle_id) {
        return Err(DaemonError::InvalidInput(
            "visible attachment bundle identifier is unsafe".to_owned(),
        ));
    }
    let expected_root = home_dir.join(VISIBLE_ATTACHMENT_DIRECTORY);
    let root = match fs::canonicalize(&expected_root) {
        Ok(root) => root,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if root != expected_root || !root.starts_with(home_dir) {
        return Err(DaemonError::InvalidInput(
            "visible attachment root escaped Tokenless home".to_owned(),
        ));
    }
    let expected_bundle = root.join(bundle_id);
    let metadata = match fs::symlink_metadata(&expected_bundle) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(DaemonError::InvalidInput(
            "refusing to remove an unsafe visible attachment bundle".to_owned(),
        ));
    }
    let bundle = fs::canonicalize(&expected_bundle)?;
    if bundle != expected_bundle || !bundle.starts_with(&root) {
        return Err(DaemonError::InvalidInput(
            "visible attachment bundle escaped its staging root".to_owned(),
        ));
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&bundle)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(DaemonError::InvalidInput(
                "visible attachment bundle contains an invalid entry".to_owned(),
            ));
        };
        let Some(attachment_id) = name.strip_suffix(".bin") else {
            return Err(DaemonError::InvalidInput(
                "visible attachment bundle contains an unexpected entry".to_owned(),
            ));
        };
        if !safe_attachment_id(attachment_id) {
            return Err(DaemonError::InvalidInput(
                "visible attachment bundle contains an unsafe entry".to_owned(),
            ));
        }
        let entry_metadata = fs::symlink_metadata(entry.path())?;
        if entry_metadata.is_dir() {
            return Err(DaemonError::InvalidInput(
                "visible attachment bundle contains a nested directory".to_owned(),
            ));
        }
        entries.push(entry.path());
    }
    for entry in entries {
        fs::remove_file(entry)?;
    }
    fs::remove_dir(bundle)?;
    Ok(true)
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn config_update(object: &Map<String, Value>) -> Result<ConfigUpdate> {
    let preferred_providers = match object.get("preferredProviders") {
        None => None,
        Some(Value::Array(values)) => Some(
            values
                .iter()
                .map(|value| {
                    value.as_str().map(str::to_owned).ok_or_else(|| {
                        DaemonError::InvalidInput(
                            "preferredProviders must contain only strings".to_owned(),
                        )
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        ),
        Some(_) => {
            return Err(DaemonError::InvalidInput(
                "preferredProviders must be an array".to_owned(),
            ))
        }
    };
    Ok(ConfigUpdate {
        preferred_providers,
        browser: optional_nullable_string(object, "browser")?,
        daemon_url: optional_nullable_string(object, "daemonUrl")?,
    })
}

fn optional_nullable_string(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<Option<String>>> {
    match object.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(value)) => Ok(Some(Some(value.clone()))),
        Some(_) => Err(DaemonError::InvalidInput(format!(
            "{field} must be a string or null"
        ))),
    }
}

fn optional_nonempty_string(
    object: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<String>> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.trim().to_owned())),
        _ => Err(DaemonError::InvalidInput(format!(
            "{field} must be a nonempty string"
        ))),
    }
}

fn required_string(object: &Map<String, Value>, field: &'static str) -> Result<String> {
    match object.get(field) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value.clone()),
        _ => Err(DaemonError::InvalidInput(format!(
            "{field} must be a nonempty string"
        ))),
    }
}

fn success_response(response_type: &str, result: Value, request_id: Option<&str>) -> Value {
    let mut response = json!({
        "protocol": NATIVE_PROTOCOL,
        "type": response_type,
        "ok": true,
        "result": result,
    });
    if let (Some(request_id), Some(object)) = (request_id, response.as_object_mut()) {
        object.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
    }
    response
}

fn error_response(request_type: &str, error: &DaemonError, request_id: Option<&str>) -> Value {
    let (code, retryable) = error_code(error);
    let mut response = json!({
        "protocol": NATIVE_PROTOCOL,
        "type": request_type,
        "ok": false,
        "error": {
            "code": code,
            "message": limited(&error.to_string(), 1024),
            "retryable": retryable,
        },
    });
    if let (Some(request_id), Some(object)) = (request_id, response.as_object_mut()) {
        object.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
    }
    response
}

fn error_push(error: &DaemonError) -> Value {
    let (code, retryable) = error_code(error);
    bridge_error_push(code, &limited(&error.to_string(), 1024), retryable)
}

fn bridge_error_push(code: &str, message: &str, retryable: bool) -> Value {
    json!({
        "protocol": NATIVE_PROTOCOL,
        "type": "tokenless.native.daemon_error",
        "ok": false,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        },
    })
}

fn error_code(error: &DaemonError) -> (&'static str, bool) {
    match error {
        DaemonError::InvalidInput(message) if message.contains("protocol") => {
            ("unsupported_native_protocol", false)
        }
        DaemonError::InvalidInput(message) if message.contains("frame exceeds") => {
            ("native_message_too_large", false)
        }
        DaemonError::InvalidInput(_) | DaemonError::Json(_) => ("invalid_native_message", false),
        DaemonError::ClaimExpired(_) => ("claim_expired", false),
        DaemonError::ClaimRejected(_) => ("claim_rejected", false),
        DaemonError::BridgeBusy => ("bridge_busy", true),
        DaemonError::JobNotFound(_) => ("job_not_found", false),
        DaemonError::InvalidJobState { .. } => ("invalid_job_state", false),
        DaemonError::Sqlite(_) => ("native_store_error", true),
        DaemonError::Io(_) => ("native_io_error", true),
        _ => ("native_host_error", false),
    }
}

fn write_with_fallback(writer: &mut impl Write, message: &Value) -> Result<()> {
    match write_native_message(writer, message) {
        Ok(()) => Ok(()),
        Err(DaemonError::InvalidInput(_)) => write_native_message(
            writer,
            &bridge_error_push(
                "native_message_too_large",
                "Native host response exceeded the Chrome output limit.",
                false,
            ),
        ),
        Err(error) => Err(error),
    }
}

fn encoded_message_size(message: &Value) -> Result<usize> {
    Ok(serde_json::to_vec(message)?.len())
}

fn limited(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let limited = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{limited}…")
    } else {
        limited
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(unix)]
fn open_secure_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn open_secure_file(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<()> {
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompleteJob, CreateJob};
    use std::io::Cursor;

    const TEST_ATTACHMENT_BUNDLE_ID: &str = "bundle-one";
    const TEST_ATTACHMENT_ID: &str = "attachment-one";

    struct ActiveAttachmentTest {
        _tempdir: tempfile::TempDir,
        store: JobStore,
        host: NativeHost,
        job_id: String,
        claim_token: String,
        bundle_path: PathBuf,
    }

    impl ActiveAttachmentTest {
        fn open(&mut self) -> Value {
            let job_id = self.job_id.clone();
            let claim_token = self.claim_token.clone();
            self.host.handle_message(json!({
                "protocol": NATIVE_PROTOCOL,
                "type": "tokenless.native.attachment_open",
                "jobId": job_id,
                "claimToken": claim_token,
                "bundleId": TEST_ATTACHMENT_BUNDLE_ID,
                "attachmentId": TEST_ATTACHMENT_ID,
            }))
        }

        fn read(&mut self, handle_id: &str, offset: u64, max_bytes: u64) -> Value {
            let job_id = self.job_id.clone();
            let claim_token = self.claim_token.clone();
            self.host.handle_message(json!({
                "protocol": NATIVE_PROTOCOL,
                "type": "tokenless.native.attachment_read",
                "jobId": job_id,
                "claimToken": claim_token,
                "handleId": handle_id,
                "offset": offset,
                "maxBytes": max_bytes,
            }))
        }

        fn close(&mut self, handle_id: &str) -> Value {
            let job_id = self.job_id.clone();
            let claim_token = self.claim_token.clone();
            self.host.handle_message(json!({
                "protocol": NATIVE_PROTOCOL,
                "type": "tokenless.native.attachment_close",
                "jobId": job_id,
                "claimToken": claim_token,
                "handleId": handle_id,
            }))
        }

        fn complete(&mut self, completion: CompleteJob) -> Value {
            let job_id = self.job_id.clone();
            let claim_token = self.claim_token.clone();
            let mut message = json!({
                "protocol": NATIVE_PROTOCOL,
                "type": "tokenless.native.daemon_complete_job",
                "jobId": job_id,
                "claimToken": claim_token,
            });
            let object = message.as_object_mut().unwrap();
            match completion {
                CompleteJob::Succeeded { result_json } => {
                    object.insert("result".to_owned(), result_json);
                }
                CompleteJob::Failed { error_json } => {
                    object.insert("error".to_owned(), error_json);
                }
            }
            self.host.handle_message(message)
        }
    }

    fn active_attachment_test(bytes: &[u8], declared_sha256: Option<&str>) -> ActiveAttachmentTest {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let bundle_path = store
            .home_dir()
            .join(VISIBLE_ATTACHMENT_DIRECTORY)
            .join(TEST_ATTACHMENT_BUNDLE_ID);
        fs::create_dir_all(&bundle_path).unwrap();
        fs::write(bundle_path.join(format!("{TEST_ATTACHMENT_ID}.bin")), bytes).unwrap();
        let sha256 = declared_sha256
            .map(str::to_owned)
            .unwrap_or_else(|| hex_lower(&Sha256::digest(bytes)));
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({
                    "prompt": "attach this",
                    "attachments": [{
                        "protocol": VISIBLE_ATTACHMENT_PROTOCOL,
                        "bundleId": TEST_ATTACHMENT_BUNDLE_ID,
                        "attachmentId": TEST_ATTACHMENT_ID,
                        "name": "evidence.txt",
                        "type": "text/plain",
                        "size": bytes.len(),
                        "sha256": sha256,
                    }],
                }),
            ))
            .unwrap();
        let mut host = NativeHost::new(store.clone());
        host.connect_bridge(None, None).unwrap();
        let push = host.poll_bridge_now().unwrap().unwrap();
        assert_eq!(push["result"]["job"]["job_id"], job.job_id);
        let claim_token = push["result"]["job"]["claim_token"]
            .as_str()
            .unwrap()
            .to_owned();

        ActiveAttachmentTest {
            _tempdir: tempdir,
            store,
            host,
            job_id: job.job_id,
            claim_token,
            bundle_path,
        }
    }

    fn assert_native_error_contains(response: &Value, code: &str, message: &str) {
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], code);
        assert!(
            response["error"]["message"]
                .as_str()
                .unwrap()
                .contains(message),
            "unexpected native error: {response}"
        );
    }

    fn test_attachment_descriptor(bundle_id: &str, attachment_id: &str, size: u64) -> Value {
        json!({
            "protocol": VISIBLE_ATTACHMENT_PROTOCOL,
            "bundleId": bundle_id,
            "attachmentId": attachment_id,
            "name": format!("{attachment_id}.txt"),
            "type": "text/plain",
            "size": size,
            "sha256": "0".repeat(64),
        })
    }

    #[test]
    fn visible_attachment_request_limits_are_revalidated_by_native_host() {
        let empty = visible_attachment_descriptors(&json!({ "attachments": [] })).unwrap_err();
        assert!(empty.to_string().contains("between 1 and 100"));

        let mixed_bundles = visible_attachment_descriptors(&json!({
            "attachments": [
                test_attachment_descriptor("bundle-one", "first", 1),
                test_attachment_descriptor("bundle-two", "second", 1),
            ],
        }))
        .unwrap_err();
        assert!(mixed_bundles.to_string().contains("share one bundle"));

        let duplicate = visible_attachment_descriptors(&json!({
            "attachments": [
                test_attachment_descriptor("bundle-one", "duplicate", 1),
                test_attachment_descriptor("bundle-one", "duplicate", 1),
            ],
        }))
        .unwrap_err();
        assert!(duplicate.to_string().contains("duplicated"));

        let oversized = visible_attachment_descriptors(&json!({
            "attachments": [
                test_attachment_descriptor("bundle-one", "first", 300 * 1024 * 1024),
                test_attachment_descriptor("bundle-one", "second", 300 * 1024 * 1024),
            ],
        }))
        .unwrap_err();
        assert!(oversized.to_string().contains("aggregate size"));

        let too_many = (0..=MAX_VISIBLE_ATTACHMENTS)
            .map(|index| {
                test_attachment_descriptor("bundle-one", &format!("attachment-{index}"), 0)
            })
            .collect::<Vec<_>>();
        let too_many =
            visible_attachment_descriptors(&json!({ "attachments": too_many })).unwrap_err();
        assert!(too_many.to_string().contains("between 1 and 100"));
    }

    #[test]
    fn visible_attachment_multi_read_must_verify_integrity_before_close() {
        let bytes = b"visible attachment split across several reads";
        let mut fixture = active_attachment_test(bytes, None);
        let opened = fixture.open();
        assert_eq!(opened["ok"], true);
        let handle_id = opened["result"]["handleId"].as_str().unwrap().to_owned();

        let premature = fixture.close(&handle_id);
        assert_native_error_contains(
            &premature,
            "invalid_native_message",
            "complete, integrity-verified read",
        );
        assert!(fixture.host.attachment_handles.contains_key(&handle_id));

        let first = fixture.read(&handle_id, 0, 5);
        assert_eq!(first["ok"], true);
        assert_eq!(first["result"]["nextOffset"], 5);
        assert_eq!(first["result"]["eof"], false);
        let after_first = fixture.close(&handle_id);
        assert_native_error_contains(
            &after_first,
            "invalid_native_message",
            "complete, integrity-verified read",
        );

        let second = fixture.read(&handle_id, 5, 7);
        assert_eq!(second["ok"], true);
        assert_eq!(second["result"]["nextOffset"], 12);
        assert_eq!(second["result"]["eof"], false);
        let final_chunk = fixture.read(&handle_id, 12, MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES as u64);
        assert_eq!(final_chunk["ok"], true);
        assert_eq!(final_chunk["result"]["nextOffset"], bytes.len());
        assert_eq!(final_chunk["result"]["eof"], true);

        let mut reconstructed = STANDARD
            .decode(first["result"]["dataBase64"].as_str().unwrap())
            .unwrap();
        reconstructed.extend(
            STANDARD
                .decode(second["result"]["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
        reconstructed.extend(
            STANDARD
                .decode(final_chunk["result"]["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
        assert_eq!(reconstructed, bytes);
        assert!(
            fixture.host.attachment_handles[&handle_id].integrity_verified,
            "EOF must record a successful size and SHA-256 verification"
        );

        let closed = fixture.close(&handle_id);
        assert_eq!(closed["ok"], true);
        assert_eq!(closed["result"]["status"], "closed");
        assert!(!fixture.host.attachment_handles.contains_key(&handle_id));
        assert!(fixture.bundle_path.exists());

        let early_ready = fixture.host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "requestId": "ready-before-terminal",
            "jobId": fixture.job_id,
            "claimToken": fixture.claim_token,
        }));
        assert_native_error_contains(
            &early_ready,
            "invalid_native_message",
            "before the job is terminal",
        );
        assert!(fixture.bundle_path.exists());
        assert!(fixture
            .host
            .bridge
            .as_ref()
            .unwrap()
            .current_claim
            .is_some());

        let completed = fixture.complete(CompleteJob::Succeeded {
            result_json: json!({ "status": "submitted" }),
        });
        assert_eq!(completed["ok"], true);
        assert_eq!(completed["result"]["status"], "succeeded");
        assert_eq!(
            fixture.store.get_job(&fixture.job_id).unwrap().status,
            JobStatus::Succeeded
        );
        assert!(!fixture.bundle_path.exists());
        let ready = fixture.host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "requestId": "ready-after-terminal",
            "jobId": fixture.job_id,
            "claimToken": fixture.claim_token,
        }));
        assert_eq!(ready["ok"], true);
        assert_eq!(ready["requestId"], "ready-after-terminal");
    }

    #[test]
    fn visible_attachment_rejects_wrong_claim_and_undeclared_descriptor() {
        let bytes = b"claim-bound bytes";
        let mut fixture = active_attachment_test(bytes, None);
        let job_id = fixture.job_id.clone();
        let claim_token = fixture.claim_token.clone();

        let undeclared = fixture.host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.attachment_open",
            "jobId": job_id,
            "claimToken": claim_token,
            "bundleId": TEST_ATTACHMENT_BUNDLE_ID,
            "attachmentId": "not-declared",
        }));
        assert_native_error_contains(
            &undeclared,
            "invalid_native_message",
            "not declared by the active job",
        );

        let wrong_claim = fixture.host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.attachment_open",
            "jobId": fixture.job_id,
            "claimToken": "wrong-claim-token",
            "bundleId": TEST_ATTACHMENT_BUNDLE_ID,
            "attachmentId": TEST_ATTACHMENT_ID,
        }));
        assert_native_error_contains(&wrong_claim, "claim_rejected", "claim rejected");
        assert!(fixture.host.attachment_handles.is_empty());

        let opened = fixture.open();
        assert_eq!(opened["ok"], true);
        let handle_id = opened["result"]["handleId"].as_str().unwrap().to_owned();
        let wrong_read_claim = fixture.host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.attachment_read",
            "jobId": fixture.job_id,
            "claimToken": "wrong-claim-token",
            "handleId": handle_id,
            "offset": 0,
            "maxBytes": bytes.len(),
        }));
        assert_native_error_contains(&wrong_read_claim, "claim_rejected", "claim rejected");
        assert_eq!(fixture.host.attachment_handles[&handle_id].next_offset, 0);

        let read = fixture.read(&handle_id, 0, bytes.len() as u64);
        assert_eq!(read["ok"], true);
        assert_eq!(read["result"]["eof"], true);
        assert_eq!(fixture.close(&handle_id)["ok"], true);
        assert_eq!(
            fixture.complete(CompleteJob::Succeeded {
                result_json: json!({ "status": "submitted" }),
            })["ok"],
            true
        );
    }

    #[test]
    fn visible_attachment_wrong_offset_does_not_advance_or_poison_handle() {
        let bytes = b"strictly sequential bytes";
        let mut fixture = active_attachment_test(bytes, None);
        let opened = fixture.open();
        let handle_id = opened["result"]["handleId"].as_str().unwrap().to_owned();

        let wrong_offset = fixture.read(&handle_id, 1, bytes.len() as u64);
        assert_native_error_contains(&wrong_offset, "invalid_native_message", "expected offset 0");
        let handle = &fixture.host.attachment_handles[&handle_id];
        assert_eq!(handle.next_offset, 0);
        assert!(!handle.integrity_verified);

        let read = fixture.read(&handle_id, 0, bytes.len() as u64);
        assert_eq!(read["ok"], true);
        assert_eq!(read["result"]["eof"], true);
        assert_eq!(fixture.close(&handle_id)["ok"], true);
        assert_eq!(
            fixture.complete(CompleteJob::Succeeded {
                result_json: json!({ "status": "submitted" }),
            })["ok"],
            true
        );
    }

    #[test]
    fn visible_attachment_corrupt_hash_cannot_close_and_terminal_failure_cleans_up() {
        let bytes = b"these bytes do not match the declared digest";
        let mut fixture = active_attachment_test(bytes, Some(&"0".repeat(64)));
        let opened = fixture.open();
        assert_eq!(opened["ok"], true);
        let handle_id = opened["result"]["handleId"].as_str().unwrap().to_owned();

        let corrupt = fixture.read(&handle_id, 0, bytes.len() as u64);
        assert_native_error_contains(
            &corrupt,
            "invalid_native_message",
            "SHA-256 integrity check failed",
        );
        let handle = &fixture.host.attachment_handles[&handle_id];
        assert_eq!(handle.next_offset, bytes.len() as u64);
        assert!(!handle.integrity_verified);

        let close = fixture.close(&handle_id);
        assert_native_error_contains(
            &close,
            "invalid_native_message",
            "complete, integrity-verified read",
        );
        assert!(fixture.host.attachment_handles.contains_key(&handle_id));

        let failed = fixture.complete(CompleteJob::Failed {
            error_json: json!({
                "code": "attachment_integrity_failed",
                "message": "The staged attachment failed verification.",
            }),
        });
        assert_eq!(failed["ok"], true);
        assert_eq!(failed["result"]["status"], "failed");
        assert!(fixture.host.attachment_handles.is_empty());
        assert_eq!(
            fixture.store.get_job(&fixture.job_id).unwrap().status,
            JobStatus::Failed
        );
        assert!(!fixture.bundle_path.exists());
    }

    #[test]
    fn orphan_cleanup_preserves_expired_bundle_for_active_queued_job() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let attachment_root = store.home_dir().join(VISIBLE_ATTACHMENT_DIRECTORY);
        let active_bundle = attachment_root.join("active-bundle");
        let orphan_bundle = attachment_root.join("orphan-bundle");
        fs::create_dir_all(&active_bundle).unwrap();
        fs::create_dir_all(&orphan_bundle).unwrap();
        fs::write(active_bundle.join("active-attachment.bin"), b"active").unwrap();
        fs::write(orphan_bundle.join("orphan-attachment.bin"), b"orphan").unwrap();
        store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({
                    "prompt": "keep active upload",
                    "attachments": [{
                        "protocol": VISIBLE_ATTACHMENT_PROTOCOL,
                        "bundleId": "active-bundle",
                        "attachmentId": "active-attachment",
                        "name": "active.txt",
                        "type": "text/plain",
                        "size": 6,
                        "sha256": "0".repeat(64),
                    }],
                }),
            ))
            .unwrap();
        let active_bundle_ids =
            visible_attachment_bundle_ids(&store.active_request_jsons().unwrap()).unwrap();

        let removed = cleanup_orphaned_visible_attachment_bundles(
            store.home_dir(),
            Duration::ZERO,
            &active_bundle_ids,
        )
        .unwrap();

        assert_eq!(removed, 1);
        assert!(active_bundle.exists());
        assert!(!orphan_bundle.exists());
    }

    #[test]
    fn framing_round_trip_versions_request_and_response() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let request = json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.ping",
            "requestId": "ping-1"
        });
        let mut encoded = Vec::new();
        write_native_message(&mut encoded, &request).unwrap();
        let mut output = Vec::new();
        run_native_host(store, Cursor::new(encoded), &mut output).unwrap();
        let response = read_native_message(&mut Cursor::new(output))
            .unwrap()
            .unwrap();
        assert_eq!(response["protocol"], NATIVE_PROTOCOL);
        assert_eq!(response["type"], "tokenless.native.pong");
        assert_eq!(response["requestId"], "ping-1");
        assert_eq!(response["ok"], true);
    }

    #[test]
    fn malformed_json_frame_returns_structured_error_without_panicking() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let mut input = 1_u32.to_le_bytes().to_vec();
        input.push(b'{');
        let mut output = Vec::new();

        run_native_host(store, Cursor::new(input), &mut output).unwrap();

        let response = read_native_message(&mut Cursor::new(output))
            .unwrap()
            .unwrap();
        assert_eq!(response["protocol"], NATIVE_PROTOCOL);
        assert_eq!(response["type"], "tokenless.native.error");
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "invalid_native_message");
    }

    #[test]
    fn rejects_explicitly_wrong_native_protocol() {
        let tempdir = tempfile::tempdir().unwrap();
        let mut host = NativeHost::new(JobStore::open(tempdir.path()).unwrap());
        let response = host.handle_message(json!({
            "protocol": "tokenless.native.v999",
            "type": "tokenless.native.ping",
        }));
        assert_eq!(response["protocol"], NATIVE_PROTOCOL);
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "unsupported_native_protocol");

        let missing = host.handle_message(json!({
            "type": "tokenless.native.read_config",
        }));
        assert_eq!(missing["protocol"], NATIVE_PROTOCOL);
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["error"]["code"], "unsupported_native_protocol");
    }

    #[test]
    fn framing_enforces_input_and_output_boundaries() {
        let exact = Value::String("x".repeat(MAX_NATIVE_OUTPUT_BYTES - 2));
        let mut output = Vec::new();
        write_native_message(&mut output, &exact).unwrap();
        assert_eq!(output.len(), MAX_NATIVE_OUTPUT_BYTES + 4);

        let oversized = Value::String("x".repeat(MAX_NATIVE_OUTPUT_BYTES - 1));
        let mut rejected_output = Vec::new();
        assert!(matches!(
            write_native_message(&mut rejected_output, &oversized),
            Err(DaemonError::InvalidInput(_))
        ));
        assert!(rejected_output.is_empty());

        let mut oversized_header = Cursor::new(
            u32::try_from(MAX_NATIVE_INPUT_BYTES + 1)
                .unwrap()
                .to_le_bytes()
                .to_vec(),
        );
        assert!(matches!(
            read_native_message(&mut oversized_header),
            Err(DaemonError::InvalidInput(_))
        ));
    }

    #[test]
    fn bridge_pushes_one_running_job_until_ready() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let first = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "one" }),
            ))
            .unwrap();
        let second = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "two" }),
            ))
            .unwrap();
        let mut host = NativeHost::new(store.clone());
        let connected = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_connect",
        }));
        assert_eq!(connected["ok"], true);

        let first_push = host.poll_bridge_now().unwrap().unwrap();
        assert_eq!(first_push["type"], "tokenless.native.daemon_job");
        assert_eq!(first_push["result"]["job"]["job_id"], first.job_id);
        assert_eq!(first_push["result"]["job"]["status"], "running");
        let first_claim_token = first_push["result"]["job"]["claim_token"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(host.poll_bridge_now().unwrap().is_none());
        assert_eq!(
            store.get_job(&second.job_id).unwrap().status,
            JobStatus::Queued
        );

        store
            .complete_job(
                &first.job_id,
                &first_claim_token,
                CompleteJob::Succeeded {
                    result_json: json!({ "status": "submitted" }),
                },
            )
            .unwrap();

        let ready = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "jobId": first.job_id,
            "claimToken": first_claim_token,
        }));
        assert_eq!(ready["ok"], true);
        assert_eq!(ready["result"]["jobId"], first.job_id);
        let second_push = host.poll_bridge_now().unwrap().unwrap();
        assert_eq!(second_push["result"]["job"]["job_id"], second.job_id);
    }

    #[test]
    fn daemon_ready_strictly_correlates_and_stale_or_duplicate_ready_cannot_release_claim() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let first = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "one" }),
            ))
            .unwrap();
        let second = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "two" }),
            ))
            .unwrap();
        let mut host = NativeHost::new(store.clone());
        host.connect_bridge(None, None).unwrap();
        let first_push = host.poll_bridge_now().unwrap().unwrap();
        let first_token = first_push["result"]["job"]["claim_token"]
            .as_str()
            .unwrap()
            .to_owned();

        let bare = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
        }));
        assert_eq!(bare["ok"], false);
        let wrong = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "jobId": first.job_id,
            "claimToken": "wrong-token",
        }));
        assert_eq!(wrong["ok"], false);
        assert_eq!(wrong["error"]["code"], "claim_rejected");
        let padded = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "jobId": first.job_id,
            "claimToken": format!(" {first_token} "),
        }));
        assert_eq!(padded["ok"], false);
        assert_eq!(padded["error"]["code"], "claim_rejected");
        assert!(host.poll_bridge_now().unwrap().is_none());
        assert_eq!(
            host.bridge
                .as_ref()
                .unwrap()
                .current_claim
                .as_ref()
                .unwrap()
                .job_id,
            first.job_id
        );

        store
            .complete_job(
                &first.job_id,
                &first_token,
                CompleteJob::Succeeded {
                    result_json: json!({ "status": "submitted" }),
                },
            )
            .unwrap();

        let accepted = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "jobId": first.job_id,
            "claimToken": first_token,
        }));
        assert_eq!(accepted["ok"], true);
        let second_push = host.poll_bridge_now().unwrap().unwrap();
        let second_token = second_push["result"]["job"]["claim_token"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(second_push["result"]["job"]["job_id"], second.job_id);

        let stale_duplicate = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_ready",
            "jobId": first.job_id,
            "claimToken": first_token,
        }));
        assert_eq!(stale_duplicate["ok"], false);
        assert!(host.poll_bridge_now().unwrap().is_none());
        assert_eq!(
            host.bridge
                .as_ref()
                .unwrap()
                .current_claim
                .as_ref()
                .unwrap()
                .claim_token,
            second_token
        );
    }

    #[test]
    fn oversized_claimed_job_is_failed_and_bridge_continues() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let oversized = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "x".repeat(MAX_NATIVE_OUTPUT_BYTES) }),
            ))
            .unwrap();
        let next = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "small" }),
            ))
            .unwrap();
        let mut host = NativeHost::new(store.clone());
        host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_connect",
        }));

        let error_push = host.poll_bridge_now().unwrap().unwrap();
        assert_eq!(error_push["type"], "tokenless.native.daemon_error");
        assert_eq!(error_push["error"]["code"], "native_message_too_large");
        assert!(encoded_message_size(&error_push).unwrap() <= MAX_NATIVE_OUTPUT_BYTES);
        let failed = store.get_job(&oversized.job_id).unwrap();
        assert_eq!(failed.status, JobStatus::Failed);
        assert_eq!(
            failed.error_json.unwrap()["code"],
            "native_message_too_large"
        );

        let next_push = host.poll_bridge_now().unwrap().unwrap();
        assert_eq!(next_push["result"]["job"]["job_id"], next.job_id);
    }

    #[test]
    fn native_config_history_and_completion_are_compact() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let mut host = NativeHost::new(store.clone());
        let config = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.write_config",
            "preferredProviders": ["claude", "chatgpt"],
            "browser": "brave",
            "daemonUrl": "http://localhost:7331/",
        }));
        assert_eq!(config["ok"], true);
        assert_eq!(config["result"]["protocol"], "tokenless.config.v1");
        assert_eq!(config["result"]["browser"], "brave");
        let cleared = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.write_config",
            "browser": null,
            "daemonUrl": null,
        }));
        assert_eq!(cleared["result"]["browser"], Value::Null);
        assert_eq!(cleared["result"]["daemonUrl"], Value::Null);
        assert_eq!(
            cleared["result"]["preferredProviders"],
            json!(["claude", "chatgpt"])
        );

        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({
                    "prompt": "private".repeat(100_000),
                    "metadata": {
                        "taskId": "task-1",
                        "projectName": "Tokenless",
                        "secret": "must-not-leak",
                    }
                }),
            ))
            .unwrap();
        let history = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.list_history",
            "limit": 60,
        }));
        assert_eq!(history["ok"], true);
        assert_eq!(history["result"][0]["job_id"], job.job_id);
        assert_eq!(history["result"][0]["metadata"]["taskId"], "task-1");
        assert!(history["result"][0].get("request_json").is_none());
        assert!(history["result"][0].get("result_json").is_none());
        assert!(history["result"][0].get("claim_token").is_none());
        assert!(serde_json::to_string(&history)
            .unwrap()
            .find("must-not-leak")
            .is_none());
        assert!(encoded_message_size(&history).unwrap() < 10_000);

        let claimed = store
            .claim_next_job(ClaimNextJob::default())
            .unwrap()
            .unwrap();
        store
            .mark_running(&claimed.job_id, &claimed.claim_token)
            .unwrap();
        let completed = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.daemon_complete_job",
            "jobId": claimed.job_id,
            "claimToken": claimed.claim_token,
            "result": { "snapshot": "x".repeat(MAX_NATIVE_OUTPUT_BYTES) },
        }));
        assert_eq!(completed["ok"], true);
        assert_eq!(completed["result"]["status"], "succeeded");
        assert!(completed["result"].get("result_json").is_none());
        assert!(encoded_message_size(&completed).unwrap() < 10_000);

        let failed = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "another private prompt" }),
            ))
            .unwrap();
        let failed_claim = store
            .claim_next_job(ClaimNextJob::default())
            .unwrap()
            .unwrap();
        assert_eq!(failed_claim.job_id, failed.job_id);
        store
            .mark_running(&failed_claim.job_id, &failed_claim.claim_token)
            .unwrap();
        store
            .complete_job(
                &failed_claim.job_id,
                &failed_claim.claim_token,
                CompleteJob::Failed {
                    error_json: json!({
                        "code": "attacker-controlled-private-code",
                        "message": "attacker-controlled-private-message",
                        "payload": "x".repeat(MAX_NATIVE_INPUT_BYTES),
                    }),
                },
            )
            .unwrap();
        let redacted_history = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.list_history",
        }));
        let serialized = serde_json::to_string(&redacted_history).unwrap();
        assert_eq!(redacted_history["ok"], true);
        assert!(!serialized.contains("attacker-controlled-private"));
        assert!(redacted_history["result"][0].get("error_json").is_none());
        assert!(redacted_history["result"][0].get("error_code").is_none());
        assert!(encoded_message_size(&redacted_history).unwrap() < 10_000);
    }

    #[test]
    fn native_history_is_stably_newest_first() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let older = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "older" }),
            ))
            .unwrap();
        thread::sleep(Duration::from_millis(2));
        let newer = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "newer" }),
            ))
            .unwrap();
        let mut host = NativeHost::new(store);

        let history = host.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.list_history",
        }));

        assert_eq!(history["result"][0]["job_id"], newer.job_id);
        assert_eq!(history["result"][1]["job_id"], older.job_id);
    }

    #[test]
    fn bridge_ownership_is_exclusive_without_blocking_short_lived_hosts() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let marker_path = store.home_dir().join(BRIDGE_MARKER_FILE_NAME);
        let first = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "owned by first bridge" }),
            ))
            .unwrap();
        let second = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "available to next bridge" }),
            ))
            .unwrap();
        let mut old_host = NativeHost::new(store.clone());
        old_host
            .connect_bridge(None, None)
            .expect("old bridge connects");
        let first_push = old_host.poll_bridge_now().unwrap().unwrap();
        let first_claim_token = first_push["result"]["job"]["claim_token"]
            .as_str()
            .unwrap()
            .to_owned();
        let old_marker: BridgeMarker =
            serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        assert_eq!(old_marker.protocol, BRIDGE_MARKER_PROTOCOL);
        assert_eq!(old_marker.session_id, old_host.session_id);

        thread::sleep(Duration::from_millis(2));
        old_host.bridge.as_mut().unwrap().next_heartbeat = Instant::now();
        assert!(old_host.tick().unwrap().is_empty());
        let heartbeated: BridgeMarker =
            serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        assert_ne!(heartbeated.heartbeat_at, old_marker.heartbeat_at);

        let mut new_host = NativeHost::new(store.clone());
        assert!(matches!(
            new_host.connect_bridge(None, None),
            Err(DaemonError::BridgeBusy)
        ));
        let unchanged_marker: BridgeMarker =
            serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        assert_eq!(unchanged_marker.session_id, old_marker.session_id);

        let started = Instant::now();
        let mut short_lived = NativeHost::new(store.clone());
        let config = short_lived.handle_message(json!({
            "protocol": NATIVE_PROTOCOL,
            "type": "tokenless.native.read_config",
        }));
        assert_eq!(config["ok"], true);
        drop(short_lived);
        assert!(started.elapsed() < Duration::from_secs(1));

        old_host.disconnect().unwrap();
        assert!(!marker_path.exists());
        let abandoned = store.get_job(&first.job_id).unwrap();
        assert_eq!(abandoned.status, JobStatus::Running);
        assert_eq!(abandoned.claim_token, first_claim_token);

        new_host
            .connect_bridge(None, None)
            .expect("new bridge connects after ownership is released");
        let new_marker: BridgeMarker =
            serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        assert_ne!(new_marker.session_id, old_marker.session_id);
        let second_push = new_host.poll_bridge_now().unwrap().unwrap();
        assert_eq!(second_push["result"]["job"]["job_id"], second.job_id);
        assert_eq!(
            store.get_job(&first.job_id).unwrap().status,
            JobStatus::Running
        );
        new_host.disconnect().unwrap();
        assert!(!marker_path.exists());
    }

    #[test]
    fn connected_bridge_renews_the_active_claim() {
        let tempdir = tempfile::tempdir().unwrap();
        let store =
            JobStore::open_with_claim_lease(tempdir.path(), Duration::from_millis(150)).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "renew me" }),
            ))
            .unwrap();
        let mut host = NativeHost::new(store.clone());
        host.connect_bridge(None, None).unwrap();
        host.poll_bridge_now().unwrap().unwrap();
        let initial_expiry = store
            .get_job(&job.job_id)
            .unwrap()
            .claim_expires_at_ms
            .unwrap();

        thread::sleep(Duration::from_millis(25));
        host.bridge.as_mut().unwrap().next_renewal = Instant::now();
        assert!(host.tick().unwrap().is_empty());
        let renewed_expiry = store
            .get_job(&job.job_id)
            .unwrap()
            .claim_expires_at_ms
            .unwrap();
        assert!(renewed_expiry > initial_expiry);
    }

    #[test]
    fn native_host_home_prefers_env_then_installed_bin_layout() {
        assert_eq!(
            resolve_native_host_home(
                Some(OsString::from("/explicit/tokenless")),
                Path::new("/installed/tokenless/bin/tokenless-native-host")
            )
            .unwrap(),
            PathBuf::from("/explicit/tokenless")
        );
        assert_eq!(
            resolve_native_host_home(
                None,
                Path::new("/installed/tokenless/bin/tokenless-native-host.exe")
            )
            .unwrap(),
            PathBuf::from("/installed/tokenless")
        );
        assert!(resolve_native_host_home(
            None,
            Path::new("/checkout/target/release/tokenless-native-host")
        )
        .is_err());
    }
}
