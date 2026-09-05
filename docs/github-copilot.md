# GitHub Copilot browser controls

[简体中文](github-copilot.zh-CN.md)

GitHub Copilot uses the selected Tokenless API browser profile and its signed-in GitHub account. The adapter is experimental; capabilities and model access come from the current visible page.

## Inspect and select

```bash
tokenless provider-controls --provider github-copilot --json
tokenless provider-configure --provider github-copilot --copilot-mode ask --copilot-repo owner/repo --model "GPT-5.6 Luna" --json
```

| Control | Returned information | Selection |
| --- | --- | --- |
| Mode | Ask or Agent, including the active mode | `--copilot-mode ask\|agent` |
| Repository | Visible repository choices and selected state; exact selection searches the picker | `--copilot-repo owner/repo` |
| Model | Exact label, `selected`, `enabled`, and observed `requiredPlan` / `description` for locked choices | `--model "exact label"` |
| Reasoning | Choices exposed by the current Agent model | `--effort "exact label"` |
| Usage | Account AI credits and budget; latest message input/output tokens and AI credits when visible | Read-only |

Ask and Agent expose different model lists. Disabled Pro+ or Max models remain visible in inspection and cannot be selected; the adapter does not infer availability from a static plan table.

The account meter reports **AI credits**, remaining allowance, the displayed reset date, and the additional USD budget. Each reply can also expose **input tokens**, **output tokens**, and its AI-credit cost.

`github-copilot.usage.inspect` returns account counters and nullable `latestMessage`; `response.read.usage` returns the observed reply counters when available. Historical pages may omit message counters. The adapter preserves units and observation time; inspecting usage does not change billing settings.

## Repository as Project

```bash
tokenless run --provider github-copilot --workspace-mode native --project-name owner/repo --model "GPT-5.6 Luna" --prompt "Explain the root package.json in this repository." --json
```

`workspace.ensure` selects an existing repository and returns it as the native Project identity, with its canonical GitHub repository URL. Repository instructions remain managed in Git.

## GitHub cloud Agent

```bash
tokenless run --provider github-copilot --copilot-mode agent --workspace-mode native --project-name owner/repo --model "GPT-5.6 Luna" --prompt "Inspect the repository and explain its test command. Do not modify files." --json
```

Agent starts a GitHub cloud session using the displayed repository and branch. The adapter follows the newly created session, waits for completion, and returns its answer, visible tool-step labels, session URL, and observed session AI credits.

This is GitHub's native Agent. `tokenless agent delegate` uses Tokenless Harness and the independently verified Ask-mode Markdown/tool-result workflow.

## Individual actions

Use `tokenless provider-action --provider github-copilot --action <action> --json`:

| Action | Payload / CLI option |
| --- | --- |
| `github-copilot.mode.inspect` | Empty |
| `github-copilot.mode.select` | `{"mode":"ask"}` / `--copilot-mode ask` |
| `github-copilot.repository.inspect` | Empty |
| `github-copilot.repository.select` | `{"label":"owner/repo"}` / `--copilot-repo owner/repo` |
| `github-copilot.usage.inspect` | Empty |

The existing `model.inspect/select`, `effort.inspect/select`, `workspace.ensure`, `file.upload`, and conversation actions use the same real browser boundary.

## File verification

The initial acceptance covered TXT content, Markdown selection, and a complete two-turn Harness Markdown/tool-result exchange with GPT-5.6 Luna. The focused file-input case additionally checks TXT, Markdown, JSON, CSV, TypeScript, and PNG content in one real request.

Ask advertises text/code and image extensions. Agent accepts PNG, JPEG, GIF, and WebP images through its image picker; a separate Agent image case checks PNG reading. The adapter preserves the uploaded image link when entering the task prompt. A visible picker option is not proof of semantic support for every extension; PDF, Office, audio, and video support are not claimed by these cases.

Official references: [GitHub.com chat](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-github), [monitoring AI credits](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage).

The focused real-provider cases are `github-copilot-controls`, `github-copilot-repository`, `github-copilot-agent`, `github-copilot-agent-image`, `github-copilot-file-inputs`, and `harness-attachment-roundtrip`. They use the built CLI, packaged daemon, and configured persistent profile; the file-content case also checks observed input/output token counters.
