import type { DatabaseSync } from 'node:sqlite'

export const INITIAL_MIGRATION_VERSION = 1

const INITIAL_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'running',
        'waiting_for_user',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
    request_json TEXT NOT NULL,
    result_json TEXT,
    error_json TEXT,
    blocker_json TEXT,
    provider_submitted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS provider_projects (
    provider TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    name TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    PRIMARY KEY (provider, profile_id, resource_id)
  );
  CREATE TABLE IF NOT EXISTS provider_task_conversations (
    provider TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    project_resource_id TEXT,
    canonical_url TEXT NOT NULL,
    PRIMARY KEY (provider, profile_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS api_response_ledger (
    response_id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    execution_mode TEXT NOT NULL,
    transcript_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS output_savings_events (
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
  CREATE TABLE IF NOT EXISTS dashboard_daily_metrics (
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
  CREATE TABLE IF NOT EXISTS dashboard_daily_capability_metrics (
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
  CREATE TABLE IF NOT EXISTS provider_statuses (
    profile_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    status_json TEXT NOT NULL,
    PRIMARY KEY (profile_id, provider)
  );
  CREATE TABLE IF NOT EXISTS harness_context_records (
    chat_id TEXT PRIMARY KEY NOT NULL,
    data_json TEXT NOT NULL
  );
`

const REQUIRED_SCHEMA_QUERIES = [
  `SELECT job_id, profile_id, provider, status, request_json, result_json, error_json,
          blocker_json, provider_submitted_at, created_at, updated_at
   FROM jobs LIMIT 0`,
  `SELECT provider, profile_id, resource_id, name, canonical_url
   FROM provider_projects LIMIT 0`,
  `SELECT provider, profile_id, task_id, project_resource_id, canonical_url
   FROM provider_task_conversations LIMIT 0`,
  `SELECT response_id, provider, model, execution_mode, transcript_json
   FROM api_response_ledger LIMIT 0`,
  `SELECT job_id, response_request_id, estimated_output_tokens, visible_characters,
          estimator, estimator_revision, basis, source_text_sha256, measured_at
   FROM output_savings_events LIMIT 0`,
  `SELECT day, profile_id, provider, execution_mode, succeeded_jobs, failed_jobs,
          canceled_jobs, estimated_output_tokens, visible_characters, measured_responses,
          measured_jobs, first_measured_at, last_measured_at, updated_at
   FROM dashboard_daily_metrics LIMIT 0`,
  `SELECT day, profile_id, provider, execution_mode, capability_id, succeeded_jobs,
          failed_jobs, canceled_jobs, updated_at
   FROM dashboard_daily_capability_metrics LIMIT 0`,
  `SELECT profile_id, provider, status_json
   FROM provider_statuses LIMIT 0`,
  `SELECT chat_id, data_json
   FROM harness_context_records LIMIT 0`,
] as const

export function applyInitialMigration(database: DatabaseSync) {
  database.exec(INITIAL_MIGRATION_SQL)
  for (const query of REQUIRED_SCHEMA_QUERIES) database.prepare(query).all()
}
