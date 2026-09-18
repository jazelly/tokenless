import type { DatabaseSync } from 'node:sqlite'

export function applyRateLimitAttempts(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE provider_rate_limit_attempts (
      job_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      action_index INTEGER NOT NULL,
      request_type TEXT NOT NULL,
      attempted_at TEXT NOT NULL,
      PRIMARY KEY (job_id, provider, action_index)
    );
    CREATE INDEX provider_rate_limit_attempts_window ON provider_rate_limit_attempts (provider, attempted_at);
  `)
}
