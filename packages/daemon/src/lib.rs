use axum::{
    body::Bytes,
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::env;
use std::fmt;
use std::fs;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use tokio::net::TcpListener;
use uuid::Uuid;

pub mod config;
pub mod native_host;

const DATABASE_FILE_NAME: &str = "tokenless.sqlite3";
const CONTROL_TOKEN_FILE_NAME: &str = "daemon.token";
const SECRET_TOKEN_BYTES: usize = 32;
const SUMMARY_SCALAR_CHARS: usize = 256;
const PROFILE_ID_CHARS: usize = 128;
pub const DAEMON_PROTOCOL: &str = "tokenless.daemon.v1";
pub const DAEMON_READY_PROOF_PROTOCOL: &str = "tokenless.daemon-ready-proof.v1";
pub const NATIVE_BINARY_BUILD_INFO_PROTOCOL: &str = "tokenless.native-binary-build-info.v1";
pub const READY_CHALLENGE_BYTES: usize = 32;
pub const READY_CHALLENGE_BASE64URL_CHARS: usize = 43;
pub const DEFAULT_CLAIM_LEASE: std::time::Duration = std::time::Duration::from_secs(30);

pub fn native_binary_build_info(binary: &str) -> Value {
    let platform = match env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        value => value,
    };
    let arch = match env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    };
    json!({
        "protocol": NATIVE_BINARY_BUILD_INFO_PROTOCOL,
        "binary": binary,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": platform,
        "arch": arch,
    })
}

#[derive(Debug)]
pub enum DaemonError {
    Io(std::io::Error),
    Random(getrandom::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    MissingHome,
    InvalidInput(String),
    NonLoopbackBind(IpAddr),
    InvalidStatus(String),
    JobNotFound(String),
    ClaimRejected(String),
    ClaimExpired(String),
    BridgeBusy,
    ControlAuthMissing,
    ControlAuthRejected,
    InvalidJobState {
        job_id: String,
        expected: &'static str,
        actual: JobStatus,
    },
}

impl fmt::Display for DaemonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Random(error) => write!(f, "random token generation error: {error}"),
            Self::Sqlite(error) => write!(f, "SQLite error: {error}"),
            Self::Json(error) => write!(f, "JSON error: {error}"),
            Self::MissingHome => write!(
                f,
                "cannot resolve Tokenless home; pass --home or set TOKENLESS_HOME/HOME"
            ),
            Self::InvalidInput(message) => write!(f, "invalid input: {message}"),
            Self::NonLoopbackBind(host) => write!(
                f,
                "refusing to bind daemon to non-loopback host {host}; Tokenless daemon is a local control plane"
            ),
            Self::InvalidStatus(status) => write!(f, "invalid job status: {status}"),
            Self::JobNotFound(job_id) => write!(f, "job not found: {job_id}"),
            Self::ClaimRejected(job_id) => write!(f, "claim rejected for job: {job_id}"),
            Self::ClaimExpired(job_id) => write!(f, "claim lease expired for job: {job_id}"),
            Self::BridgeBusy => write!(f, "another extension bridge session is already active"),
            Self::ControlAuthMissing => write!(f, "missing bearer token"),
            Self::ControlAuthRejected => write!(f, "invalid bearer token"),
            Self::InvalidJobState {
                job_id,
                expected,
                actual,
            } => write!(
                f,
                "invalid state for job {job_id}: expected {expected}, found {}",
                actual.as_str()
            ),
        }
    }
}

