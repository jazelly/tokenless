import type { DatabaseSync } from 'node:sqlite'

import {
  applyInitialMigration,
  INITIAL_MIGRATION_VERSION,
} from './migrations/0001-initial.js'

const MIGRATIONS = [
  { version: INITIAL_MIGRATION_VERSION, apply: applyInitialMigration },
] as const

export const CURRENT_DATABASE_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version

export type DatabaseMigrationErrorCode =
  | 'database_schema_too_new'
  | 'database_schema_incompatible'
  | 'database_schema_invalid'

export class DatabaseMigrationError extends Error {
  readonly retryable = false

  constructor(
    readonly code: DatabaseMigrationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DatabaseMigrationError'
  }
}

export function migrateDatabase(database: DatabaseSync) {
  const initialVersion = readDatabaseVersion(database)
  rejectUnsupportedVersion(initialVersion)
  if (initialVersion === CURRENT_DATABASE_SCHEMA_VERSION) return

  database.exec('BEGIN IMMEDIATE')
  try {
    let version = readDatabaseVersion(database)
    rejectUnsupportedVersion(version)

    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue
      if (migration.version !== version + 1) {
        throw new DatabaseMigrationError(
          'database_schema_incompatible',
          `Tokenless API database migration sequence cannot advance from version ${version} to ${migration.version}.`,
        )
      }
      try {
        migration.apply(database)
      } catch (error) {
        throw new DatabaseMigrationError(
          'database_schema_incompatible',
          'Tokenless API database schema is incompatible with the supported schema.',
          error,
        )
      }
      database.exec(`PRAGMA user_version = ${migration.version}`)
      version = migration.version
    }
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the original migration failure if rollback also fails.
    }
    throw error
  }
}

function readDatabaseVersion(database: DatabaseSync) {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  const version = Number(row?.user_version ?? 0)
  if (!Number.isInteger(version) || version < 0) {
    throw new DatabaseMigrationError(
      'database_schema_invalid',
      'Tokenless API database has an invalid schema version.',
    )
  }
  return version
}

function rejectUnsupportedVersion(version: number) {
  if (version > CURRENT_DATABASE_SCHEMA_VERSION) {
    throw new DatabaseMigrationError(
      'database_schema_too_new',
      `Tokenless API database schema version ${version} is newer than the supported version ${CURRENT_DATABASE_SCHEMA_VERSION}. Upgrade Tokenless API before opening this database.`,
    )
  }
}
