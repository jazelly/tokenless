# npm publishing

Tokenless publishes one public npm package:

- `tokenless`

The package includes the TypeScript CLI, the local TypeScript daemon entrypoint,
and the managed Playwright runtime. It does not publish platform-specific native
runtime packages. The release workflow never publishes without the tracked
`.changeset/publish-pending.json` release marker.

## Normal release flow

1. Add a changeset with `npm run changeset` and select `tokenless`.
2. Merge the change containing that changeset into `main`.
3. `Prepare npm release` opens or updates a version pull request. Its version
   script consumes the changeset, synchronizes the CLI package and lockfile, and
   writes `.changeset/publish-pending.json`.
4. Merge that version pull request.
5. `Publish npm packages` verifies the marker and publishes `tokenless`.
6. After the package is confirmed published, the workflow removes the marker in
   a second commit. A retry is safe because already-published versions are
   skipped.

## GitHub setup required from a repository administrator

1. In **Settings -> Actions -> General**, set workflow permissions to
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
npm trust github tokenless \
  --repo jazelly/tokenless \
  --file publish-npm.yml \
  --allow-publish \
  --yes
```

Configure **Settings -> Trusted publishing** for `tokenless` on npmjs.com with:

- publisher: GitHub Actions;
- owner: `jazelly`;
- repository: `tokenless`;
- workflow filename: `publish-npm.yml`;
- allowed action: `npm publish`.

Tokenless is MIT-licensed. Keep the package `license` field set to `MIT` and
retain the repository's root `LICENSE` file.
