# CloakBrowser profile compatibility spike

This is a throwaway prototype. Delete it and remove the
`prototype:cloakbrowser-profile-compat` package script after the compatibility
question is answered.

## Question

Can CloakBrowser 145 open a complete profile directory produced by the
installed Chrome 150, preserve credential-free synthetic browser state, write
new state, and reopen the copied profile?

## Safety boundary

The prototype creates a new disposable Chrome profile. It never reads, copies,
or opens the user's real Chrome profile, cookies, credentials, Keychain items,
or browser storage. Only synthetic markers created by the prototype are read.

## Result

Tested on 2026-08-01 with:

- installed Google Chrome `150.0.7871.187` on macOS arm64;
- CloakBrowser binary `145.0.7632.109.2` (`Chromium 145.0.7632.109`);
- `cloakbrowser` wrapper `0.5.3`; and
- a disposable Chrome-created profile containing only synthetic
  `example.com` cookie and localStorage markers.

| Candidate | Opened in Cloak 145 | Result |
| --- | --- | --- |
| Complete Chrome 150 profile copy | No | Browser exited with `SIGTRAP`. |
| Complete copy without top-level `Last Version` | No | Browser exited with `SIGTRAP`. |
| Complete copy with `--user-data-migrated` | No | Browser exited with `SIGTRAP`. |
| Cloak 145 root plus complete Chrome 150 `Default` directory | No | Browser exited with `SIGTRAP`. |
| Cloak-owned profile plus only Chrome `Cookies` and `Local Storage` | Yes | Both synthetic markers were readable and survived a Cloak restart. |

The successful partial candidate was also observed directly for two minutes
through macOS accessibility and process inspection. The visible Cloak window
loaded Example Domain, the renderer carried Cloak's `--fingerprint` argument,
and no external CDP observer was attached. No Keychain prompt appeared.

## Conclusion

A raw Chrome 150 profile is not compatible with Cloak 145 on this machine.
Removing Chromium's downgrade breadcrumb is insufficient, and keeping Cloak's
root metadata while replacing the entire `Default` directory is also
insufficient. This localizes the incompatibility to some part of the complete
Chrome 150 profile payload rather than Playwright or the external observer.

The passing candidate proves a narrower conversion is technically possible:
create the target profile with Cloak 145, then import explicitly supported data
categories instead of treating the profile directory as an opaque copy. It
does not prove compatibility for history, preferences, sessions, extensions,
passwords, or authenticated real-user state.

Chromium documents newer-to-older user-data launches as downgrades that may run
only to the extent possible. Its downgrade manager recognizes the top-level
`Last Version` file and `--user-data-migrated`, but neither bypass made this
complete Chrome 150 payload usable in Cloak 145:

- <https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_storage.md>
- <https://chromium.googlesource.com/chromium/src/+/lkgr/chrome/browser/downgrade/downgrade_manager.cc>

The structured result is written to
`test-results/cloakbrowser-profile-compat/last-run.json`. All disposable profile
directories are removed at the end of the run.
