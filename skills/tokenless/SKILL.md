---
name: tokenless
description: Route a Q&A type LLM conversation to online web version to save token usage for users. Use when a question or task can be done without directly writing to the project. For example, web-search based analysis, project-related analysis without writing, or even image generation.
---

## Prerequisites

- Node.js runtime (>=22)
- Tokenless CLI from npm (`npm install -g tokenless` or `npx tokenless`) If not installed locally, just rely on npx

Do not invoke Tokenless through repo-relative CLI paths. Use the npm CLI only.

## Check available providers

Before choosing a provider, read the user's configured order from `~/.tokenless/config.json`, or run:

```bash
npx tokenless config --json
```

Use the `preferredProviders` array as the allowed provider list and default routing order. Supported values are `chatgpt`, `claude`, and `gemini`.

Configure the default provider order locally:

```bash
npx tokenless config --preferred-providers claude,chatgpt,gemini --json
```

## Build a shareable prompt (optional)

```bash
npx tokenless \
  --project-root "/absolute/path/to/project" \
  --project-name "<agent project name>" \
  --chat-name "<agent chat name>" \
  --prompt "<user request>" \
  --file <relative file> \
  --output /tmp/tokenless-prompt.md
```

## Run a visible-session task

```bash
npx tokenless run \
  --project-name "<agent project name>" \
  --chat-name "<agent chat name>" \
  --project-root "/absolute/path/to/project" \
  --prompt-file /tmp/tokenless-prompt.md \
  --extension-id "<chrome-extension-id>" \
  --json
```

When invoking `tokenless run`:

- `--project-name`: the project name from the calling agent workspace.
- `--chat-name`: the chat/thread title or stable chat label from the calling agent.
- Use `--provider chatgpt`, `--provider claude`, or `--provider gemini` when the user explicitly requests a visible web provider.
- Otherwise omit `--provider` and let Tokenless use the first entry in `preferredProviders` from `~/.tokenless/config.json`.

If no user preference applies and no provider is configured, use this default guidance:

- `claude`: long-form writing, careful critique, broad code review, architecture tradeoffs, and synthesis-heavy tasks.
- `chatgpt`: general coding, debugging, structured transformations, multimodal/browser-product reasoning, and fast interactive iteration.
- `gemini`: large-context reading, research-style summarization, Google ecosystem context, and broad document comparisons.

Do not include hidden agent reasoning, provider cookies, browser storage tokens, or secrets. Include only shareable user prompt, explicit turn context, and selected project files.
