[中文](COMMANDS.zh-CN.md) | [English](COMMANDS.md)

# Tokenless CLI Command Reference

This document is the public inventory of the `tokenless` command-line interface. It separates everyday workflows from lower-level controls and calls out commands that open provider pages, update local state, or only read cached data.

## Command Map

| Command | Purpose | Provider access |
| --- | --- | --- |
| `tokenless help` | Show the built-in command summary. | None |
| `tokenless --version` | Print the installed CLI version. | None |
| `tokenless install` | Verify the packaged local runtime, selected browser, and daemon. | None |
| `tokenless setup` | Configure skills, browser, profiles, daemon, and one-time provider sign-in checks. | Yes |
| `tokenless doctor` | Read local configuration and runtime health without refreshing providers. | None |
| `tokenless config` | Read or update persistent Tokenless configuration. | None |
| `tokenless upgrade` | Upgrade the global CLI, skills, local runtime, and run doctor. | None |
| `tokenless profiles discover` | Discover importable Chrome or Brave profiles. | None |
| `tokenless profiles add` | Create or import a managed browser profile. | None |
| `tokenless profiles list` | List profiles and their last saved provider observations. | None |
| `tokenless profiles status` | Check one provider live and save the observation to the profile registry. | Yes |
| `tokenless profiles open` | Open one provider in a managed profile using a headed browser. | Yes |
| `tokenless profiles set-default` | Select the default managed profile. | None |
| `tokenless profiles reset` | Re-import an imported profile from its recorded source. | None |
| `tokenless profiles clear` | Delete one or all managed profiles as a human maintenance action. | None |
| `tokenless profiles remove` | Delete one managed profile with explicit confirmation. | None |
| `tokenless run` | Send a prompt and optional files through a visible provider session. | Yes |
| `tokenless state` | Inspect durable daemon job state. | None |
| `tokenless resume` | Resume a job waiting for user action in a headed browser. | Yes |
| `tokenless cancel` | Cancel a daemon job and confirm its canceled state. | None |
| `tokenless provider-status` | Perform a live provider authentication check. | Yes |
| `tokenless provider-controls` | Inspect visible model and effort controls. | Yes |
| `tokenless provider-configure` | Select exact visible model or effort labels. | Yes |
| `tokenless provider-action` | Execute one low-level visible provider action. | Yes |
| `tokenless chatgpt-controls` | Inspect ChatGPT model and effort controls. | Yes |
| `tokenless chatgpt-configure` | Configure ChatGPT-specific visible controls. | Yes |
| `tokenless snapshot-dom` | Capture and persist a sanitized provider DOM snapshot. | Yes |
| `tokenless daemon stop` | Gracefully stop a compatible local daemon. | None |
| `tokenless prompt` | Build a shareable Tokenless prompt without submitting it. | None |

## Conventions

### Supported providers

Provider values are:

```text
chatgpt
claude
gemini
grok
```

Runtime browser values are `chrome`, `chrome-for-testing`, `chromium`, `edge`, `arc`, and `brave`. Local profile import currently supports only Chrome and Brave.

### Short options

Short options are case-sensitive:

- `-P <slug>` is short for `--profile <slug>`.
- `-p <provider>` is short for `--provider <provider>`.
- `-f` is short for `--fresh` during setup.
- `-V` is short for `--version`.

### Common execution options

These options are available where the command needs the corresponding runtime behavior:

| Option | Meaning |
| --- | --- |
| `-h`, `--help` | Show usage for the selected command or subcommand. |
| `--json` | Write the final result as structured JSON. Live progress remains on stderr unless `--quiet` is used. |
| `--quiet` | Suppress live status events. |
| `--home <path>` | Use a non-default Tokenless state directory. |
| `--daemon-url <url>` | Use a specific loopback daemon URL. |
| `--browser-visibility <auto\|headed\|headless>` | Choose the browser visibility policy. |
| `--timeout-ms <ms>` | Override the command or job wait timeout. |
| `--daemon-start-timeout-ms <ms>` | Override daemon startup waiting. |
| `--runner-heartbeat-timeout-ms <ms>` | Accepted for compatibility; the embedded Playwright runtime ignores it. |
| `--cancel-timeout-ms <ms>` | Override cancellation confirmation waiting. |
| `--target-url <url>` | Start from a provider-approved URL on the selected provider domain. |

