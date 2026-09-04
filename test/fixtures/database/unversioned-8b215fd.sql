-- Schema captured from the real JobStore, ManagedProfileRegistry, and
-- AgentContextStore at commit 8b215fd. No provider data is included.
CREATE TABLE api_response_ledger (
  response_id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  execution_mode TEXT NOT NULL,
  transcript_json TEXT NOT NULL
);
CREATE TABLE dashboard_daily_capability_metrics (
  day TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('browser', 'direct', 'unknown')),
  capability_id TEXT NOT NULL,
  succeeded_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  canceled_jobs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, profile_id, provider, execution_mode, capability_id)
);
CREATE TABLE dashboard_daily_metrics (
  day TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('browser', 'direct', 'unknown')),
  succeeded_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  canceled_jobs INTEGER NOT NULL DEFAULT 0,
  estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
  visible_characters INTEGER NOT NULL DEFAULT 0,
  measured_responses INTEGER NOT NULL DEFAULT 0,
  measured_jobs INTEGER NOT NULL DEFAULT 0,
  first_measured_at TEXT,
  last_measured_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, profile_id, provider, execution_mode)
);
CREATE TABLE harness_context_records (
  chat_id TEXT PRIMARY KEY NOT NULL,
  data_json TEXT NOT NULL
);
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  blocker_json TEXT,
  provider_submitted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE output_savings_events (
  job_id TEXT NOT NULL,
  response_request_id TEXT NOT NULL,
  estimated_output_tokens INTEGER NOT NULL,
  visible_characters INTEGER NOT NULL,
  estimator TEXT NOT NULL,
  estimator_revision TEXT NOT NULL,
  basis TEXT NOT NULL,
  source_text_sha256 TEXT NOT NULL,
  measured_at TEXT NOT NULL,
  PRIMARY KEY (job_id, response_request_id, estimator_revision)
);
CREATE TABLE provider_projects (
  provider TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  PRIMARY KEY (provider, profile_id, resource_id)
);
CREATE TABLE provider_statuses (
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status_json TEXT NOT NULL,
  PRIMARY KEY (profile_id, provider)
);
CREATE TABLE provider_task_conversations (
  provider TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_resource_id TEXT,
  canonical_url TEXT NOT NULL,
  PRIMARY KEY (provider, profile_id, task_id)
);
