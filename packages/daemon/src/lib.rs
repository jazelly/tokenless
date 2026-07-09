use axum::{
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
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fmt;
use std::fs;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use tokio::net::TcpListener;
use uuid::Uuid;

const DATABASE_FILE_NAME: &str = "tokenless.sqlite3";
const CONTROL_TOKEN_FILE_NAME: &str = "daemon.token";
const SECRET_TOKEN_BYTES: usize = 32;

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

#[derive(Debug, Clone)]
pub struct Job {
    pub job_id: String,
    pub claim_token: String,
    pub provider: String,
    pub action: String,
    pub status: JobStatus,
    pub request_json: Value,
    pub result_json: Option<Value>,
    pub error_json: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

impl Job {
    pub fn public_view(&self) -> JobView {
        JobView {
            job_id: self.job_id.clone(),
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
    pub limit: Option<usize>,
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
}

impl JobStore {
    pub fn open(home_dir: impl Into<PathBuf>) -> Result<Self> {
        let home_dir = home_dir.into();
        ensure_tokenless_home(&home_dir)?;
        let database_path = home_dir.join(DATABASE_FILE_NAME);
        let control_token_path = home_dir.join(CONTROL_TOKEN_FILE_NAME);
        ensure_control_token(&control_token_path)?;
        let store = Self {
            home_dir,
            database_path,
            control_token_path,
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
        let request_json = serde_json::to_string(&input.request_json)?;
        let conn = self.connection()?;

        conn.execute(
            "INSERT INTO jobs (
                job_id, claim_token, provider, action, status, request_json,
                result_json, error_json, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?7)",
            params![
                job_id,
                claim_token,
                provider,
                action,
                JobStatus::Queued.as_str(),
                request_json,
                now
            ],
        )?;

        self.get_job(&job_id)
    }

    pub fn list_jobs(&self, query: ListJobs) -> Result<Vec<Job>> {
        let conn = self.connection()?;
        let limit = query.limit.unwrap_or(100).clamp(1, 1000) as i64;
        match query.status {
            Some(status) => {
                let mut stmt = conn.prepare(
                    "SELECT
                        job_id, claim_token, provider, action, status, request_json,
                        result_json, error_json, created_at, updated_at
                    FROM jobs
                    WHERE status = ?1
                    ORDER BY created_at DESC, job_id DESC
                    LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![status.as_str(), limit], row_to_job)?;
                collect_jobs(rows)
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT
                        job_id, claim_token, provider, action, status, request_json,
                        result_json, error_json, created_at, updated_at
                    FROM jobs
                    ORDER BY created_at DESC, job_id DESC
                    LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit], row_to_job)?;
                collect_jobs(rows)
            }
        }
    }

    pub fn get_job(&self, job_id: &str) -> Result<Job> {
        let conn = self.connection()?;
        get_job_with_conn(&conn, job_id)
    }

    pub fn claim_job(&self, job_id: &str, claim_token: &str) -> Result<Job> {
        let now = now_rfc3339();
        let conn = self.connection()?;
        let affected = conn.execute(
            "UPDATE jobs
             SET status = ?1, updated_at = ?2
             WHERE job_id = ?3 AND claim_token = ?4 AND status = ?5",
            params![
                JobStatus::Claimed.as_str(),
                now,
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
        let provider = query
            .provider
            .map(|value| normalize_nonempty(value, "provider"))
            .transpose()?;
        let action = query
            .action
            .map(|value| normalize_nonempty(value, "action"))
            .transpose()?;
        let now = now_rfc3339();
        let conn = self.connection()?;
        let mut stmt = conn.prepare(
            "UPDATE jobs
             SET status = ?1, updated_at = ?2
             WHERE job_id = (
                SELECT job_id
                FROM jobs
                WHERE status = ?3
                  AND (?4 IS NULL OR provider = ?4)
                  AND (?5 IS NULL OR action = ?5)
                ORDER BY created_at ASC, job_id ASC
                LIMIT 1
             )
             RETURNING
                job_id, claim_token, provider, action, status, request_json,
                result_json, error_json, created_at, updated_at",
        )?;

        stmt.query_row(
            params![
                JobStatus::Claimed.as_str(),
                now,
                JobStatus::Queued.as_str(),
                provider.as_deref(),
                action.as_deref(),
            ],
            row_to_job,
        )
        .optional()
        .map_err(DaemonError::Sqlite)
    }

    pub fn complete_job(
        &self,
        job_id: &str,
        claim_token: &str,
        completion: CompleteJob,
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
             SET status = ?1, result_json = ?2, error_json = ?3, updated_at = ?4
             WHERE job_id = ?5
               AND claim_token = ?6
               AND status IN ('claimed', 'running')",
            params![
                status.as_str(),
                result_json,
                error_json,
                now,
                job_id,
                claim_token
            ],
        )?;

        if affected == 1 {
            return get_job_with_conn(&conn, job_id);
        }

        explain_completion_failure(&conn, job_id, claim_token)
    }

    fn initialize(&self) -> Result<()> {
        let conn = self.connection()?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS jobs (
                job_id TEXT PRIMARY KEY NOT NULL,
                claim_token TEXT NOT NULL,
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
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS jobs_status_created_at_idx
                ON jobs(status, created_at);
             CREATE INDEX IF NOT EXISTS jobs_provider_action_idx
                ON jobs(provider, action);",
        )?;
        restrict_file_permissions(&self.database_path)?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection> {
        let conn = Connection::open(&self.database_path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(conn)
    }
}

#[derive(Debug, Clone)]
struct HttpState {
    store: JobStore,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    ready: bool,
}

#[derive(Debug, Deserialize)]
struct CreateJobRequest {
    provider: String,
    action: String,
    request_json: Value,
    job_id: Option<String>,
    claim_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimJobRequest {
    claim_token: String,
}

#[derive(Debug, Deserialize)]
struct CompleteJobRequest {
    claim_token: String,
    result_json: Option<Value>,
    error_json: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ListJobsQuery {
    status: Option<JobStatus>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct ClaimNextQuery {
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
            DaemonError::InvalidJobState { .. } => StatusCode::CONFLICT,
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
        .route("/ready", get(health_handler))
        .route("/jobs", post(create_job_handler).get(list_jobs_handler))
        .route("/jobs/:job_id", get(get_job_handler))
        .route("/jobs/:job_id/claim", post(claim_job_handler))
        .route("/jobs/:job_id/complete", post(complete_job_handler))
        .route("/control/jobs/claim-next", post(claim_next_job_handler))
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

async fn health_handler() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        ready: true,
    })
}

async fn create_job_handler(
    State(state): State<HttpState>,
    payload: std::result::Result<Json<CreateJobRequest>, JsonRejection>,
) -> ApiResult<JobWithClaimToken> {
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    let mut input = CreateJob::new(payload.provider, payload.action, payload.request_json);
    input.job_id = payload.job_id;
    input.claim_token = payload.claim_token;
    let job = state.store.create_job(input)?;
    Ok(Json(job.with_claim_token()))
}

async fn list_jobs_handler(
    State(state): State<HttpState>,
    query: std::result::Result<Query<ListJobsQuery>, QueryRejection>,
) -> ApiResult<Vec<JobView>> {
    let Query(query) = query.map_err(query_rejection_to_api_error)?;
    let jobs = state.store.list_jobs(ListJobs {
        status: query.status,
        limit: query.limit,
    })?;
    Ok(Json(jobs.iter().map(Job::public_view).collect()))
}

async fn get_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
) -> ApiResult<JobView> {
    let job = state.store.get_job(&job_id)?;
    Ok(Json(job.public_view()))
}

async fn claim_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    payload: std::result::Result<Json<ClaimJobRequest>, JsonRejection>,
) -> ApiResult<JobView> {
    let Json(payload) = payload.map_err(json_rejection_to_api_error)?;
    let job = state.store.claim_job(&job_id, &payload.claim_token)?;
    Ok(Json(job.public_view()))
}

async fn complete_job_handler(
    State(state): State<HttpState>,
    AxumPath(job_id): AxumPath<String>,
    payload: std::result::Result<Json<CompleteJobRequest>, JsonRejection>,
) -> ApiResult<JobView> {
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
        .claim_next_job(ClaimNextJob {
            provider: query.provider,
            action: query.action,
        })?
        .map(|job| job.with_claim_token());
    Ok(Json(ClaimNextResponse { job }))
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

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<Job> {
    let status: String = row.get(4)?;
    let request_json: String = row.get(5)?;
    let result_json: Option<String> = row.get(6)?;
    let error_json: Option<String> = row.get(7)?;
    Ok(Job {
        job_id: row.get(0)?,
        claim_token: row.get(1)?,
        provider: row.get(2)?,
        action: row.get(3)?,
        status: JobStatus::from_db(status).map_err(to_sql_error)?,
        request_json: serde_json::from_str(&request_json).map_err(to_sql_error)?,
        result_json: parse_optional_json(result_json).map_err(to_sql_error)?,
        error_json: parse_optional_json(error_json).map_err(to_sql_error)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
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
            job_id, claim_token, provider, action, status, request_json,
            result_json, error_json, created_at, updated_at
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

fn explain_completion_failure(conn: &Connection, job_id: &str, claim_token: &str) -> Result<Job> {
    let job = get_job_with_conn(conn, job_id)?;
    if job.claim_token != claim_token {
        return Err(DaemonError::ClaimRejected(job_id.to_owned()));
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

        assert_eq!(store.home_dir(), tempdir.path());
        assert_eq!(
            store.database_path(),
            tempdir.path().join(DATABASE_FILE_NAME)
        );
        assert!(store.database_path().exists());
        assert_eq!(job.status, JobStatus::Queued);
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
            tempdir.path().join(CONTROL_TOKEN_FILE_NAME)
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
        assert_eq!(claimed.claim_token, first.claim_token);
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

    #[tokio::test]
    async fn serve_http_rejects_non_loopback_host() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
        let host = "0.0.0.0".parse().unwrap();

        let error = serve_http(store, host, 0).await.unwrap_err();

        assert!(matches!(error, DaemonError::NonLoopbackBind(rejected) if rejected == host));
    }

    #[tokio::test]
    async fn http_create_list_get_claim_and_complete_flow_uses_temp_home() {
        let tempdir = tempfile::tempdir().unwrap();
        let store = JobStore::open(tempdir.path()).unwrap();
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
        assert_eq!(health, json!({ "status": "ok", "ready": true }));

        let created: Value = client
            .post(format!("{base_url}/jobs"))
            .json(&json!({
                "provider": "chatgpt",
                "action": "submit_and_read",
                "request_json": { "prompt": "hello from http" }
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

        let listed: Value = client
            .get(format!("{base_url}/jobs"))
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

        let got: Value = client
            .get(format!("{base_url}/jobs/{job_id}"))
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
            .json(&json!({ "claim_token": "wrong-token" }))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected_claim.status(), StatusCode::FORBIDDEN);

        let claimed: Value = client
            .post(format!("{base_url}/jobs/{job_id}/claim"))
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
        assert_eq!(response["job"]["claim_token"], first.claim_token);
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response = client
            .post(format!("{base_url}/jobs"))
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
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            serve_http_listener(store, listener).await.unwrap();
        });
        let client = reqwest::Client::new();

        let response = client
            .get(format!("{base_url}/jobs?status=not_a_status"))
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

    fn assert_json_content_type(response: &reqwest::Response) {
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(content_type.starts_with("application/json"));
    }
}