Not every common option is accepted by every command. The command sections below list the meaningful options for each workflow.

## Installation, Setup, and Maintenance

### `tokenless help`

Prints the concise built-in usage guide and the link to this reference.

```bash
tokenless help
tokenless run --help
tokenless profiles status --help
```

Use `-h` or `--help` after any command or subcommand to print its accepted options before doing work.

### `tokenless --version`

Prints the installed package version.

```bash
tokenless --version
tokenless -V
```

### `tokenless install`

Verifies the packaged TypeScript daemon runtime, resolves the selected Chromium browser, saves the runtime configuration, and ensures that the local daemon is ready.

```bash
tokenless install --browser chrome --json
tokenless install --browsers chrome,brave --json
```

Main options:

- `--browser <browser>` selects one browser.
- `--browsers <list>` verifies a comma-separated browser list.
- `--daemon-url`, `--daemon-start-timeout-ms`, `--home`, and `--json` control the local runtime.

This command does not configure a managed profile or check provider sign-in. Run `tokenless setup` afterward.

### `tokenless setup`

Runs the complete onboarding flow: verifies agent skills and the installed CLI version, chooses a browser, saves provider preferences, ensures the daemon is ready, creates or selects a managed profile, and performs one live sign-in check for every supported provider.

Interactive setup:

```bash
tokenless setup
```

Create or reuse a clean profile non-interactively:

```bash
tokenless setup --profile default --fresh --json
```

Import an existing local browser profile:

```bash
tokenless setup \
  --profile work \
  --browser chrome \
  --import-browser-profile "Profile 1" \
  --consent-local-profile-copy \
  --json
```

Main options:

- `--profile <slug>` selects or names the managed profile.
- `--browser <browser>` selects the local Chromium browser.
- `--fresh` or `-f` creates a clean managed profile.
- `--defaults` selects non-interactive defaults.
- `--import-browser-profile <directory-key>` imports a Chrome or Brave profile.
- `--browser-user-data-dir <path>` disambiguates the source browser directory.
- `--consent-local-profile-copy` explicitly authorizes the local copy.
- `--reimport-profile` replaces an existing imported managed profile from a selected source.
- `--label <name>` sets the profile display label.
- `--set-default` makes the selected profile the default.
- `--refresh-skills` reinstalls the Tokenless agent skills.
- `--skip-skill-install` skips skill installation.

`setup` checks all supported providers; it does not accept `--provider` or `--preferred-providers`. `--fresh` cannot be combined with profile import or re-import.

### `tokenless doctor`

Performs a read-only health report over Node.js, installed skills, packaged runtime, daemon identity and version, embedded Playwright runtime, browser, configuration, default managed profile, and cached provider readiness.

```bash
tokenless doctor --json
```

`doctor` does not open provider pages and does not refresh authentication. Provider readiness comes from the last saved profile observation.

Main options: `--browser`, `--daemon-url`, `--home`, and `--json`.

### `tokenless config`

Reads persistent configuration when called without configuration options:

```bash
tokenless config --json
```

Updates one or more persistent values when options are supplied:

```bash
tokenless config \
  --preferred-providers chatgpt,claude,gemini,grok \
  --browser chrome \
  --browser-visibility auto \
  --json
```

Configurable values:

- `--preferred-providers <list>`
- `--browser <browser>`
- `--browser-visibility <auto|headed|headless>`
- `--daemon-url <loopback-url>`
- `--home <path>`

### `tokenless upgrade`