impl std::error::Error for DaemonError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sqlite(error) => Some(error),
            Self::Json(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for DaemonError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<getrandom::Error> for DaemonError {
    fn from(error: getrandom::Error) -> Self {
        Self::Random(error)
    }
}

impl From<rusqlite::Error> for DaemonError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<serde_json::Error> for DaemonError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub type Result<T> = std::result::Result<T, DaemonError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Claimed,
    Running,
    Succeeded,
    Failed,
    Canceled,
    TimedOut,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Claimed => "claimed",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
            Self::TimedOut => "timed_out",
        }
    }

    fn from_db(value: String) -> Result<Self> {
        match value.as_str() {
            "queued" => Ok(Self::Queued),
            "claimed" => Ok(Self::Claimed),
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "canceled" => Ok(Self::Canceled),
            "timed_out" => Ok(Self::TimedOut),
            _ => Err(DaemonError::InvalidStatus(value)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionBackend {
    LegacyExtension,
    Playwright,
}

impl ExecutionBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LegacyExtension => "legacy_extension",
            Self::Playwright => "playwright",
        }
    }

    fn from_db(value: String) -> Result<Self> {
        match value.as_str() {
            "legacy_extension" => Ok(Self::LegacyExtension),
            "playwright" => Ok(Self::Playwright),
            _ => Err(DaemonError::InvalidInput(format!(
                "invalid execution_backend: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub job_id: String,
    pub claim_token: String,
    pub execution_backend: ExecutionBackend,
    pub profile_id: Option<String>,
    pub provider: String,
    pub action: String,
    pub status: JobStatus,
    pub request_json: Value,
    pub result_json: Option<Value>,
    pub error_json: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    pub claim_expires_at_ms: Option<i64>,
}

impl Job {
    pub fn public_view(&self) -> JobView {
        JobView {
            job_id: self.job_id.clone(),
            execution_backend: self.execution_backend,
            profile_id: self.profile_id.clone(),
            provider: self.provider.clone(),
            action: self.action.clone(),
            status: self.status,
            request_json: self.request_json.clone(),
            result_json: self.result_json.clone(),
            error_json: self.error_json.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    pub fn with_claim_token(&self) -> JobWithClaimToken {
        JobWithClaimToken {
            job_id: self.job_id.clone(),
            claim_token: self.claim_token.clone(),
            execution_backend: self.execution_backend,
            profile_id: self.profile_id.clone(),
            provider: self.provider.clone(),
            action: self.action.clone(),
            status: self.status,
            request_json: self.request_json.clone(),
            result_json: self.result_json.clone(),
            error_json: self.error_json.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobView {
    pub job_id: String,
    pub execution_backend: ExecutionBackend,
    pub profile_id: Option<String>,
    pub provider: String,
    pub action: String,
    pub status: JobStatus,
    pub request_json: Value,
    pub result_json: Option<Value>,
    pub error_json: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobWithClaimToken {
    pub job_id: String,
    pub claim_token: String,
    pub execution_backend: ExecutionBackend,
    pub profile_id: Option<String>,
    pub provider: String,
    pub action: String,
    pub status: JobStatus,
    pub request_json: Value,
    pub result_json: Option<Value>,
    pub error_json: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct CreateJob {
    pub provider: String,
    pub action: String,
    pub request_json: Value,
    pub execution_backend: ExecutionBackend,
    pub profile_id: Option<String>,
    pub job_id: Option<String>,
    pub claim_token: Option<String>,
}

impl CreateJob {
    pub fn new(
        provider: impl Into<String>,
        action: impl Into<String>,
        request_json: Value,
    ) -> Self {
        Self {
            provider: provider.into(),
            action: action.into(),
            request_json,
            execution_backend: ExecutionBackend::LegacyExtension,
            profile_id: None,
            job_id: None,
            claim_token: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum CompleteJob {
    Succeeded { result_json: Value },
    Failed { error_json: Value },
}

#[derive(Debug, Clone, Default)]
pub struct ListJobs {
    pub status: Option<JobStatus>,
    pub execution_backend: Option<ExecutionBackend>,
    pub profile_id: Option<String>,
    pub provider: Option<String>,
    pub task_id: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSummary {
    pub job_id: String,
    pub execution_backend: ExecutionBackend,
    pub profile_id: Option<String>,
    pub provider: String,
    pub action: String,
    pub status: JobStatus,
    pub created_at: String,
    pub updated_at: String,
    pub task_id: Option<String>,
    pub project_name: Option<String>,
    pub chat_name: Option<String>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct RequestSummaryMetadata {
    task_id: Option<String>,
    project_name: Option<String>,
    chat_name: Option<String>,
    idempotency_key: Option<String>,
    task_keys: Vec<String>,
}

impl RequestSummaryMetadata {
    fn from_request(request: &Value) -> Self {
        let request_object = request.as_object();
        let metadata_object = request_object
            .and_then(|object| object.get("metadata"))
            .and_then(Value::as_object);
        let request_value = |key: &str| {
            request_object
                .and_then(|object| object.get(key))
                .and_then(Value::as_str)
                .and_then(bounded_nonempty_summary_value)
        };
        let metadata_value = |key: &str| {
            metadata_object
                .and_then(|object| object.get(key))
                .and_then(Value::as_str)
                .and_then(bounded_nonempty_summary_value)
        };

        let request_task_id = request_value("taskId");
        let request_idempotency_key = request_value("idempotencyKey");
        let request_id = request_value("requestId");
        let metadata_task_id = metadata_value("taskId");
        let metadata_idempotency_key = metadata_value("idempotencyKey");
        let mut task_keys = Vec::new();
        for key in [
            request_task_id.as_ref(),
            request_idempotency_key.as_ref(),
            request_id.as_ref(),
            metadata_task_id.as_ref(),
            metadata_idempotency_key.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if !task_keys.contains(key) {
                task_keys.push(key.clone());
            }
        }

        Self {
            task_id: metadata_task_id.clone().or_else(|| request_task_id.clone()),
            project_name: metadata_value("projectName").or_else(|| request_value("projectName")),
            chat_name: metadata_value("chatName").or_else(|| request_value("chatName")),
            idempotency_key: metadata_idempotency_key.or(request_idempotency_key),
            task_keys,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ClaimNextJob {
    pub provider: Option<String>,
    pub action: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JobStore {
    home_dir: PathBuf,
    database_path: PathBuf,
    control_token_path: PathBuf,
    claim_lease_ms: i64,
}

impl JobStore {
    pub fn open(home_dir: impl Into<PathBuf>) -> Result<Self> {
        Self::open_with_claim_lease(home_dir, DEFAULT_CLAIM_LEASE)
    }

    pub fn open_with_claim_lease(
        home_dir: impl Into<PathBuf>,
        claim_lease: std::time::Duration,
    ) -> Result<Self> {
        let home_dir = home_dir.into();
        ensure_tokenless_home(&home_dir)?;
        let home_dir = fs::canonicalize(home_dir)?;
        let database_path = home_dir.join(DATABASE_FILE_NAME);
        let control_token_path = home_dir.join(CONTROL_TOKEN_FILE_NAME);
        ensure_control_token(&control_token_path)?;
        let claim_lease_ms = i64::try_from(claim_lease.as_millis())
            .unwrap_or(i64::MAX)
            .max(1);
        let store = Self {
            home_dir,
            database_path,
            control_token_path,
            claim_lease_ms,
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn open_default() -> Result<Self> {
        Self::open(default_home_dir()?)
    }

    pub fn home_dir(&self) -> &Path {
        &self.home_dir
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn control_token_path(&self) -> &Path {
        &self.control_token_path
    }

    pub fn control_token(&self) -> Result<String> {
        read_control_token(&self.control_token_path)
    }

    pub fn create_job(&self, input: CreateJob) -> Result<Job> {
        let provider = normalize_nonempty(input.provider, "provider")?;
        let action = normalize_nonempty(input.action, "action")?;
        let (execution_backend, profile_id) =
            validate_job_backend_profile(input.execution_backend, input.profile_id)?;
        let job_id = input
            .job_id
            .map(|value| normalize_nonempty(value, "job_id"))
            .transpose()?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let claim_token = match input.claim_token {
            Some(value) => normalize_nonempty(value, "claim_token")?,
            None => generate_secret_token()?,
        };
        let now = now_rfc3339();
        let summary = RequestSummaryMetadata::from_request(&input.request_json);
        let request_json = serde_json::to_string(&input.request_json)?;
        let mut conn = self.connection()?;
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        transaction.execute(
            "INSERT INTO jobs (
                job_id, claim_token, execution_backend, profile_id,
                provider, action, status, request_json,
                result_json, error_json, created_at, updated_at,
                summary_task_id, summary_project_name, summary_chat_name,
                summary_idempotency_key
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, ?9,
                ?10, ?11, ?12, ?13
            )",
            params![
                job_id,
                claim_token,
                execution_backend.as_str(),
                profile_id,
                provider,
                action,
                JobStatus::Queued.as_str(),
                request_json,
                now,
                summary.task_id,
                summary.project_name,
                summary.chat_name,
                summary.idempotency_key,
            ],
        )?;
        for task_key in summary.task_keys {
            transaction.execute(
                "INSERT INTO job_task_keys (job_id, task_id) VALUES (?1, ?2)",
                params![job_id, task_key],
            )?;
        }
        transaction.commit()?;

        self.get_job(&job_id)
    }

    pub fn list_jobs(&self, query: ListJobs) -> Result<Vec<Job>> {
        self.requeue_expired_claims()?;
        let execution_backend = query.execution_backend;
        let profile_id = query
            .profile_id
            .map(|value| normalize_profile_id(value, "profile_id"))
            .transpose()?;
        validate_filter_backend_profile(execution_backend, profile_id.as_deref())?;
        let provider = query
            .provider
            .map(|value| normalize_nonempty(value, "provider"))
            .transpose()?;
        let task_id = query
            .task_id
            .map(|value| normalize_summary_filter(value, "task_id"))
            .transpose()?;
        let conn = self.connection()?;
        let limit = query.limit.unwrap_or(100).clamp(1, 1000) as i64;
        let mut sql = String::from(
            "SELECT
                jobs.job_id, jobs.claim_token, jobs.execution_backend, jobs.profile_id,
                jobs.provider, jobs.action, jobs.status, jobs.request_json, jobs.result_json,
                jobs.error_json, jobs.created_at, jobs.updated_at, jobs.claim_expires_at
             FROM jobs",
        );
        let mut parameters = Vec::new();
        if let Some(task_id) = task_id {
            sql.push_str(
                " INNER JOIN job_task_keys AS matched_task
                    ON matched_task.job_id = jobs.job_id
                   AND matched_task.task_id = ?",
            );
            parameters.push(SqlValue::Text(task_id));
        }
        sql.push_str(" WHERE 1 = 1");
        if let Some(status) = query.status {
            sql.push_str(" AND jobs.status = ?");
            parameters.push(SqlValue::Text(status.as_str().to_owned()));
        }
        if let Some(execution_backend) = execution_backend {
            sql.push_str(" AND jobs.execution_backend = ?");
            parameters.push(SqlValue::Text(execution_backend.as_str().to_owned()));
        }
        if let Some(profile_id) = profile_id {
            sql.push_str(" AND jobs.profile_id = ?");
            parameters.push(SqlValue::Text(profile_id));
        }
        if let Some(provider) = provider {
            sql.push_str(" AND jobs.provider = ?");
            parameters.push(SqlValue::Text(provider));
        }
        sql.push_str(" ORDER BY jobs.created_at DESC, jobs.job_id DESC LIMIT ?");
        parameters.push(SqlValue::Integer(limit));
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(parameters.iter()), row_to_job)?;
        collect_jobs(rows)
    }

    pub fn list_job_summaries(&self, limit: Option<usize>) -> Result<Vec<JobSummary>> {
        self.requeue_expired_claims()?;
        let conn = self.connection()?;
        let limit = limit.unwrap_or(50).clamp(1, 60) as i64;
        let mut stmt = conn.prepare(
            "SELECT
                substr(job_id, 1, 256),
                execution_backend,
                substr(profile_id, 1, 128),
                substr(provider, 1, 64),
                substr(action, 1, 128),
                status,
                substr(created_at, 1, 64),
                substr(updated_at, 1, 64),
                substr(summary_task_id, 1, 256),
                substr(summary_project_name, 1, 256),
                substr(summary_chat_name, 1, 256),
                substr(summary_idempotency_key, 1, 256)
             FROM jobs
             ORDER BY created_at DESC, job_id DESC
             LIMIT ?1",
        )?;
        let summaries = stmt
            .query_map(params![limit], row_to_job_summary)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(summaries)
    }

    pub fn get_job(&self, job_id: &str) -> Result<Job> {
        self.requeue_expired_claims()?;
        let conn = self.connection()?;
        get_job_with_conn(&conn, job_id)
    }

    pub fn claim_job(&self, job_id: &str, claim_token: &str) -> Result<Job> {
        self.claim_job_at(job_id, claim_token, now_unix_millis())
    }

    fn claim_job_at(&self, job_id: &str, claim_token: &str, now_ms: i64) -> Result<Job> {
        self.requeue_expired_claims_at(now_ms)?;
        let now = now_rfc3339();
        let expires_at = now_ms.saturating_add(self.claim_lease_ms);
        let conn = self.connection()?;
        let affected = conn.execute(
            "UPDATE jobs
             SET status = ?1, updated_at = ?2, claim_expires_at = ?3
             WHERE job_id = ?4 AND claim_token = ?5 AND status = ?6",
            params![
                JobStatus::Claimed.as_str(),
                now,
                expires_at,
                job_id,
                claim_token,
                JobStatus::Queued.as_str()
            ],
        )?;

        if affected == 1 {
            return get_job_with_conn(&conn, job_id);
        }

        explain_claim_failure(&conn, job_id, claim_token)
    }

    pub fn claim_next_job(&self, query: ClaimNextJob) -> Result<Option<Job>> {
        self.claim_next_job_at(query, now_unix_millis())
    }

    fn claim_next_job_at(&self, query: ClaimNextJob, now_ms: i64) -> Result<Option<Job>> {
        self.claim_next_job_with_scope_at(query, ExecutionBackend::LegacyExtension, None, now_ms)
    }

    pub fn claim_next_job_with_scope(
        &self,
        query: ClaimNextJob,
        execution_backend: ExecutionBackend,
        profile_id: Option<String>,
    ) -> Result<Option<Job>> {
        self.claim_next_job_with_scope_at(query, execution_backend, profile_id, now_unix_millis())
    }

    fn claim_next_job_with_scope_at(
        &self,
        query: ClaimNextJob,
        execution_backend: ExecutionBackend,
        profile_id: Option<String>,
        now_ms: i64,
    ) -> Result<Option<Job>> {
        let profile_id = profile_id
            .map(|value| normalize_profile_id(value, "profile_id"))
            .transpose()?;
        validate_claim_backend_profile(execution_backend, profile_id.as_deref())?;
        let provider = query
            .provider
            .map(|value| normalize_nonempty(value, "provider"))
            .transpose()?;
        let action = query
            .action
            .map(|value| normalize_nonempty(value, "action"))
            .transpose()?;
        self.requeue_expired_claims_at(now_ms)?;
        let now = now_rfc3339();
        let expires_at = now_ms.saturating_add(self.claim_lease_ms);
        let next_claim_token = generate_secret_token()?;
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "UPDATE jobs
             SET status = ?1, updated_at = ?2, claim_expires_at = ?3, claim_token = ?4
             WHERE job_id = (
                SELECT job_id
                FROM jobs
                WHERE status = ?5
                  AND execution_backend = ?6
                  AND ((?7 IS NULL AND profile_id IS NULL) OR profile_id = ?7)
                  AND (?8 IS NULL OR provider = ?8)
                  AND (?9 IS NULL OR action = ?9)
                ORDER BY created_at ASC, job_id ASC
                LIMIT 1
             )
             RETURNING
                job_id, claim_token, execution_backend, profile_id,
                provider, action, status, request_json, result_json, error_json,
                created_at, updated_at, claim_expires_at",
        )?;

        stmt.query_row(
            params![
                JobStatus::Claimed.as_str(),
                now,
                expires_at,
                next_claim_token,
                JobStatus::Queued.as_str(),
                execution_backend.as_str(),
                profile_id.as_deref(),
                provider.as_deref(),
                action.as_deref(),
            ],
            row_to_job,
        )
        .optional()
        .map_err(DaemonError::Sqlite)
    }

    pub fn renew_claim(&self, job_id: &str, claim_token: &str) -> Result<Job> {
        self.renew_claim_at(job_id, claim_token, now_unix_millis())
    }

    fn renew_claim_at(&self, job_id: &str, claim_token: &str, now_ms: i64) -> Result<Job> {
        let now = now_rfc3339();
        let expires_at = now_ms.saturating_add(self.claim_lease_ms);
        let conn = self.connection()?;
        let affected = conn.execute(
            "UPDATE jobs
             SET claim_expires_at = ?1, updated_at = ?2
             WHERE job_id = ?3
               AND claim_token = ?4
               AND status IN ('claimed', 'running')
               AND claim_expires_at > ?5",
            params![expires_at, now, job_id, claim_token, now_ms],
        )?;
        if affected == 1 {
            return get_job_with_conn(&conn, job_id);
        }
        explain_active_claim_failure(&conn, job_id, claim_token, now_ms)
    }

    pub fn mark_running(&self, job_id: &str, claim_token: &str) -> Result<Job> {
        self.mark_running_at(job_id, claim_token, now_unix_millis())
    }

    fn mark_running_at(&self, job_id: &str, claim_token: &str, now_ms: i64) -> Result<Job> {
        let now = now_rfc3339();
        let expires_at = now_ms.saturating_add(self.claim_lease_ms);
        let conn = self.connection()?;
        let affected = conn.execute(
            "UPDATE jobs
             SET status = ?1, claim_expires_at = ?2, updated_at = ?3
             WHERE job_id = ?4
               AND claim_token = ?5
               AND status = 'claimed'
               AND claim_expires_at > ?6",
            params![
                JobStatus::Running.as_str(),
                expires_at,
                now,
                job_id,
                claim_token,
                now_ms
            ],
        )?;
        if affected == 1 {
            return get_job_with_conn(&conn, job_id);
        }
        let job = get_job_with_conn(&conn, job_id)?;
        if job.claim_token != claim_token {
            return Err(DaemonError::ClaimRejected(job_id.to_owned()));
        }
        if matches!(job.status, JobStatus::Claimed | JobStatus::Running)
            && job
                .claim_expires_at_ms
                .map(|expires_at| expires_at <= now_ms)
                .unwrap_or(true)
        {
            return Err(DaemonError::ClaimExpired(job_id.to_owned()));
        }
        Err(DaemonError::InvalidJobState {
            job_id: job.job_id,
            expected: "claimed",
            actual: job.status,
        })
    }

    pub fn requeue_expired_claims(&self) -> Result<usize> {
        self.requeue_expired_claims_at(now_unix_millis())
    }

    fn requeue_expired_claims_at(&self, now_ms: i64) -> Result<usize> {
        let now = now_rfc3339();
        let mut conn = self.connection()?;
        let has_expired = conn.query_row(
            "SELECT EXISTS (
                SELECT 1 FROM jobs
                WHERE status IN ('claimed', 'running')
                  AND (claim_expires_at IS NULL OR claim_expires_at <= ?1)
             )",
            params![now_ms],
            |row| row.get::<_, bool>(0),
        )?;
        if !has_expired {
            return Ok(0);
        }
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let expired_job_ids = {
            let mut stmt = transaction.prepare(
                "SELECT job_id
                 FROM jobs
                 WHERE status IN ('claimed', 'running')
                   AND (claim_expires_at IS NULL OR claim_expires_at <= ?1)
                 ORDER BY job_id ASC",
            )?;
            let rows = stmt
                .query_map(params![now_ms], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows
        };
        let mut requeued = 0;
        for job_id in expired_job_ids {
            let replacement_token = generate_secret_token()?;
            requeued += transaction.execute(
                "UPDATE jobs
                 SET status = 'queued', claim_token = ?1, claim_expires_at = NULL,
                     updated_at = ?2
                 WHERE job_id = ?3
                   AND status IN ('claimed', 'running')
                   AND (claim_expires_at IS NULL OR claim_expires_at <= ?4)",
                params![replacement_token, now, job_id, now_ms],
            )?;
        }
        transaction.commit()?;
        Ok(requeued)
    }

    pub fn complete_job(
        &self,
        job_id: &str,
        claim_token: &str,
        completion: CompleteJob,
    ) -> Result<Job> {
        self.complete_job_at(job_id, claim_token, completion, now_unix_millis())
    }

    fn complete_job_at(
        &self,
        job_id: &str,
        claim_token: &str,
        completion: CompleteJob,
        now_ms: i64,
    ) -> Result<Job> {
        let now = now_rfc3339();
        let (status, result_json, error_json) = match completion {
            CompleteJob::Succeeded { result_json } => (
                JobStatus::Succeeded,
                Some(serde_json::to_string(&result_json)?),
                None,
            ),
            CompleteJob::Failed { error_json } => (
                JobStatus::Failed,
                None,
                Some(serde_json::to_string(&error_json)?),
            ),
        };
        let conn = self.connection()?;
        let affected = conn.execute(
            "UPDATE jobs
             SET status = ?1, result_json = ?2, error_json = ?3, updated_at = ?4,
                 claim_expires_at = NULL
             WHERE job_id = ?5
               AND claim_token = ?6
               AND status IN ('claimed', 'running')
               AND claim_expires_at > ?7",
            params![
                status.as_str(),
                result_json,
                error_json,
                now,
                job_id,
                claim_token,
                now_ms
            ],
        )?;

        if affected == 1 {
            return get_job_with_conn(&conn, job_id);
        }

        explain_active_claim_failure(&conn, job_id, claim_token, now_ms)
    }

    pub fn cancel_job(&self, job_id: &str, reason: Option<Value>) -> Result<Job> {
        let now = now_rfc3339();
        let error_json = serde_json::to_string(&match reason {
            Some(reason) => json!({ "code": "job_canceled", "reason": reason }),
            None => json!({ "code": "job_canceled" }),
        })?;
        let conn = self.connection()?;
        let affected = conn.execute(
            "UPDATE jobs
             SET status = ?1, result_json = NULL, error_json = ?2, updated_at = ?3,
                 claim_expires_at = NULL
             WHERE job_id = ?4 AND status IN ('queued', 'claimed', 'running')",
            params![JobStatus::Canceled.as_str(), error_json, now, job_id],
        )?;
        if affected == 1 {
            let job = get_job_with_conn(&conn, job_id)?;
            let _ = native_host::cleanup_visible_attachment_bundles_for_request(
                self.home_dir(),
                &job.request_json,
            );
            return Ok(job);
        }
        let job = get_job_with_conn(&conn, job_id)?;
        Err(DaemonError::InvalidJobState {
            job_id: job_id.to_owned(),
            expected: "queued, claimed, or running",
            actual: job.status,
        })
    }

    pub(crate) fn active_request_jsons(&self) -> Result<Vec<Value>> {
        let conn = self.connection()?;
        let mut statement = conn.prepare(
            "SELECT request_json
             FROM jobs
             WHERE status IN ('queued', 'claimed', 'running')",
        )?;
        let requests = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|request| {
                let request = request?;
                serde_json::from_str(&request).map_err(to_sql_error)
            })
            .collect::<std::result::Result<Vec<Value>, _>>()?;
        Ok(requests)
    }

    fn initialize(&self) -> Result<()> {
        let mut conn = self.connection()?;
        let had_task_keys_table = sqlite_table_exists(&conn, "job_task_keys")?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY NOT NULL,
                claim_token TEXT NOT NULL,
                execution_backend TEXT NOT NULL DEFAULT 'legacy_extension' CHECK (
                    execution_backend IN ('legacy_extension', 'playwright')
                ),
                profile_id TEXT CHECK (
                    profile_id IS NULL OR length(profile_id) BETWEEN 1 AND 128
                ),
                provider TEXT NOT NULL,
                action TEXT NOT NULL,
                status TEXT NOT NULL CHECK (
                    status IN (
                        'queued',
                        'claimed',
                        'running',
                        'succeeded',
                        'failed',
                        'canceled',
                        'timed_out'
                    )
                ),
                request_json TEXT NOT NULL,
                result_json TEXT,
                error_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                claim_expires_at INTEGER,
                summary_task_id TEXT CHECK (
                    summary_task_id IS NULL OR length(summary_task_id) <= 256
                ),
                summary_project_name TEXT CHECK (
                    summary_project_name IS NULL OR length(summary_project_name) <= 256
                ),
                summary_chat_name TEXT CHECK (
                    summary_chat_name IS NULL OR length(summary_chat_name) <= 256
                ),
                summary_idempotency_key TEXT CHECK (
                    summary_idempotency_key IS NULL OR length(summary_idempotency_key) <= 256
                )
             );
             CREATE TABLE IF NOT EXISTS job_task_keys (
                job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                task_id TEXT NOT NULL CHECK (length(task_id) BETWEEN 1 AND 256),
                PRIMARY KEY (job_id, task_id)
             );",
        )?;
        let needs_claim_lease_migration = !sqlite_column_exists(&conn, "jobs", "claim_expires_at")?
            || conn.query_row(
                "SELECT EXISTS (
                        SELECT 1 FROM jobs
                        WHERE status IN ('claimed', 'running')
                          AND claim_expires_at IS NULL
                     )",
                [],
                |row| row.get::<_, bool>(0),
            )?;
        if needs_claim_lease_migration {
            let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !sqlite_column_exists(&transaction, "jobs", "claim_expires_at")? {
                transaction.execute("ALTER TABLE jobs ADD COLUMN claim_expires_at INTEGER", [])?;
            }
            transaction.execute(
                "UPDATE jobs
                 SET status = 'queued', claim_token = lower(hex(randomblob(32))),
                     updated_at = ?1
                 WHERE status IN ('claimed', 'running') AND claim_expires_at IS NULL",
                params![now_rfc3339()],
            )?;
            transaction.commit()?;
        }

        let summary_columns = [
            (
                "summary_task_id",
                "TEXT CHECK (summary_task_id IS NULL OR length(summary_task_id) <= 256)",
            ),
            (
                "summary_project_name",
                "TEXT CHECK (summary_project_name IS NULL OR length(summary_project_name) <= 256)",
            ),
            (
                "summary_chat_name",
                "TEXT CHECK (summary_chat_name IS NULL OR length(summary_chat_name) <= 256)",
            ),
            (
                "summary_idempotency_key",
                "TEXT CHECK (summary_idempotency_key IS NULL OR length(summary_idempotency_key) <= 256)",
            ),
        ];
        let needs_summary_migration =
            summary_columns
                .iter()
                .try_fold(false, |missing, (column, _)| -> Result<bool> {
                    Ok(missing || !sqlite_column_exists(&conn, "jobs", column)?)
                })?;
        if needs_summary_migration || !had_task_keys_table {
            let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for (column, definition) in summary_columns {
                if !sqlite_column_exists(&transaction, "jobs", column)? {
                    transaction.execute(
                        &format!("ALTER TABLE jobs ADD COLUMN {column} {definition}"),
                        [],
                    )?;
                }
            }
            backfill_summary_metadata(&transaction)?;
            transaction.commit()?;
        }
        let needs_backend_migration = !sqlite_column_exists(&conn, "jobs", "execution_backend")?
            || !sqlite_column_exists(&conn, "jobs", "profile_id")?;
        if needs_backend_migration {
            let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if !sqlite_column_exists(&transaction, "jobs", "execution_backend")? {
                transaction.execute(
                    "ALTER TABLE jobs ADD COLUMN execution_backend TEXT NOT NULL
                        DEFAULT 'legacy_extension'
                        CHECK (execution_backend IN ('legacy_extension', 'playwright'))",
                    [],
                )?;
            }
            if !sqlite_column_exists(&transaction, "jobs", "profile_id")? {
                transaction.execute(
                    "ALTER TABLE jobs ADD COLUMN profile_id TEXT
                        CHECK (profile_id IS NULL OR length(profile_id) BETWEEN 1 AND 128)",
                    [],
                )?;
            }
            transaction.execute(
                "UPDATE jobs
                 SET execution_backend = 'legacy_extension', profile_id = NULL
                 WHERE execution_backend IS NULL
                    OR execution_backend = ''
                    OR execution_backend = 'legacy_extension'",
                [],
            )?;
            transaction.commit()?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS jobs_status_created_at_idx
                ON jobs(status, created_at);
             CREATE INDEX IF NOT EXISTS jobs_provider_action_idx
                ON jobs(provider, action);
             CREATE INDEX IF NOT EXISTS jobs_claim_expires_at_idx
                ON jobs(claim_expires_at);
             CREATE INDEX IF NOT EXISTS jobs_backend_profile_status_fifo_idx
                ON jobs(execution_backend, profile_id, status, created_at, job_id);
             CREATE INDEX IF NOT EXISTS job_task_keys_task_id_idx
                ON job_task_keys(task_id, job_id);",
        )?;
        restrict_file_permissions(&self.database_path)?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        let conn = Connection::open(&self.database_path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(conn)
    }
}

#[derive(Debug, Clone)]
struct HttpState {
    store: JobStore,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    protocol: &'static str,
    daemon_protocol: &'static str,
    version: &'static str,
    native_protocol: &'static str,
    status: &'static str,
    ready: bool,
    home_dir: String,
}

#[derive(Debug, Serialize)]
struct ReadyResponse {
    #[serde(flatten)]
    health: HealthResponse,
    ready_proof_protocol: &'static str,
    ready_challenge: String,
    ready_proof: String,
}

#[derive(Debug, Deserialize)]
struct ReadyQuery {
    challenge: String,
}

#[derive(Debug, Deserialize)]
struct CreateJobRequest {
    provider: String,
    action: String,
    request_json: Value,
    execution_backend: Option<ExecutionBackend>,
    profile_id: Option<String>,
    job_id: Option<String>,
    claim_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimJobRequest {
    claim_token: String,
}

#[derive(Debug, Deserialize)]
struct ClaimLifecycleRequest {
    claim_token: String,
}

#[derive(Debug, Deserialize)]
struct CompleteJobRequest {
    claim_token: String,
    result_json: Option<Value>,
    error_json: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
struct CancelJobRequest {
    reason: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ListJobsQuery {
    status: Option<JobStatus>,
    execution_backend: Option<ExecutionBackend>,
    profile_id: Option<String>,
    provider: Option<String>,
    task_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ClaimNextQuery {
    execution_backend: Option<ExecutionBackend>,
    profile_id: Option<String>,
    provider: Option<String>,
    action: Option<String>,
}

#[derive(Debug, Serialize)]
struct ClaimNextResponse {
    job: Option<JobWithClaimToken>,
}

#[derive(Debug)]
struct ApiError(DaemonError);

impl From<DaemonError> for ApiError {
    fn from(error: DaemonError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            DaemonError::InvalidInput(_)
            | DaemonError::NonLoopbackBind(_)
            | DaemonError::InvalidStatus(_) => StatusCode::BAD_REQUEST,
            DaemonError::ControlAuthMissing => StatusCode::UNAUTHORIZED,
            DaemonError::JobNotFound(_) => StatusCode::NOT_FOUND,
            DaemonError::ClaimRejected(_) | DaemonError::ControlAuthRejected => {
                StatusCode::FORBIDDEN
            }
            DaemonError::ClaimExpired(_) | DaemonError::InvalidJobState { .. } => {
                StatusCode::CONFLICT
            }
            DaemonError::BridgeBusy => StatusCode::CONFLICT,
            DaemonError::Io(_)
            | DaemonError::Random(_)
            | DaemonError::Sqlite(_)
            | DaemonError::Json(_)
            | DaemonError::MissingHome => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(json!({
            "error": {
                "message": self.0.to_string()
            }
        }));
        (status, body).into_response()
    }
}

type ApiResult<T> = std::result::Result<Json<T>, ApiError>;

pub fn http_router(store: JobStore) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/ready", get(ready_handler))
        .route("/jobs", post(create_job_handler).get(list_jobs_handler))
        .route("/jobs/:job_id", get(get_job_handler))
        .route("/jobs/:job_id/claim", post(claim_job_handler))
        .route("/jobs/:job_id/complete", post(complete_job_handler))
        .route("/control/jobs/claim-next", post(claim_next_job_handler))
        .route("/control/jobs/:job_id/running", post(mark_running_handler))
        .route("/control/jobs/:job_id/renew", post(renew_claim_handler))
        .route("/control/jobs/:job_id/cancel", post(cancel_job_handler))
        .with_state(HttpState { store })
}

pub async fn serve_http(store: JobStore, host: IpAddr, port: u16) -> Result<()> {
    validate_loopback_host(host)?;
    let listener = TcpListener::bind(SocketAddr::new(host, port)).await?;
    serve_http_listener(store, listener).await
}

pub fn validate_loopback_host(host: IpAddr) -> Result<()> {
    if !host.is_loopback() {
        return Err(DaemonError::NonLoopbackBind(host));
    }
    Ok(())
}

pub async fn serve_http_listener(store: JobStore, listener: TcpListener) -> Result<()> {
    axum::serve(listener, http_router(store))
        .await
        .map_err(DaemonError::Io)
}

async fn health_handler(State(state): State<HttpState>) -> Json<HealthResponse> {
    Json(health_response(&state.store))
}

async fn ready_handler(
    State(state): State<HttpState>,
    query: std::result::Result<Query<ReadyQuery>, QueryRejection>,
) -> ApiResult<ReadyResponse> {
    let Query(query) = query.map_err(query_rejection_to_api_error)?;
    validate_ready_challenge(&query.challenge)?;
    let health = health_response(&state.store);
    let ready_proof = daemon_ready_proof(&state.store, &query.challenge, &health.home_dir)?;
    Ok(Json(ReadyResponse {
        health,
        ready_proof_protocol: DAEMON_READY_PROOF_PROTOCOL,
        ready_challenge: query.challenge,
        ready_proof,
    }))
}

fn health_response(store: &JobStore) -> HealthResponse {
    HealthResponse {
        protocol: DAEMON_PROTOCOL,
        daemon_protocol: DAEMON_PROTOCOL,
        version: env!("CARGO_PKG_VERSION"),
        native_protocol: native_host::NATIVE_PROTOCOL,
        status: "ok",
        ready: true,
        home_dir: store.home_dir().to_string_lossy().into_owned(),
    }
}

async fn create_job_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    payload: std::result::Result<Json<CreateJobRequest>, JsonRejection>,
) -> ApiResult<JobWithClaimToken> {
    require_control_auth(&state.store, &headers)?;
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    let mut input = CreateJob::new(payload.provider, payload.action, payload.request_json);
    if let Some(execution_backend) = payload.execution_backend {
        input.execution_backend = execution_backend;
    }
    input.profile_id = payload.profile_id;
    input.job_id = payload.job_id;
    input.claim_token = payload.claim_token;
    let job = state.store.create_job(input)?;
    Ok(Json(job.with_claim_token()))
}

async fn list_jobs_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    query: std::result::Result<Query<ListJobsQuery>, QueryRejection>,
) -> ApiResult<Vec<JobView>> {
    require_control_auth(&state.store, &headers)?;
    let Query(query) = query.map_err(query_rejection_to_api_error)?;
    let jobs = state.store.list_jobs(ListJobs {
        status: query.status,
        execution_backend: query.execution_backend,
        profile_id: query.profile_id,
        provider: query.provider,
        task_id: query.task_id,
        limit: query.limit,
    })?;
    Ok(Json(jobs.iter().map(Job::public_view).collect()))
}

async fn get_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    headers: HeaderMap,
) -> ApiResult<JobView> {
    require_control_auth(&state.store, &headers)?;
    let job = state.store.get_job(&job_id)?;
    Ok(Json(job.public_view()))
}

async fn claim_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    headers: HeaderMap,
    payload: std::result::Result<Json<ClaimJobRequest>, JsonRejection>,
) -> ApiResult<JobView> {
    require_control_auth(&state.store, &headers)?;
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    let job = state.store.claim_job(&job_id, &payload.claim_token)?;
    Ok(Json(job.public_view()))
}

async fn complete_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    headers: HeaderMap,
    payload: std::result::Result<Json<CompleteJobRequest>, JsonRejection>,
) -> ApiResult<JobView> {
    require_control_auth(&state.store, &headers)?;
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    let completion = match (payload.result_json, payload.error_json) {
        (Some(result_json), None) => CompleteJob::Succeeded { result_json },
        (None, Some(error_json)) => CompleteJob::Failed { error_json },
        _ => {
            return Err(DaemonError::InvalidInput(
                "pass exactly one of result_json or error_json".to_owned(),
            )
            .into())
        }
    };
    let job = state
        .store
        .complete_job(&job_id, &payload.claim_token, completion)?;
    Ok(Json(job.public_view()))
}

async fn claim_next_job_handler(
    State(state): State<HttpState>,
    headers: HeaderMap,
    query: std::result::Result<Query<ClaimNextQuery>, QueryRejection>,
) -> ApiResult<ClaimNextResponse> {
    require_control_auth(&state.store, &headers)?;
    let Query(query) = query.map_err(query_rejection_to_api_error)?;
    let job = state
        .store
        .claim_next_job_with_scope(
            ClaimNextJob {
                provider: query.provider,
                action: query.action,
            },
            query
                .execution_backend
                .unwrap_or(ExecutionBackend::LegacyExtension),
            query.profile_id,
        )?
        .map(|job| job.with_claim_token());
    Ok(Json(ClaimNextResponse { job }))
}

async fn mark_running_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    headers: HeaderMap,
    payload: std::result::Result<Json<ClaimLifecycleRequest>, JsonRejection>,
) -> ApiResult<JobView> {
    require_control_auth(&state.store, &headers)?;
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    Ok(Json(
        state
            .store
            .mark_running(&job_id, &payload.claim_token)?
            .public_view(),
    ))
}

async fn renew_claim_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    headers: HeaderMap,
    payload: std::result::Result<Json<ClaimLifecycleRequest>, JsonRejection>,
) -> ApiResult<JobView> {
    require_control_auth(&state.store, &headers)?;
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    Ok(Json(
        state
            .store
            .renew_claim(&job_id, &payload.claim_token)?
            .public_view(),
    ))
}

async fn cancel_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    headers: HeaderMap,
    payload: Bytes,
) -> ApiResult<JobView> {
    require_control_auth(&state.store, &headers)?;
    let payload = if payload.is_empty() {
        CancelJobRequest::default()
    } else {
        serde_json::from_slice(&payload).map_err(|error| {
            DaemonError::InvalidInput(format!("request body must be valid JSON: {error}"))
        })?
    };
    Ok(Json(
        state
            .store
            .cancel_job(&job_id, payload.reason)?
            .public_view(),
    ))
}

fn json_rejection_to_api_error(error: JsonRejection) -> ApiError {
    DaemonError::InvalidInput(format!("request body must be valid JSON: {error}")).into()
}

fn query_rejection_to_api_error(error: QueryRejection) -> ApiError {
    DaemonError::InvalidInput(format!("query parameters are invalid: {error}")).into()
}

pub fn default_home_dir() -> Result<PathBuf> {
    if let Some(home) = nonempty_os_env("TOKENLESS_HOME") {
        return Ok(PathBuf::from(home));
    }
    if let Some(home) = nonempty_os_env("HOME") {
        return Ok(PathBuf::from(home).join(".tokenless"));
    }
    Err(DaemonError::MissingHome)
}

fn ensure_tokenless_home(home_dir: &Path) -> Result<()> {
    fs::create_dir_all(home_dir)?;
    restrict_dir_permissions(home_dir)?;
    Ok(())
}

fn ensure_control_token(path: &Path) -> Result<()> {
    match read_control_token(path) {
        Ok(token) if !token.is_empty() => {
            restrict_file_permissions(path)?;
            return Ok(());
        }
        Ok(_) => {}
        Err(DaemonError::Io(error)) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let token = generate_secret_token()?;
    match create_control_token_file(path, &token) {
        Ok(()) => Ok(()),
        Err(DaemonError::Io(error)) if error.kind() == ErrorKind::AlreadyExists => {
            restrict_file_permissions(path)?;
            let existing = read_control_token(path)?;
            if existing.is_empty() {
                return Err(DaemonError::InvalidInput(format!(
                    "{} is empty",
                    path.display()
                )));
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn create_control_token_file(path: &Path, token: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    open_token_file_with_secure_mode(&mut options);
    let mut file = options.open(path)?;
    file.write_all(token.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    restrict_file_permissions(path)?;
    Ok(())
}

fn read_control_token(path: &Path) -> Result<String> {
    Ok(fs::read_to_string(path)?.trim().to_owned())
}

#[cfg(unix)]
fn open_token_file_with_secure_mode(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn open_token_file_with_secure_mode(_options: &mut OpenOptions) {}

fn generate_secret_token() -> Result<String> {
    let mut bytes = [0u8; SECRET_TOKEN_BYTES];
    getrandom::getrandom(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn require_control_auth(
    store: &JobStore,
    headers: &HeaderMap,
) -> std::result::Result<(), ApiError> {
    let header_value = headers
        .get(header::AUTHORIZATION)
        .ok_or(DaemonError::ControlAuthMissing)?;
    let header_value = header_value
        .to_str()
        .map_err(|_| DaemonError::ControlAuthRejected)?;
    let token = header_value
        .strip_prefix("Bearer ")
        .ok_or(DaemonError::ControlAuthRejected)?;
    let expected = store.control_token()?;
    if constant_time_eq(token.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(DaemonError::ControlAuthRejected.into())
    }
}

pub fn daemon_ready_proof_message(challenge: &str, canonical_home: &str) -> Result<Vec<u8>> {
    validate_ready_challenge(challenge)?;
    let fields = [
        DAEMON_READY_PROOF_PROTOCOL,
        challenge,
        DAEMON_PROTOCOL,
        native_host::NATIVE_PROTOCOL,
        canonical_home,
    ];
    let total_capacity = fields
        .iter()
        .map(|field| 4_usize.saturating_add(field.len()))
        .fold(0_usize, usize::saturating_add);
    let mut message = Vec::with_capacity(total_capacity);
    for field in fields {
        let length = u32::try_from(field.len()).map_err(|_| {
            DaemonError::InvalidInput("ready proof field exceeds u32 byte length".to_owned())
        })?;
        message.extend_from_slice(&length.to_be_bytes());
        message.extend_from_slice(field.as_bytes());
    }
    Ok(message)
}

fn daemon_ready_proof(store: &JobStore, challenge: &str, canonical_home: &str) -> Result<String> {
    let token = store.control_token()?;
    let message = daemon_ready_proof_message(challenge, canonical_home)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(|_| {
        DaemonError::InvalidInput("daemon token cannot initialize ready proof".to_owned())
    })?;
    mac.update(&message);
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn validate_ready_challenge(challenge: &str) -> Result<()> {
    if challenge.len() != READY_CHALLENGE_BASE64URL_CHARS {
        return Err(DaemonError::InvalidInput(format!(
            "challenge must be canonical unpadded base64url encoding of {READY_CHALLENGE_BYTES} bytes"
        )));
    }
    let decoded = URL_SAFE_NO_PAD.decode(challenge).map_err(|_| {
        DaemonError::InvalidInput(format!(
            "challenge must be canonical unpadded base64url encoding of {READY_CHALLENGE_BYTES} bytes"
        ))
    })?;
    if decoded.len() != READY_CHALLENGE_BYTES || URL_SAFE_NO_PAD.encode(&decoded) != challenge {
        return Err(DaemonError::InvalidInput(format!(
            "challenge must be canonical unpadded base64url encoding of {READY_CHALLENGE_BYTES} bytes"
        )));
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut diff = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        diff |= left.get(index).copied().unwrap_or_default() as usize
            ^ right.get(index).copied().unwrap_or_default() as usize;
    }
    diff == 0
}

fn normalize_nonempty(value: String, field: &'static str) -> Result<String> {
    let trimmed = value.trim().to_owned();
    if trimmed.is_empty() {
        return Err(DaemonError::InvalidInput(format!(
            "{field} must be a nonempty string"
        )));
    }
    Ok(trimmed)
}

fn normalize_summary_filter(value: String, field: &'static str) -> Result<String> {
    let normalized = normalize_nonempty(value, field)?;
    if normalized.chars().count() > SUMMARY_SCALAR_CHARS {
        return Err(DaemonError::InvalidInput(format!(
            "{field} must be at most {SUMMARY_SCALAR_CHARS} characters"
        )));
    }
    Ok(normalized)
}

fn normalize_profile_id(value: String, field: &'static str) -> Result<String> {
    let normalized = normalize_nonempty(value, field)?;
    if normalized.chars().count() > PROFILE_ID_CHARS {
        return Err(DaemonError::InvalidInput(format!(
            "{field} must be at most {PROFILE_ID_CHARS} characters"
        )));
    }
    Ok(normalized)
}

fn validate_job_backend_profile(
    execution_backend: ExecutionBackend,
    profile_id: Option<String>,
) -> Result<(ExecutionBackend, Option<String>)> {
    let profile_id = profile_id
        .map(|value| normalize_profile_id(value, "profile_id"))
        .transpose()?;
    match (execution_backend, profile_id) {
        (ExecutionBackend::LegacyExtension, None) => Ok((execution_backend, None)),
        (ExecutionBackend::LegacyExtension, Some(_)) => Err(DaemonError::InvalidInput(
            "legacy_extension jobs must not set profile_id".to_owned(),
        )),
        (ExecutionBackend::Playwright, Some(profile_id)) => {
            Ok((execution_backend, Some(profile_id)))
        }
        (ExecutionBackend::Playwright, None) => Err(DaemonError::InvalidInput(
            "playwright jobs require profile_id".to_owned(),
        )),
    }
}

fn validate_filter_backend_profile(
    execution_backend: Option<ExecutionBackend>,
    profile_id: Option<&str>,
) -> Result<()> {
    if matches!(execution_backend, Some(ExecutionBackend::LegacyExtension)) && profile_id.is_some()
    {
        return Err(DaemonError::InvalidInput(
            "legacy_extension filters must not set profile_id".to_owned(),
        ));
    }
    Ok(())
}

fn validate_claim_backend_profile(
    execution_backend: ExecutionBackend,
    profile_id: Option<&str>,
) -> Result<()> {
    match (execution_backend, profile_id) {
        (ExecutionBackend::LegacyExtension, None) => Ok(()),
        (ExecutionBackend::LegacyExtension, Some(_)) => Err(DaemonError::InvalidInput(
            "legacy_extension claims must not set profile_id".to_owned(),
        )),
        (ExecutionBackend::Playwright, Some(_)) => Ok(()),
        (ExecutionBackend::Playwright, None) => Err(DaemonError::InvalidInput(
            "playwright claims require profile_id".to_owned(),
        )),
    }
}

fn bounded_nonempty_summary_value(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(SUMMARY_SCALAR_CHARS).collect())
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    let execution_backend: String = row.get(2)?;
    let status: String = row.get(6)?;
    let request_json: String = row.get(7)?;
    let result_json: Option<String> = row.get(8)?;
    let error_json: Option<String> = row.get(9)?;
    Ok(Job {
        job_id: row.get(0)?,
        claim_token: row.get(1)?,
        execution_backend: ExecutionBackend::from_db(execution_backend).map_err(to_sql_error)?,
        profile_id: row.get(3)?,
        provider: row.get(4)?,
        action: row.get(5)?,
        status: JobStatus::from_db(status).map_err(to_sql_error)?,
        request_json: serde_json::from_str(&request_json).map_err(to_sql_error)?,
        result_json: parse_optional_json(result_json).map_err(to_sql_error)?,
        error_json: parse_optional_json(error_json).map_err(to_sql_error)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        claim_expires_at_ms: row.get(12)?,
    })
}

fn row_to_job_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<JobSummary> {
    let execution_backend: String = row.get(1)?;
    let status: String = row.get(5)?;
    Ok(JobSummary {
        job_id: row.get(0)?,
        execution_backend: ExecutionBackend::from_db(execution_backend).map_err(to_sql_error)?,
        profile_id: row.get(2)?,
        provider: row.get(3)?,
        action: row.get(4)?,
        status: JobStatus::from_db(status).map_err(to_sql_error)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        task_id: row.get(8)?,
        project_name: row.get(9)?,
        chat_name: row.get(10)?,
        idempotency_key: row.get(11)?,
    })
}

fn collect_jobs<F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<Job>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<Job>,
{
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(DaemonError::Sqlite)
}

fn get_job_with_conn(conn: &Connection, job_id: &str) -> Result<Job> {
    let mut stmt = conn.prepare(
        "SELECT
            job_id, claim_token, execution_backend, profile_id,
            provider, action, status, request_json, result_json, error_json,
            created_at, updated_at, claim_expires_at
         FROM jobs
         WHERE job_id = ?1",
    )?;
    stmt.query_row(params![job_id], row_to_job)
        .optional()?
        .ok_or_else(|| DaemonError::JobNotFound(job_id.to_owned()))
}

fn explain_claim_failure(conn: &Connection, job_id: &str, claim_token: &str) -> Result<Job> {
    let job = get_job_with_conn(conn, job_id)?;
    if job.claim_token != claim_token {
        return Err(DaemonError::ClaimRejected(job_id.to_owned()));
    }
    Err(DaemonError::InvalidJobState {
        job_id: job_id.to_owned(),
        expected: "queued",
        actual: job.status,
    })
}

fn explain_active_claim_failure(
    conn: &Connection,
    job_id: &str,
    claim_token: &str,
    now_ms: i64,
) -> Result<Job> {
    let job = get_job_with_conn(conn, job_id)?;
    if job.claim_token != claim_token {
        return Err(DaemonError::ClaimRejected(job_id.to_owned()));
    }
    if matches!(job.status, JobStatus::Claimed | JobStatus::Running)
        && job
            .claim_expires_at_ms
            .map(|expires_at| expires_at <= now_ms)
            .unwrap_or(true)
    {
        return Err(DaemonError::ClaimExpired(job_id.to_owned()));
    }
    Err(DaemonError::InvalidJobState {
        job_id: job_id.to_owned(),
        expected: "claimed or running",
        actual: job.status,
    })
}

fn parse_optional_json(value: Option<String>) -> Result<Option<Value>> {
    value
        .map(|json| serde_json::from_str(&json).map_err(DaemonError::Json))
        .transpose()
}

fn to_sql_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_unix_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn sqlite_column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names.iter().any(|name| name == column))
}

fn sqlite_table_exists(conn: &Connection, table: &str) -> Result<bool> {
    conn.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1
         )",
        params![table],
        |row| row.get(0),
    )
    .map_err(DaemonError::Sqlite)
}

fn backfill_summary_metadata(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    let mut select = transaction.prepare("SELECT job_id, request_json FROM jobs")?;
    let mut rows = select.query([])?;
    while let Some(row) = rows.next()? {
        let job_id: String = row.get(0)?;
        let request_json: String = row.get(1)?;
        let request = serde_json::from_str(&request_json).unwrap_or(Value::Null);
        let summary = RequestSummaryMetadata::from_request(&request);
        transaction.execute(
            "UPDATE jobs
             SET summary_task_id = ?1, summary_project_name = ?2,
                 summary_chat_name = ?3, summary_idempotency_key = ?4
             WHERE job_id = ?5",
            params![
                summary.task_id,
                summary.project_name,
                summary.chat_name,
                summary.idempotency_key,
                job_id,
            ],
        )?;
        transaction.execute(
            "DELETE FROM job_task_keys WHERE job_id = ?1",
            params![job_id],
        )?;
        for task_key in summary.task_keys {
            transaction.execute(
                "INSERT INTO job_task_keys (job_id, task_id) VALUES (?1, ?2)",
                params![job_id, task_key],
            )?;
        }
    }
    Ok(())
}

fn nonempty_os_env(name: &str) -> Option<std::ffi::OsString> {
    env::var_os(name).filter(|value| !value.is_empty())
}

#[cfg(unix)]
fn restrict_dir_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let permissions = fs::Permissions::from_mode(0o700);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_dir_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    if path.exists() {
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn creates_state_under_explicit_home() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();

        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "hello" }),
            ))
            .unwrap();

        assert_eq!(store.home_dir(), fs::canonicalize(tempdir.path()).unwrap());
        assert_eq!(
            store.database_path(),
            fs::canonicalize(tempdir.path())
                .unwrap()
                .join(DATABASE_FILE_NAME)
        );
        assert!(store.database_path().exists());
        assert_eq!(job.status, JobStatus::Queued);
        assert_eq!(job.execution_backend, ExecutionBackend::LegacyExtension);
        assert_eq!(job.profile_id, None);
        assert_eq!(job.provider, "chatgpt");
        assert_eq!(job.action, "submit_and_read");
        assert_eq!(job.request_json, json!({ "prompt": "hello" }));
    }

    #[test]
    fn creates_control_token_file() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();

        let token = store.control_token().unwrap();

        assert_eq!(
            store.control_token_path(),
            fs::canonicalize(tempdir.path())
                .unwrap()
                .join(CONTROL_TOKEN_FILE_NAME)
        );
        assert!(store.control_token_path().exists());
        assert!(!token.is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(store.control_token_path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn lists_gets_claims_and_completes_job() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "write tests" }),
            ))
            .unwrap();

        let listed = store.list_jobs(ListJobs::default()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].job_id, job.job_id);

        let claimed = store.claim_job(&job.job_id, &job.claim_token).unwrap();
        assert_eq!(claimed.status, JobStatus::Claimed);

        let completed = store
            .complete_job(
                &job.job_id,
                &job.claim_token,
                CompleteJob::Succeeded {
                    result_json: json!({ "text": "done" }),
                },
            )
            .unwrap();

        assert_eq!(completed.status, JobStatus::Succeeded);
        assert_eq!(completed.result_json, Some(json!({ "text": "done" })));
        assert_eq!(completed.error_json, None);
    }

    #[test]
    fn exact_task_and_provider_filters_find_jobs_beyond_the_default_scan_window() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let target = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({
                    "taskId": "top-task",
                    "idempotencyKey": "top-idempotency",
                    "requestId": "top-request",
                    "metadata": {
                        "taskId": "metadata-task",
                        "idempotencyKey": "metadata-idempotency",
                    }
                }),
            ))
            .unwrap();
        for index in 0..1_001 {
            store
                .create_job(CreateJob::new(
                    "chatgpt",
                    "submit",
                    json!({ "prompt": format!("filler-{index}") }),
                ))
                .unwrap();
        }
        store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "taskId": "top-task" }),
            ))
            .unwrap();

        for task_id in [
            "top-task",
            "top-idempotency",
            "top-request",
            "metadata-task",
            "metadata-idempotency",
        ] {
            let matches = store
                .list_jobs(ListJobs {
                    provider: Some("chatgpt".to_owned()),
                    task_id: Some(task_id.to_owned()),
                    limit: Some(1),
                    ..ListJobs::default()
                })
                .unwrap();
            assert_eq!(matches.len(), 1, "missing exact task key {task_id}");
            assert_eq!(matches[0].job_id, target.job_id);
        }
    }

    #[test]
    fn summary_query_uses_bounded_scalar_columns_without_loading_payloads() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({
                    "prompt": "private-prompt".repeat(100_000),
                    "taskId": "t".repeat(1_000),
                    "metadata": {
                        "projectName": "p".repeat(1_000),
                        "chatName": "bounded chat",
                    }
                }),
            ))
            .unwrap();
        let conn = Connection::open(store.database_path()).unwrap();
        conn.execute(
            "UPDATE jobs
             SET request_json = 'not-json-private-prompt',
                 result_json = 'not-json-private-result',
                 error_json = 'not-json-private-error'
             WHERE job_id = ?1",
            params![job.job_id],
        )
        .unwrap();

        assert!(matches!(
            store.get_job(&job.job_id),
            Err(DaemonError::Sqlite(_))
        ));
        let summaries = store.list_job_summaries(None).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].job_id, job.job_id);
        assert_eq!(
            summaries[0].task_id.as_ref().unwrap().chars().count(),
            SUMMARY_SCALAR_CHARS
        );
        assert_eq!(
            summaries[0].project_name.as_ref().unwrap().chars().count(),
            SUMMARY_SCALAR_CHARS
        );
        assert_eq!(summaries[0].chat_name.as_deref(), Some("bounded chat"));
    }

    #[test]
    fn public_job_view_does_not_serialize_claim_token() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "keep the token private" }),
            ))
            .unwrap();

        let view_json = serde_json::to_value(job.public_view()).unwrap();
        let claim_json = serde_json::to_value(job.with_claim_token()).unwrap();

        assert!(view_json.get("claim_token").is_none());
        assert_eq!(claim_json["claim_token"], job.claim_token);
        assert_eq!(view_json["execution_backend"], "legacy_extension");
        assert_eq!(view_json["profile_id"], Value::Null);
        assert_eq!(claim_json["execution_backend"], "legacy_extension");
        assert_eq!(claim_json["profile_id"], Value::Null);
    }

    #[test]
    fn validates_create_backend_profile_combinations() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();

        let legacy = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "legacy" }),
            ))
            .unwrap();
        assert_eq!(legacy.execution_backend, ExecutionBackend::LegacyExtension);
        assert_eq!(legacy.profile_id, None);

        let mut playwright_input =
            CreateJob::new("chatgpt", "submit", json!({ "prompt": "managed" }));
        playwright_input.execution_backend = ExecutionBackend::Playwright;
        playwright_input.profile_id = Some("work".to_owned());
        let playwright = store.create_job(playwright_input).unwrap();
        assert_eq!(playwright.execution_backend, ExecutionBackend::Playwright);
        assert_eq!(playwright.profile_id.as_deref(), Some("work"));

        let mut missing_profile =
            CreateJob::new("chatgpt", "submit", json!({ "prompt": "invalid" }));
        missing_profile.execution_backend = ExecutionBackend::Playwright;
        let error = store.create_job(missing_profile).unwrap_err();
        assert!(
            matches!(error, DaemonError::InvalidInput(message) if message.contains("require profile_id"))
        );

        let mut legacy_with_profile =
            CreateJob::new("chatgpt", "submit", json!({ "prompt": "invalid" }));
        legacy_with_profile.profile_id = Some("work".to_owned());
        let error = store.create_job(legacy_with_profile).unwrap_err();
        assert!(
            matches!(error, DaemonError::InvalidInput(message) if message.contains("must not set profile_id"))
        );

        let mut oversized_profile =
            CreateJob::new("chatgpt", "submit", json!({ "prompt": "invalid" }));
        oversized_profile.execution_backend = ExecutionBackend::Playwright;
        oversized_profile.profile_id = Some("p".repeat(PROFILE_ID_CHARS + 1));
        let error = store.create_job(oversized_profile).unwrap_err();
        assert!(matches!(error, DaemonError::InvalidInput(message) if message.contains("at most")));
    }

    #[test]
    fn exact_backend_and_profile_filters_isolate_list_results() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let legacy = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "legacy" }),
            ))
            .unwrap();
        let work = create_playwright_job(&store, "work", "work");
        let personal = create_playwright_job(&store, "personal", "personal");

        let legacy_matches = store
            .list_jobs(ListJobs {
                execution_backend: Some(ExecutionBackend::LegacyExtension),
                ..ListJobs::default()
            })
            .unwrap();
        assert_eq!(legacy_matches.len(), 1);
        assert_eq!(legacy_matches[0].job_id, legacy.job_id);

        let playwright_matches = store
            .list_jobs(ListJobs {
                execution_backend: Some(ExecutionBackend::Playwright),
                ..ListJobs::default()
            })
            .unwrap();
        assert_eq!(playwright_matches.len(), 2);
        assert!(playwright_matches
            .iter()
            .all(|job| job.execution_backend == ExecutionBackend::Playwright));

        let work_matches = store
            .list_jobs(ListJobs {
                profile_id: Some("work".to_owned()),
                ..ListJobs::default()
            })
            .unwrap();
        assert_eq!(work_matches.len(), 1);
        assert_eq!(work_matches[0].job_id, work.job_id);

        let personal_matches = store
            .list_jobs(ListJobs {
                execution_backend: Some(ExecutionBackend::Playwright),
                profile_id: Some("personal".to_owned()),
                ..ListJobs::default()
            })
            .unwrap();
        assert_eq!(personal_matches.len(), 1);
        assert_eq!(personal_matches[0].job_id, personal.job_id);

        let invalid = store.list_jobs(ListJobs {
            execution_backend: Some(ExecutionBackend::LegacyExtension),
            profile_id: Some("work".to_owned()),
            ..ListJobs::default()
        });
        assert!(matches!(invalid, Err(DaemonError::InvalidInput(_))));
    }

    #[test]
    fn rejects_claim_with_wrong_token() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "gemini",
                "submit",
                json!({ "prompt": "hi" }),
            ))
            .unwrap();

        let error = store.claim_job(&job.job_id, "wrong-token").unwrap_err();

        assert!(matches!(error, DaemonError::ClaimRejected(_)));
        assert_eq!(
            store.get_job(&job.job_id).unwrap().status,
            JobStatus::Queued
        );
    }

    #[test]
    fn atomic_claim_allows_only_one_winner() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "race" }),
            ))
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();

        for _ in 0..2 {
            let home = tempdir.path().to_path_buf();
            let job_id = job.job_id.clone();
            let claim_token = job.claim_token.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let store = JobStore::open(home).unwrap();
                barrier.wait();
                store.claim_job(&job_id, &claim_token).is_ok()
            }));
        }

        let success_count = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|claimed| *claimed)
            .count();

        assert_eq!(success_count, 1);
        assert_eq!(
            store.get_job(&job.job_id).unwrap().status,
            JobStatus::Claimed
        );
    }

    #[test]
    fn claim_next_returns_one_queued_job_and_marks_it_claimed() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let first = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "first" }),
            ))
            .unwrap();
        let second = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "second" }),
            ))
            .unwrap();

        let claimed = store
            .claim_next_job(ClaimNextJob::default())
            .unwrap()
            .unwrap();

        assert_eq!(claimed.job_id, first.job_id);
        assert_ne!(claimed.claim_token, first.claim_token);
        assert_eq!(claimed.status, JobStatus::Claimed);
        assert_eq!(
            store.get_job(&first.job_id).unwrap().status,
            JobStatus::Claimed
        );
        assert_eq!(
            store.get_job(&second.job_id).unwrap().status,
            JobStatus::Queued
        );
    }

    #[test]
    fn claim_next_isolates_legacy_and_playwright_backends() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let legacy = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "legacy" }),
            ))
            .unwrap();
        let playwright = create_playwright_job(&store, "work", "managed");

        let legacy_claim = store
            .claim_next_job(ClaimNextJob::default())
            .unwrap()
            .unwrap();
        assert_eq!(legacy_claim.job_id, legacy.job_id);
        assert_eq!(
            legacy_claim.execution_backend,
            ExecutionBackend::LegacyExtension
        );
        assert_eq!(
            store.get_job(&playwright.job_id).unwrap().status,
            JobStatus::Queued
        );

        let playwright_claim = store
            .claim_next_job_with_scope(
                ClaimNextJob::default(),
                ExecutionBackend::Playwright,
                Some("work".to_owned()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(playwright_claim.job_id, playwright.job_id);
        assert_eq!(
            playwright_claim.execution_backend,
            ExecutionBackend::Playwright
        );
        assert_eq!(playwright_claim.profile_id.as_deref(), Some("work"));
    }

    #[test]
    fn claim_next_requires_exact_playwright_profile() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let work = create_playwright_job(&store, "work", "work");
        let personal = create_playwright_job(&store, "personal", "personal");

        let missing_profile = store.claim_next_job_with_scope(
            ClaimNextJob::default(),
            ExecutionBackend::Playwright,
            None,
        );
        assert!(matches!(
            missing_profile,
            Err(DaemonError::InvalidInput(message)) if message.contains("require profile_id")
        ));

        let wrong_profile = store
            .claim_next_job_with_scope(
                ClaimNextJob::default(),
                ExecutionBackend::Playwright,
                Some("other".to_owned()),
            )
            .unwrap();
        assert!(wrong_profile.is_none());

        let personal_claim = store
            .claim_next_job_with_scope(
                ClaimNextJob::default(),
                ExecutionBackend::Playwright,
                Some("personal".to_owned()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(personal_claim.job_id, personal.job_id);
        assert_eq!(personal_claim.profile_id.as_deref(), Some("personal"));
        assert_eq!(
            store.get_job(&work.job_id).unwrap().status,
            JobStatus::Queued
        );
    }

    #[test]
    fn claim_next_returns_none_when_no_queued_job_exists() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();

        let claimed = store.claim_next_job(ClaimNextJob::default()).unwrap();

        assert!(claimed.is_none());
    }

    #[test]
    fn concurrent_claim_next_allows_only_one_winner() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "race next" }),
            ))
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();

        for _ in 0..2 {
            let home = tempdir.path().to_path_buf();
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let store = JobStore::open(home).unwrap();
                barrier.wait();
                store
                    .claim_next_job(ClaimNextJob::default())
                    .unwrap()
                    .map(|job| job.job_id)
            }));
        }

        let claimed_job_ids = handles
            .into_iter()
            .filter_map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(claimed_job_ids, vec![job.job_id.clone()]);
        assert_eq!(
            store.get_job(&job.job_id).unwrap().status,
            JobStatus::Claimed
        );
    }

    #[test]
    fn concurrent_profile_scoped_claim_next_allows_only_one_winner() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = create_playwright_job(&store, "work", "race");
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();

        for _ in 0..2 {
            let home = tempdir.path().to_path_buf();
            let barrier = Arc::clone(&barrier);
            handles.push(thread::spawn(move || {
                let store = JobStore::open(home).unwrap();
                barrier.wait();
                store
                    .claim_next_job_with_scope(
                        ClaimNextJob::default(),
                        ExecutionBackend::Playwright,
                        Some("work".to_owned()),
                    )
                    .unwrap()
                    .map(|job| job.job_id)
            }));
        }

        let claimed_job_ids = handles
            .into_iter()
            .filter_map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(claimed_job_ids, vec![job.job_id.clone()]);
        assert_eq!(
            store.get_job(&job.job_id).unwrap().status,
            JobStatus::Claimed
        );
    }

    #[test]
    fn lease_renewal_expiry_requeue_and_reclaim_reject_stale_completion() {
        let tempdir = tempfile::tempdir().unwrap();
        let store =
            JobStore::open_with_claim_lease(tempdir.path(), std::time::Duration::from_millis(100))
                .unwrap();
        let created = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "lease safety" }),
            ))
            .unwrap();

        let claimed = store
            .claim_next_job_at(ClaimNextJob::default(), 1_000)
            .unwrap()
            .unwrap();
        assert_ne!(claimed.claim_token, created.claim_token);
        assert_eq!(claimed.claim_expires_at_ms, Some(1_100));
        let running = store
            .mark_running_at(&claimed.job_id, &claimed.claim_token, 1_050)
            .unwrap();
        assert_eq!(running.status, JobStatus::Running);
        assert_eq!(running.claim_expires_at_ms, Some(1_150));
        let renewed = store
            .renew_claim_at(&claimed.job_id, &claimed.claim_token, 1_100)
            .unwrap();
        assert_eq!(renewed.claim_expires_at_ms, Some(1_200));

        let expired = store
            .complete_job_at(
                &claimed.job_id,
                &claimed.claim_token,
                CompleteJob::Succeeded {
                    result_json: json!({ "text": "too late" }),
                },
                1_200,
            )
            .unwrap_err();
        assert!(matches!(expired, DaemonError::ClaimExpired(_)));
        assert_eq!(store.requeue_expired_claims_at(1_200).unwrap(), 1);
        assert_eq!(
            store.get_job(&claimed.job_id).unwrap().status,
            JobStatus::Queued
        );

        let reclaimed = store
            .claim_next_job_at(ClaimNextJob::default(), 1_201)
            .unwrap()
            .unwrap();
        assert_ne!(reclaimed.claim_token, claimed.claim_token);
        store
            .mark_running_at(&reclaimed.job_id, &reclaimed.claim_token, 1_202)
            .unwrap();
        let stale = store
            .complete_job_at(
                &claimed.job_id,
                &claimed.claim_token,
                CompleteJob::Succeeded {
                    result_json: json!({ "text": "stale worker" }),
                },
                1_203,
            )
            .unwrap_err();
        assert!(matches!(stale, DaemonError::ClaimRejected(_)));
        let completed = store
            .complete_job_at(
                &reclaimed.job_id,
                &reclaimed.claim_token,
                CompleteJob::Succeeded {
                    result_json: json!({ "text": "current worker" }),
                },
                1_204,
            )
            .unwrap();
        assert_eq!(completed.status, JobStatus::Succeeded);
    }

    #[test]
    fn migrates_existing_database_and_requeues_unleased_claim() {
        let tempdir = tempfile::tempdir().unwrap();
        let database_path = tempdir.path().join(DATABASE_FILE_NAME);
        let conn = Connection::open(&database_path).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE jobs (
                job_id TEXT PRIMARY KEY NOT NULL,
                claim_token TEXT NOT NULL,
                provider TEXT NOT NULL,
                action TEXT NOT NULL,
                status TEXT NOT NULL,
                request_json TEXT NOT NULL,
                result_json TEXT,
                error_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             INSERT INTO jobs VALUES (
                'legacy-job', 'legacy-token', 'chatgpt', 'submit', 'claimed',
                '{"taskId":"legacy-task","metadata":{"projectName":"Legacy"}}',
                NULL, NULL, '2025-01-01T00:00:00.000Z',
                '2025-01-01T00:00:00.000Z'
             );"#,
        )
        .unwrap();
        drop(conn);

        let store = JobStore::open(tempdir.path()).unwrap();
        let migrated = store.get_job("legacy-job").unwrap();
        assert_eq!(migrated.status, JobStatus::Queued);
        assert_eq!(
            migrated.execution_backend,
            ExecutionBackend::LegacyExtension
        );
        assert_eq!(migrated.profile_id, None);
        assert_ne!(migrated.claim_token, "legacy-token");
        assert_eq!(migrated.claim_expires_at_ms, None);
        let conn = Connection::open(store.database_path()).unwrap();
        assert!(sqlite_column_exists(&conn, "jobs", "claim_expires_at").unwrap());
        assert!(sqlite_column_exists(&conn, "jobs", "execution_backend").unwrap());
        assert!(sqlite_column_exists(&conn, "jobs", "profile_id").unwrap());
        assert!(sqlite_column_exists(&conn, "jobs", "summary_task_id").unwrap());
        assert!(sqlite_table_exists(&conn, "job_task_keys").unwrap());
        let (execution_backend, profile_id): (String, Option<String>) = conn
            .query_row(
                "SELECT execution_backend, profile_id FROM jobs WHERE job_id = 'legacy-job'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(execution_backend, "legacy_extension");
        assert_eq!(profile_id, None);
        let filtered = store
            .list_jobs(ListJobs {
                provider: Some("chatgpt".to_owned()),
                task_id: Some("legacy-task".to_owned()),
                ..ListJobs::default()
            })
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].job_id, "legacy-job");
        let summary = store.list_job_summaries(None).unwrap().remove(0);
        assert_eq!(summary.task_id.as_deref(), Some("legacy-task"));
        assert_eq!(summary.project_name.as_deref(), Some("Legacy"));
    }

    #[test]
    fn cancel_and_completion_race_has_one_terminal_winner() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let created = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "race cancellation" }),
            ))
            .unwrap();
        let claimed = store
            .claim_next_job(ClaimNextJob::default())
            .unwrap()
            .unwrap();
        store
            .mark_running(&claimed.job_id, &claimed.claim_token)
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let complete_home = tempdir.path().to_path_buf();
        let complete_job_id = created.job_id.clone();
        let claim_token = claimed.claim_token.clone();
        let complete_barrier = Arc::clone(&barrier);
        let complete = thread::spawn(move || {
            let store = JobStore::open(complete_home).unwrap();
            complete_barrier.wait();
            store
                .complete_job(
                    &complete_job_id,
                    &claim_token,
                    CompleteJob::Succeeded {
                        result_json: json!({ "text": "done" }),
                    },
                )
                .is_ok()
        });
        let cancel_home = tempdir.path().to_path_buf();
        let cancel_job_id = created.job_id.clone();
        let cancel_barrier = Arc::clone(&barrier);
        let cancel = thread::spawn(move || {
            let store = JobStore::open(cancel_home).unwrap();
            cancel_barrier.wait();
            store
                .cancel_job(&cancel_job_id, Some(json!({ "source": "test" })))
                .is_ok()
        });

        let winner_count = [complete.join().unwrap(), cancel.join().unwrap()]
            .into_iter()
            .filter(|won| *won)
            .count();
        assert_eq!(winner_count, 1);
        assert!(matches!(
            store.get_job(&created.job_id).unwrap().status,
            JobStatus::Succeeded | JobStatus::Canceled
        ));
    }

    #[test]
    fn canceling_queued_job_cleans_staged_visible_attachment_bundle() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let bundle_path = store.home_dir().join("attachments").join("cancel-bundle");
        fs::create_dir_all(&bundle_path).unwrap();
        fs::write(bundle_path.join("cancel-attachment.bin"), b"cancel me").unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({
                    "prompt": "cancel this upload",
                    "attachments": [{
                        "protocol": native_host::VISIBLE_ATTACHMENT_PROTOCOL,
                        "bundleId": "cancel-bundle",
                        "attachmentId": "cancel-attachment",
                        "name": "cancel.txt",
                        "type": "text/plain",
                        "size": 9,
                        "sha256": "0".repeat(64),
                    }],
                }),
            ))
            .unwrap();

        let canceled = store
            .cancel_job(&job.job_id, Some(json!({ "source": "test" })))
            .unwrap();

        assert_eq!(canceled.status, JobStatus::Canceled);
        assert!(!bundle_path.exists());
    }

    #[tokio::test]
    async fn serve_http_rejects_non_loopback_host() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let host = "0.0.0.0".parse().unwrap();

        let error = serve_http(store, host, 0).await.unwrap_err();

        assert!(matches!(error, DaemonError::NonLoopbackBind(rejected) if rejected == host));
    }

    #[test]
    fn ready_proof_canonicalization_matches_cross_runtime_vector() {
        let challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let message = daemon_ready_proof_message(challenge, "/tmp/tokenless").unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&message),
            "AAAAH3Rva2VubGVzcy5kYWVtb24tcmVhZHktcHJvb2YudjEAAAArQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQAAABN0b2tlbmxlc3MuZGFlbW9uLnYxAAAAE3Rva2VubGVzcy5uYXRpdmUudjEAAAAOL3RtcC90b2tlbmxlc3M"
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(b"test-token").unwrap();
        mac.update(&message);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()),
            "vYXXNpnWk4LydLbkLQct3XG73zkiHyWOCWt5A3Skd_c"
        );
    }

    #[tokio::test]
    async fn ready_requires_challenge_and_returns_token_bound_hmac_proof() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let token = store.control_token().unwrap();
        let canonical_home = store.home_dir().to_string_lossy().into_owned();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server_store = store.clone();
        let server = tokio::spawn(async move {
            serve_http_listener(server_store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let health: Value = client
            .get(format!("{base_url}/health"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["ready"], true);
        assert!(health.get("ready_proof").is_none());
        assert!(health.get("ready_challenge").is_none());

        let first_challenge = URL_SAFE_NO_PAD.encode([7_u8; READY_CHALLENGE_BYTES]);
        let first: Value = client
            .get(format!("{base_url}/ready?challenge={first_challenge}"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(first["protocol"], DAEMON_PROTOCOL);
        assert_eq!(first["daemon_protocol"], DAEMON_PROTOCOL);
        assert_eq!(first["native_protocol"], native_host::NATIVE_PROTOCOL);
        assert_eq!(first["home_dir"], canonical_home);
        assert_eq!(first["ready"], true);
        assert_eq!(first["ready_proof_protocol"], DAEMON_READY_PROOF_PROTOCOL);
        assert_eq!(first["ready_challenge"], first_challenge);
        let first_proof = first["ready_proof"].as_str().unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(first_proof).unwrap().len(), 32);

        let message = daemon_ready_proof_message(&first_challenge, &canonical_home).unwrap();
        let mut expected_fields = [
            DAEMON_READY_PROOF_PROTOCOL,
            first_challenge.as_str(),
            DAEMON_PROTOCOL,
            native_host::NATIVE_PROTOCOL,
            canonical_home.as_str(),
        ]
        .into_iter();
        let mut offset = 0;
        while offset < message.len() {
            let length =
                u32::from_be_bytes(message[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            let field = std::str::from_utf8(&message[offset..offset + length]).unwrap();
            assert_eq!(Some(field), expected_fields.next());
            offset += length;
        }
        assert!(expected_fields.next().is_none());

        let mut expected_mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).unwrap();
        expected_mac.update(&message);
        assert_eq!(
            first_proof,
            URL_SAFE_NO_PAD.encode(expected_mac.finalize().into_bytes())
        );
        assert!(!serde_json::to_string(&first).unwrap().contains(&token));

        let second_challenge = URL_SAFE_NO_PAD.encode([8_u8; READY_CHALLENGE_BYTES]);
        let second: Value = client
            .get(format!("{base_url}/ready?challenge={second_challenge}"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(second["ready_challenge"], second_challenge);
        assert_ne!(second["ready_proof"], first["ready_proof"]);

        let invalid_paths = vec![
            "/ready".to_owned(),
            "/ready?challenge=not-base64!".to_owned(),
            format!(
                "/ready?challenge={}",
                URL_SAFE_NO_PAD.encode([9_u8; READY_CHALLENGE_BYTES - 1])
            ),
            format!("/ready?challenge={first_challenge}%3D"),
        ];
        for invalid_path in invalid_paths {
            let response = client
                .get(format!("{base_url}{invalid_path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let body = response.text().await.unwrap();
            assert!(!body.contains("ready_proof"));
            assert!(!body.contains(&token));
        }

        server.abort();
    }

    #[tokio::test]
    async fn http_create_list_get_claim_and_complete_flow_uses_temp_home() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let health: Value = client
            .get(format!("{base_url}/health"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["protocol"], "tokenless.daemon.v1");
        assert_eq!(health["daemon_protocol"], "tokenless.daemon.v1");
        assert_eq!(health["native_protocol"], "tokenless.native.v1");
        assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(health["status"], "ok");
        assert_eq!(health["ready"], true);
        assert_eq!(
            health["home_dir"],
            fs::canonicalize(tempdir.path())
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );

        let created: Value = client
            .post(format!("{base_url}/jobs"))
            .bearer_auth(&control_token)
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit_and_read",
                "request_json": {
                    "prompt": "hello from http",
                    "metadata": { "taskId": "http-task" }
                }
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let job_id = created["job_id"].as_str().unwrap().to_owned();
        let claim_token = created["claim_token"].as_str().unwrap().to_owned();
        assert_eq!(created["status"], "queued");
        assert_eq!(created["execution_backend"], "legacy_extension");
        assert_eq!(created["profile_id"], Value::Null);

        let listed: Value = client
            .get(format!("{base_url}/jobs"))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["job_id"], job_id);
        assert!(listed[0].get("claim_token").is_none());

        let filtered: Value = client
            .get(format!(
                "{base_url}/jobs?provider=chatgpt&task_id=http-task&limit=1"
            ))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(filtered.as_array().unwrap().len(), 1);
        assert_eq!(filtered[0]["job_id"], job_id);

        let got: Value = client
            .get(format!("{base_url}/jobs/{job_id}"))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(got["job_id"], job_id);
        assert!(got.get("claim_token").is_none());

        let rejected_claim = client
            .post(format!("{base_url}/jobs/{job_id}/claim"))
            .bearer_auth(&control_token)
            .json(&json!({ "claim_token": "wrong-token" }))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected_claim.status(), StatusCode::FORBIDDEN);

        let claimed: Value = client
            .post(format!("{base_url}/jobs/{job_id}/claim"))
            .bearer_auth(&control_token)
            .json(&json!({ "claim_token": claim_token }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(claimed["status"], "claimed");
        assert!(claimed.get("claim_token").is_none());

        let completed: Value = client
            .post(format!("{base_url}/jobs/{job_id}/complete"))
            .bearer_auth(&control_token)
            .json(&json!({
                "claim_token": claim_token,
                "result_json": { "text": "done" }
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(completed["status"], "succeeded");
        assert_eq!(completed["result_json"], json!({ "text": "done" }));
        assert!(completed.get("claim_token").is_none());
        assert!(tempdir.path().join(DATABASE_FILE_NAME).exists());

        server.abort();
    }

    #[tokio::test]
    async fn http_create_validation_and_exact_backend_profile_filters() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let missing_profile = client
            .post(format!("{base_url}/jobs"))
            .bearer_auth(&control_token)
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit",
                "execution_backend": "playwright",
                "request_json": { "prompt": "missing profile" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(missing_profile.status(), StatusCode::BAD_REQUEST);

        let legacy_with_profile = client
            .post(format!("{base_url}/jobs"))
            .bearer_auth(&control_token)
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit",
                "profile_id": "work",
                "request_json": { "prompt": "bad legacy profile" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(legacy_with_profile.status(), StatusCode::BAD_REQUEST);

        let unknown_backend = client
            .post(format!("{base_url}/jobs"))
            .bearer_auth(&control_token)
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit",
                "execution_backend": "selenium",
                "request_json": { "prompt": "unknown backend" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(unknown_backend.status(), StatusCode::BAD_REQUEST);

        let created: Value = client
            .post(format!("{base_url}/jobs"))
            .bearer_auth(&control_token)
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit",
                "execution_backend": "playwright",
                "profile_id": "work",
                "request_json": { "prompt": "managed profile" }
            }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(created["execution_backend"], "playwright");
        assert_eq!(created["profile_id"], "work");

        let filtered: Value = client
            .get(format!(
                "{base_url}/jobs?execution_backend=playwright&profile_id=work"
            ))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(filtered.as_array().unwrap().len(), 1);
        assert_eq!(filtered[0]["job_id"], created["job_id"]);
        assert_eq!(filtered[0]["profile_id"], "work");

        let invalid_filter = client
            .get(format!(
                "{base_url}/jobs?execution_backend=legacy_extension&profile_id=work"
            ))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap();
        assert_eq!(invalid_filter.status(), StatusCode::BAD_REQUEST);

        server.abort();
    }

    #[tokio::test]
    async fn every_job_http_endpoint_requires_bearer_auth() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "must remain queued" }),
            ))
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server_store = store.clone();
        let server = tokio::spawn(async move {
            serve_http_listener(server_store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let create = client
            .post(format!("{base_url}/jobs"))
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit",
                "request_json": { "prompt": "unauthorized" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(create.status(), StatusCode::UNAUTHORIZED);

        let list = client
            .get(format!("{base_url}/jobs"))
            .bearer_auth("wrong-token")
            .send()
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::FORBIDDEN);

        let get = client
            .get(format!("{base_url}/jobs/{}", job.job_id))
            .send()
            .await
            .unwrap();
        assert_eq!(get.status(), StatusCode::UNAUTHORIZED);

        let claim = client
            .post(format!("{base_url}/jobs/{}/claim", job.job_id))
            .json(&json!({ "claim_token": job.claim_token }))
            .send()
            .await
            .unwrap();
        assert_eq!(claim.status(), StatusCode::UNAUTHORIZED);

        let complete = client
            .post(format!("{base_url}/jobs/{}/complete", job.job_id))
            .json(&json!({
                "claim_token": job.claim_token,
                "result_json": { "text": "unauthorized" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(complete.status(), StatusCode::UNAUTHORIZED);
        let running = client
            .post(format!("{base_url}/control/jobs/{}/running", job.job_id))
            .json(&json!({ "claim_token": job.claim_token }))
            .send()
            .await
            .unwrap();
        assert_eq!(running.status(), StatusCode::UNAUTHORIZED);
        let renew = client
            .post(format!("{base_url}/control/jobs/{}/renew", job.job_id))
            .json(&json!({ "claim_token": job.claim_token }))
            .send()
            .await
            .unwrap();
        assert_eq!(renew.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            store.get_job(&job.job_id).unwrap().status,
            JobStatus::Queued
        );

        server.abort();
    }

    #[tokio::test]
    async fn http_control_claim_next_requires_bearer_token() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let missing = client
            .post(format!("{base_url}/control/jobs/claim-next"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
        assert_json_content_type(&missing);
        let missing_body: Value = missing.json().await.unwrap();
        assert_eq!(missing_body["error"]["message"], "missing bearer token");

        let wrong = client
            .post(format!("{base_url}/control/jobs/claim-next"))
            .bearer_auth("wrong-token")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
        assert_json_content_type(&wrong);
        let wrong_body: Value = wrong.json().await.unwrap();
        assert_eq!(wrong_body["error"]["message"], "invalid bearer token");

        server.abort();
    }

    #[tokio::test]
    async fn http_control_cancel_requires_auth_and_records_structured_reason() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit",
                json!({ "prompt": "cancel me" }),
            ))
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server_store = store.clone();
        let server = tokio::spawn(async move {
            serve_http_listener(server_store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let unauthorized = client
            .post(format!("{base_url}/control/jobs/{}/cancel", job.job_id))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            store.get_job(&job.job_id).unwrap().status,
            JobStatus::Queued
        );

        let canceled: Value = client
            .post(format!("{base_url}/control/jobs/{}/cancel", job.job_id))
            .bearer_auth(control_token)
            .json(&json!({ "reason": { "code": "client_timeout" } }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(canceled["status"], "canceled");
        assert_eq!(canceled["error_json"]["code"], "job_canceled");
        assert_eq!(canceled["error_json"]["reason"]["code"], "client_timeout");

        let repeated = client
            .post(format!("{base_url}/control/jobs/{}/cancel", job.job_id))
            .bearer_auth(store.control_token().unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(repeated.status(), StatusCode::CONFLICT);
        server.abort();
    }

    #[tokio::test]
    async fn http_control_claim_next_returns_token_bearing_job() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let first = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "first via http" }),
            ))
            .unwrap();
        let second = store
            .create_job(CreateJob::new(
                "claude",
                "submit",
                json!({ "prompt": "second via http" }),
            ))
            .unwrap();
        let server_store = store.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(server_store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response: Value = client
            .post(format!(
                "{base_url}/control/jobs/claim-next?provider=chatgpt&action=submit_and_read"
            ))
            .bearer_auth(control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(response["job"]["job_id"], first.job_id);
        assert_ne!(response["job"]["claim_token"], first.claim_token);
        assert_eq!(response["job"]["status"], "claimed");
        assert_eq!(
            store.get_job(&first.job_id).unwrap().status,
            JobStatus::Claimed
        );
        assert_eq!(
            store.get_job(&second.job_id).unwrap().status,
            JobStatus::Queued
        );

        server.abort();
    }

    #[tokio::test]
    async fn http_control_claim_next_mark_running_and_renew_are_profile_scoped() {
        let tempdir = tempfile::tempdir().unwrap();
        let store =
            JobStore::open_with_claim_lease(tempdir.path(), std::time::Duration::from_secs(60))
                .unwrap();
        let control_token = store.control_token().unwrap();
        let work = create_playwright_job(&store, "work", "work");
        let personal = create_playwright_job(&store, "personal", "personal");
        let server_store = store.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(server_store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let missing_profile = client
            .post(format!(
                "{base_url}/control/jobs/claim-next?execution_backend=playwright"
            ))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap();
        assert_eq!(missing_profile.status(), StatusCode::BAD_REQUEST);

        let claimed: Value = client
            .post(format!(
                "{base_url}/control/jobs/claim-next?execution_backend=playwright&profile_id=personal"
            ))
            .bearer_auth(&control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(claimed["job"]["job_id"], personal.job_id);
        assert_eq!(claimed["job"]["execution_backend"], "playwright");
        assert_eq!(claimed["job"]["profile_id"], "personal");
        let claim_token = claimed["job"]["claim_token"].as_str().unwrap();
        assert_eq!(
            store.get_job(&work.job_id).unwrap().status,
            JobStatus::Queued
        );

        let running: Value = client
            .post(format!(
                "{base_url}/control/jobs/{}/running",
                personal.job_id
            ))
            .bearer_auth(&control_token)
            .json(&json!({ "claim_token": claim_token }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(running["status"], "running");
        assert_eq!(running["profile_id"], "personal");

        let renewed: Value = client
            .post(format!("{base_url}/control/jobs/{}/renew", personal.job_id))
            .bearer_auth(&control_token)
            .json(&json!({ "claim_token": claim_token }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(renewed["status"], "running");

        let wrong_token = client
            .post(format!("{base_url}/control/jobs/{}/renew", personal.job_id))
            .bearer_auth(&control_token)
            .json(&json!({ "claim_token": "wrong-token" }))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_token.status(), StatusCode::FORBIDDEN);

        server.abort();
    }

    #[tokio::test]
    async fn http_control_claim_next_returns_null_job_when_queue_is_empty() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response: Value = client
            .post(format!("{base_url}/control/jobs/claim-next"))
            .bearer_auth(control_token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(response, json!({ "job": null }));

        server.abort();
    }

    #[tokio::test]
    async fn http_control_concurrent_claim_next_cannot_claim_same_job() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let job = store
            .create_job(CreateJob::new(
                "chatgpt",
                "submit_and_read",
                json!({ "prompt": "http race next" }),
            ))
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();
        let first_request = client
            .post(format!("{base_url}/control/jobs/claim-next"))
            .bearer_auth(&control_token)
            .send();
        let second_request = client
            .post(format!("{base_url}/control/jobs/claim-next"))
            .bearer_auth(&control_token)
            .send();

        let (first_response, second_response) = tokio::join!(first_request, second_request);
        let first_body: Value = first_response
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let second_body: Value = second_response
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let claimed_count = [first_body, second_body]
            .into_iter()
            .filter(|body| body["job"]["job_id"] == job.job_id)
            .count();

        assert_eq!(claimed_count, 1);

        server.abort();
    }

    #[tokio::test]
    async fn http_malformed_json_body_returns_json_error() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{base_url}/jobs"))
            .bearer_auth(control_token)
            .header("content-type", "application/json")
            .body(r#"{"provider":"chatgpt","#)
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_json_content_type(&response);
        let body: Value = response.json().await.unwrap();
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains("request body must be valid JSON"));

        server.abort();
    }

    #[tokio::test]
    async fn http_invalid_query_returns_json_error() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let control_token = store.control_token().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{base_url}/jobs?status=not_a_status"))
            .bearer_auth(control_token)
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_json_content_type(&response);
        let body: Value = response.json().await.unwrap();
        let message = body["error"]["message"].as_str().unwrap();
        assert!(message.contains("query parameters are invalid"));

        server.abort();
    }

    fn create_playwright_job(store: &JobStore, profile_id: &str, prompt: &str) -> Job {
        let mut input = CreateJob::new("chatgpt", "submit", json!({ "prompt": prompt }));
        input.execution_backend = ExecutionBackend::Playwright;
        input.profile_id = Some(profile_id.to_owned());
        store.create_job(input).unwrap()
    }

    fn assert_json_content_type(response: &reqwest::Response) {
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(content_type.starts_with("application/json"));
    }
}
