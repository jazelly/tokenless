# Chrome Web Store release checklist

This checklist is for the release owner. It is not part of ordinary user setup.
The exact package, listing, privacy, distribution, and reviewer copy lives in
[the Chrome Web Store submission source of truth](chrome-web-store/submission.md).
Update that document before changing the Dashboard.

## One-time identity binding

1. Build the review package with `npm run pack:extension --workspace tokenless-browser-session-bridge`.
2. Upload `packages/extension/dist/tokenless-browser-session-bridge.zip` to the Chrome Web Store Developer Dashboard as an unpublished item.
3. Record the assigned item ID and download its public key from the Package tab.
4. Add that public key as the `key` field of `packages/extension/extension/manifest.json` so unpacked development builds use the same stable ID.
5. Update `packages/cli/src/default-extension-id.ts` to the assigned item ID.
6. Run `npm run verify:extension-release -- --extension-id "<item-id>"`.
7. Build the extension again, load it unpacked, and verify that `chrome://extensions` reports the same ID before publishing.

The native-host manifest authorizes exactly this extension ID. Do not change the Store identity without changing the bundled CLI default in the same release.

## Each release

1. Run `npm test` and `npm run test:e2e`.
2. Run `npm run pack:extension --workspace tokenless-browser-session-bridge`.
3. Verify the zip contains the Manifest V3 production files and icons, but no source maps or declaration files.
4. Upload the zip, complete every Dashboard field from
   [the submission source of truth](chrome-web-store/submission.md), and verify
   the live dedicated privacy-policy URL.
5. Review permission disclosures for `debugger`, `nativeMessaging`, `scripting`,
   `sidePanel`, and the explicit provider host permissions. Confirm the named
   `tabs` permission is absent and the packaged service worker uses debugger
   only for validated `Input.dispatchMouseEvent` clicks and always detaches.
6. Run `npm run verify:extension-release` and submit only after it succeeds.
7. Confirm the released `tokenless` CLI uses the Store item ID by default and
   that the reviewer command also passes the ID explicitly.
8. Use deferred publishing and wait for explicit publication approval.

## User-facing promise

Once the Store version is live, the supported setup is:

```bash
# User installs and enables the Tokenless extension from the Chrome Web Store.
npx tokenless setup
```

`setup` must be the only local configuration command a normal user needs. It writes the Native Messaging registration and succeeds only when the installed extension has connected.