Runs the supported upgrade pipeline: update the global npm CLI, resolve and verify the installed CLI, refresh agent skills, update the local runtime, and run doctor.

```bash
tokenless upgrade
tokenless upgrade --json
```

Accepted options are `--json`, `--home`, `--daemon-url`, `--browser`, `--browsers`, and `--daemon-start-timeout-ms`.

### `tokenless daemon stop`

Gracefully stops a compatible daemon after verifying its identity.

```bash
tokenless daemon stop --json
```

Options: `--home`, `--daemon-url`, `--timeout-ms`, and `--json`.

The command does not kill an unverified or incompatible process merely because it occupies the configured port.

## Managed Profiles

A managed profile is one persistent local browser identity. One profile may hold sessions for all supported providers.

### `tokenless profiles discover`

Discovers importable local Chrome or Brave profiles without copying or modifying them.

```bash
tokenless profiles discover --browser chrome --json
tokenless profiles discover --browser brave --browser-user-data-dir /path/to/user-data --json
```

### `tokenless profiles add`

Creates an empty managed profile:

```bash
tokenless profiles add -P work --label "Work" --set-default --json
```

Or imports selected authentication data into a separate managed copy:

```bash
tokenless profiles add \
  -P work \
  --browser chrome \
  --import-browser-profile "Profile 1" \
  --preferred-providers chatgpt,claude \
  --consent-local-profile-copy \
  --set-default \
  --json
```

Import requires an explicit provider list and `--consent-local-profile-copy`.

### `tokenless profiles list`

Reads the profile registry and returns every managed profile.

```bash
tokenless profiles list
tokenless profiles list --json
```

This command is fast, read-only, and has no browser side effects. Provider fields are cached observations; use each provider's `checkedAt` to judge freshness.

### `tokenless profiles status`

Performs a live authentication check against one provider, then writes `auth`, visible username, visible subscription, and a new `checkedAt` value to the selected profile.

```bash
tokenless profiles status -P work -p chatgpt --json
```

If omitted, the profile resolves to the configured default and the provider falls back to the environment or ChatGPT.

### `tokenless profiles open`

Opens one provider in the selected managed profile with a headed browser and verifies navigation.

```bash
tokenless profiles open -P work -p claude --json
```

Use this command for user-controlled sign-in, CAPTCHA, MFA, consent, or account switching. It does not replace `profiles status`; run the status command afterward to save a fresh observation.

### `tokenless profiles set-default`

Makes one registered profile the default.

```bash
tokenless profiles set-default -P work --json
```

### `tokenless profiles reset`

Quiesces the embedded Playwright runtime and re-imports an imported managed profile from its recorded source.

```bash
tokenless profiles reset -P work
tokenless profiles reset -P work --preferred-providers chatgpt,claude
```

This is a human maintenance command and does not accept `--json`. It works only for profiles that were originally imported.

### `tokenless profiles clear`

Quiesces the embedded Playwright runtime and deletes either one managed profile or every managed profile:

```bash
tokenless profiles clear -P work
tokenless profiles clear --all
```

Exactly one of `--profile` and `--all` is required. This human maintenance command does not accept `--json`.

### `tokenless profiles remove`

Deletes one managed profile through the structured, explicitly confirmed form:

```bash
tokenless profiles remove -P work --confirm-delete --json
```

`--confirm-delete` is mandatory. Removing or clearing a managed profile deletes its Tokenless-managed browser data; it does not modify the source browser profile from which it may have been imported.

## Running Work and Managing Jobs

### `tokenless run`

Builds a managed Playwright job, sends a prompt through the selected visible provider session, and normally waits for the correlated response.

```bash
tokenless run \
  -P default \
  -p chatgpt \
  --prompt "Review this proposal." \
  --json
```

Prompt input:

