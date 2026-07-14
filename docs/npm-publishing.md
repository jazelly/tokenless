# npm publishing

Tokenless publishes seven public npm packages as one exact-version set:

- `tokenless`
- `tokenless-native-darwin-arm64`
- `tokenless-native-darwin-x64`
- `tokenless-native-linux-arm64`
- `tokenless-native-linux-x64`
- `tokenless-native-win32-arm64`
- `tokenless-native-win32-x64`

The release workflow publishes all six native packages on matching GitHub-hosted
runners before it publishes the universal CLI. It never publishes without the
tracked `.changeset/publish-pending.json` release marker.

## Normal release flow

1. Add a changeset with `npm run changeset` and select `tokenless`.
2. Merge the change containing that changeset into `main`.
3. `Prepare npm release` opens or updates a version pull request. Its version
   script consumes the changeset, synchronizes the CLI, native manifests, Rust
   crate, lockfiles, and writes `.changeset/publish-pending.json`.
4. Merge that version pull request.
5. `Publish npm packages` verifies the marker, publishes the six native
   packages, then publishes `tokenless`.
6. After every package is confirmed published, the workflow removes the marker
   in a second commit. A retry is safe because already-published versions are
   skipped.

## GitHub setup required from a repository administrator

1. In **Settings → Actions → General**, set workflow permissions to
   **Read and write permissions** and allow GitHub Actions to create pull
   requests.
2. If `main` is protected, allow `github-actions[bot]` to create the marker
   cleanup commit, or grant this workflow an equivalent bypass. The workflow
   otherwise cannot perform its required second commit.
3. Do not rename `.github/workflows/publish-npm.yml` after configuring npm
   Trusted Publishing; npm binds trust to the exact workflow filename.

## npm authentication

Use npm **Trusted Publishing** as the steady-state authentication method. It
uses GitHub Actions OIDC, needs the workflow's `id-token: write` permission,
and does not need a long-lived GitHub secret.

To manage trusted publishers from a terminal, first use npm 11.15 or later and
authenticate interactively with 2FA enabled. The command is:

```bash
npm trust github <package-name> \
  --repo jazelly/tokenless \
  --file publish-npm.yml \
  --allow-publish \
  --yes
```

For each of the seven packages, configure **Settings → Trusted publishing** on
npmjs.com with:

- publisher: GitHub Actions;
- owner: `jazelly`;
- repository: `tokenless`;
- workflow filename: `publish-npm.yml`;
- allowed action: `npm publish`.

The universal `tokenless` package already exists on npm. The six native package
names must be bootstrapped before their Trusted Publishing settings can be
created. For the first release, create a granular npm token with publishing
access and any required 2FA bypass, store it as the optional GitHub Actions
secret `NPM_TOKEN`, and let the workflow use it only as a fallback. After the
native packages exist, configure Trusted Publishing for each one, delete
`NPM_TOKEN` from GitHub, revoke the bootstrap token, and disallow token-based
publishing in npm package settings.

Tokenless is MIT-licensed. Keep every package's `license` field set to `MIT`
and retain the repository's root `LICENSE` file.
