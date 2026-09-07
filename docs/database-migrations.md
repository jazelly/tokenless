# Database migrations

Tokenless API and Tokenless Harness share `$TOKENLESS_HOME/tokenless.sqlite3`.
Schema migrations ship inside the `tokenless` npm package and run locally when a database entry point opens that file; publishing or pushing code does not directly modify users' databases.

## Initial migration

`packages/shared/src/database/migrations/0001-initial.ts` defines the nine current tables.
The daemon job store, provider profile registry, and Harness context store use the same migration runner and SQLite `PRAGMA user_version`.

- An empty database receives the initial schema and version `1`.
- The current unversioned schema from commit `8b215fd` is adopted without replacing tables or changing their records; unrelated legacy tables remain untouched.
- An unversioned table missing required columns fails explicitly instead of being silently repaired or marked current.
- A database newer than the installed package is rejected; automatic downgrade is not supported.

Releases predating this mechanism do not enforce the version check; do not run an older release against an upgraded database.

Schema changes and the version update commit in one SQLite transaction. A migration failure rolls both back and prevents that database entry point from opening.
This transaction is database write coordination, not a chat ownership lock.

Migration does not change the daemon's existing startup behavior: interrupted jobs are marked failed, and missing Dashboard aggregates are initialized by the job store.
It does not migrate `config.json`, browser profiles, credentials, or provider-side conversations.

## Adding a schema change

1. Keep released migrations unchanged and add the next numbered migration module.
2. Register it in `packages/shared/src/database/migrate.ts`, after the previous migration.
3. Prove the affected existing schema and data upgrade through the real SQLite boundary, then run the installed-package check.
4. Include the migration in the normal changeset and npm release; users apply it when the upgraded application next opens their database.

Migration modules are compiled with the shared package, copied into the CLI distribution, and bundled into the Harness distribution.
There is no separate SQL download, migration service, retry loop, or automatic data deletion.

## Verification

```bash
npm run build
node --test --test-concurrency=1 test/database-migrations.integration.test.mjs
node --test --test-name-pattern='pure JS CLI packs' test/package-contract.test.mjs
```

The unversioned test schema was captured from the actual `8b215fd` stores; it contains no user or provider data.
The package check installs a local npm tarball and starts its daemon against a temporary home, checking both authenticated HTTP access and schema version `1`.
