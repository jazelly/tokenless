# Local live Web UI fixtures

Real-provider Web UI E2E selection is composed from local fixtures instead of environment variables.

1. Copy `test/fixtures/live-web-ui.example.json` to `test/fixtures/local/web-ui.json`.
2. Set the local Tokenless home, explicitly selected setup-managed profile, and provider.
3. Add startup fixtures and compose them into cases and suites as needed.
4. Run `npm run test:e2e:web-provider -- --fixture smoke` or `--fixture startup-matrix`.

The whole `test/fixtures/local/` directory is gitignored. These files may contain local paths and non-secret selection identifiers only. Never place credentials, cookies, tokens, browser storage, headers, or copied profile data in a fixture.