- Use exactly one of `--prompt <text>` or `--prompt-file <path>`.
- `--project-root <path>` defines the safe root for shareable file context.
- Repeat `--file <path>` to embed text from files inside the project root into the generated prompt.
- Use `--context <text>` or `--context-file <path>` for additional shareable turn context.
- Repeat `--attach-file <path>` to upload real files through the provider page. `--file` and `--attach-file` are different operations.

Provider controls:

- `--model <exact-visible-label>` selects a visible model before submission.
- `--effort <exact-visible-label>` selects visible reasoning or effort.
- `--thinking-effort <label>` is an alternative effort option.
- `--browser-visibility <auto|headed|headless>` overrides the configured visibility policy.

Identity and continuity:

- `--task-id <id>` supplies durable task identity.
- `--idempotency-key <id>` supplies the same identity when no task ID is used.
- `--project-name <name>` and `--chat-name <name>` contribute to derived task identity.
- `--workspace-mode <auto|native|conversation>` explicitly requests Workspace handling and requires `--project-name`.
- `--project-instructions <text>` or `--project-instructions-file <path>` supplies optional Workspace instructions.

Execution:

- `--no-wait` submits and returns without waiting for the result.
- `--long-running` uses the long-running wait budget and cannot be combined with `--no-wait`.
- `--timeout-ms`, `--cancel-timeout-ms`, and `--daemon-start-timeout-ms` override execution timing. `--runner-heartbeat-timeout-ms` remains accepted for compatibility but no longer controls a standalone runner.
- `--target-url <url>` selects an approved starting URL on the provider domain.

Workspace modes:

- `auto` prefers a proven native provider workspace and otherwise returns an explicit conversation fallback.
- `native` requires a native workspace and fails instead of falling back.
- `conversation` requires conversation-scoped continuity.

### `tokenless state`

Reads durable daemon job state without visiting the provider.

```bash
tokenless state --task-id task-123 -P default --json
tokenless state --job-id tlp_... --json
tokenless state -P default -p chatgpt --limit 10 --json
```

Provide a task ID, job ID, or profile. Results are filtered to the managed Playwright backend, selected profile, and provider. `--limit` controls the number of returned jobs.

### `tokenless resume`

Resumes the same daemon job after it entered `waiting_for_user`.

```bash
tokenless resume \
  --job-id tlp_... \
  --browser-visibility headed \
  --json
```

`--job-id` and `--browser-visibility headed` are required. Resume preserves the original job and task identity.

### `tokenless cancel`

Requests cancellation and succeeds only after the daemon confirms the `canceled` state.

```bash
tokenless cancel --job-id tlp_... --json
```

Main options: `--job-id`, `--cancel-timeout-ms`, `--daemon-url`, `--home`, and `--json`.

## Provider Inspection and Control

These commands perform live visible-page operations. They do not make `profiles list` fresh unless the command is specifically `profiles status`.

### `tokenless provider-status`

Performs a live provider authentication action and returns the result.

```bash
tokenless provider-status -P default -p chatgpt --json
```

For a live check that also updates the profile registry, use `tokenless profiles status`.

### `tokenless provider-controls`

Inspects the provider's visible model and effort choices.

```bash
tokenless provider-controls -P default -p claude --json
```

### `tokenless provider-configure`

Selects an exact visible model, effort label, or both.

```bash
tokenless provider-configure \
  -P default \
  -p chatgpt \
  --model "GPT-5" \
  --effort "High" \
  --json
```

At least one control is required. Labels must match visible UI labels; model fallback lists are not supported by managed visible jobs.

### `tokenless chatgpt-controls`

ChatGPT-specific alias for inspecting model and effort controls.

```bash
tokenless chatgpt-controls -P default --json
```

### `tokenless chatgpt-configure`

Selects ChatGPT-specific model or effort controls. It also accepts `--chat-surface chat` as an explicit surface constraint; other ChatGPT surfaces are rejected.

```bash
tokenless chatgpt-configure \
  -P default \
  --model "GPT-5" \
  --effort "High" \
  --json
```

If `--provider` is supplied, it must be `chatgpt`.

