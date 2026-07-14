---
name: tokenless-install
description: Install, upgrade, repair, and verify Tokenless for an agent. Use when a user asks to set up Tokenless, install or update its main skill, resolve setup or extension-bridge failures, or run an integrity check with `tokenless doctor`.
---

# Tokenless installation and maintenance

Complete this workflow before using the `tokenless` skill. Keep the user-facing path short: perform commands yourself, report only required manual actions, and finish with a verified result. Write every user-facing status, instruction, and completion message in the user's preferred language; infer it from the current conversation, defaulting to the language of the user's latest message.

## Install

1. Check that Node.js is version 24.15 or newer:

   ```bash
   node --version
   ```

   Stop and ask the user to install or upgrade Node.js if it is older than 24.15.

2. Install the main Tokenless skill in the same skill scope as this installation skill:

   ```bash
   npx skills add https://github.com/jazelly/tokenless/tree/main/skills/tokenless --yes
   ```

3. Provision the current CLI and verify the visible browser bridge:

   ```bash
   npx tokenless@latest setup --json
   ```

   Do not bypass login, CAPTCHA, permission prompts, or provider confirmations. Follow the user-handoff procedure below whenever browser action is required.

4. Verify the finished installation:

   ```bash
   npx tokenless@latest doctor --json
   ```

   Report success only when the command returns `ok: true`. Summarize the selected browser and provider. On failure, identify the failed check and give the smallest next action; rerun `setup` after the user completes a required browser action.

## User handoff for browser actions

Run the CLI steps first. If `setup` reports `extension_setup_incomplete`, or `doctor` reports `extensionBridge.ok: false`, do not claim installation is complete. Tell the user, in their preferred language:

1. What completed locally: the main skill and local runtime are installed, but the browser bridge is not connected.
2. The exact user action: open `chrome://extensions` in the selected Chromium browser; install the Tokenless extension if it is absent, enable it, then reload the selected provider page.
3. The next confirmation: ask the user to reply once that is done. Do not ask them for cookies, storage contents, passwords, extension IDs, or other secrets. Ask for an extension ID only when they explicitly say they are using an unpacked development extension.
4. What happens next: after their reply, rerun `npx tokenless@latest setup --json`, then `npx tokenless@latest doctor --json`; only then report success.

Use a short status format: **completed locally**, **action needed in browser**, and **what I will verify next**. Translate these labels and all explanatory prose to the user's preferred language. For login, CAPTCHA, permission, or provider-confirmation screens, use the same handoff format and say that the user must complete the visible prompt themselves.

## Upgrade

Use this procedure when the user asks to update Tokenless, its skills, or its local runtime:

```bash
npx skills update tokenless tokenless-install --yes
npx tokenless@latest setup --json
npx tokenless@latest doctor --json
```

`setup` refreshes the local runtime from the current CLI package; `doctor` refreshes installed binaries again before checking them. Do not download, curl, or substitute binaries manually.

## Repair

Run this first:

```bash
npx tokenless@latest doctor --json
```

- If `node.ok` is false, require Node.js 24.15 or newer.
- If the browser check fails, ask the user to install a supported Chromium browser or choose one with `--browser` during `setup`.
- If native binaries or manifests fail, rerun `npx tokenless@latest setup --json`.
- If `extensionBridge.ok` is false, use the user-handoff procedure, then rerun setup after the user confirms the browser action is complete.
- If the user has an unpacked extension, rerun setup with the explicit `--extension-id` obtained from `chrome://extensions`.

Keep credentials private. Never inspect or request browser cookies, storage tokens, hidden authorization headers, or private provider APIs.
