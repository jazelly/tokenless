use crate::config::{write_json_atomic_secure, ConfigStore, ConfigUpdate};
use crate::{ClaimNextJob, CompleteJob, DaemonError, Job, JobStatus, JobStore, JobSummary, Result};
use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const NATIVE_PROTOCOL: &str = "tokenless.native.v1";
pub const BRIDGE_MARKER_PROTOCOL: &str = "tokenless.extension-bridge-state.v1";
pub const BRIDGE_MARKER_FILE_NAME: &str = "extension-bridge.json";
pub const MAX_NATIVE_INPUT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_NATIVE_OUTPUT_BYTES: usize = 1024 * 1024;
pub const NATIVE_INPUT_QUEUE_CAPACITY: usize = 4;

const BRIDGE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const BRIDGE_ERROR_INTERVAL: Duration = Duration::from_secs(1);
const BRIDGE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const CLAIM_RENEW_INTERVAL: Duration = Duration::from_secs(10);
const EVENT_LOOP_INTERVAL: Duration = Duration::from_millis(50);
const HISTORY_LIMIT: usize = 60;
const BRIDGE_MARKER_LOCK_FILE_NAME: &str = ".extension-bridge.lock";

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
}

impl NativeHost {
    pub fn new(store: JobStore) -> Self {
        Self {
            config_store: ConfigStore::new(store.home_dir()),
            marker_path: store.home_dir().join(BRIDGE_MARKER_FILE_NAME),
            store,
            session_id: Uuid::new_v4().to_string(),
            connected_at: timestamp(),
            bridge: None,
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
                Ok((
                    request_type.to_owned(),
                    serde_json::to_value(CompactJobSummary::from_job(&job))?,
                ))
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
        let bridge = self.bridge.as_mut().ok_or_else(|| {
            DaemonError::InvalidInput("daemon bridge is not connected".to_owned())
        })?;
        let active = bridge.current_claim.as_ref().ok_or_else(|| {
            DaemonError::InvalidInput("daemon bridge has no active claim".to_owned())
        })?;
        if active.job_id != job_id
            || !crate::constant_time_eq(active.claim_token.as_bytes(), claim_token.as_bytes())
        {
            return Err(DaemonError::ClaimRejected(job_id.to_owned()));
        }
        bridge.current_claim = None;
        bridge.has_capacity = true;
        bridge.next_poll = Instant::now();
        Ok(())
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
    use crate::CreateJob;
    use std::io::Cursor;

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