### `tokenless provider-action`

Executes exactly one low-level visible action.

```bash
tokenless provider-action \
  -P default \
  -p chatgpt \
  --action capability.inspect \
  --json
```

| Action | Purpose | Required or relevant payload options |
| --- | --- | --- |
| `capability.inspect` | Inspect visible, subscription-dependent capabilities. | None |
| `auth.status` | Inspect visible authentication and account state. | None |
| `model.inspect` | List visible model controls. | None |
| `model.select` | Select one exact visible model. | `--model` |
| `effort.inspect` | List visible effort controls. | None |
| `effort.select` | Select one exact visible effort. | `--effort` or `--thinking-effort` |
| `file.upload` | Upload files through visible file controls. | One or more `--attach-file` |
| `workspace.ensure` | Ensure a native or conversation-scoped Workspace. | `--project-name`; optional `--workspace-mode` and instructions |
| `prompt.clear` | Clear the visible composer. | None |
| `prompt.input` | Put text into the visible composer without submitting it. | `--prompt` or `--prompt-file` |
| `prompt.submit` | Submit the current visible composer. | None |
| `response.read` | Read the visible correlated response. | None |
| `snapshot.sanitized` | Return a sanitized structural snapshot. | None |
| `navigation.check` | Verify that the page is on an approved provider origin. | None |
| `blocker.check` | Inspect visible blockers such as sign-in or CAPTCHA. | None |

Action payloads are strict: options that do not apply to the selected action are rejected.

`workspace.ensure` defaults to `--workspace-mode auto` when the mode is omitted.

### `tokenless snapshot-dom`

Captures a sanitized structural provider snapshot through the daemon and persists its metadata and snapshot files under the Tokenless home directory.

```bash
tokenless snapshot-dom -P default -p chatgpt --json
```

Use `provider-action --action snapshot.sanitized` when persistence is not needed.

## Prompt Construction

### `tokenless prompt`

Builds the shareable `# Tokenless Request` document without opening a browser or submitting a provider job.

```bash
tokenless prompt \
  --project-root /path/to/project \
  --file src/example.ts \
  --context "Only the selected files are shareable." \
  --prompt "Review this implementation." \
  --output /tmp/tokenless-request.md
```

Options:

- `--prompt` or `--prompt-file` supplies the user request.
- `--project-root` defines the allowed file boundary.
- Repeat `--file` to include file text.
- `--context` or `--context-file` supplies shareable turn context.
- `--output` writes the compiled prompt to a file; otherwise it prints to stdout.

The command can also be invoked without the word `prompt` when the first argument is an option, but the explicit form is clearer in documentation and scripts.

## Compatibility Aliases

The following aliases are accepted for compatibility. Prefer the canonical form in new scripts.

| Alias | Canonical form |
| --- | --- |
| `tokenless status` | `tokenless state` |
| `tokenless provider-auth-status` | `tokenless provider-status` |
| `tokenless inspect-provider-controls` | `tokenless provider-controls` |
| `tokenless inspect-chatgpt-controls` | `tokenless chatgpt-controls` |
| `--import-chrome-profile` | `--import-browser-profile` |
| `--chrome-user-data-dir` | `--browser-user-data-dir` |
| `--turn-context` | `--context` |
| `--turn-context-file` | `--context-file` |
| `--conversation-key` | `--idempotency-key` |
| `--clean-profile` | `--fresh` |

## Status and Side-Effect Summary

The three similarly named status workflows have different persistence behavior:

```text
profiles list
    reads only the saved profile registry

profiles status
    visits one provider, checks auth/account controls,
    and saves auth, username, subscription, and checkedAt

provider-status
    visits one provider and returns a live auth result,
    but is not the profile-registry refresh workflow
```

Commands that may open or operate a provider page are `setup`, `profiles status`, `profiles open`, `run`, `resume`, every provider inspection/configuration/action command, and `snapshot-dom`.
