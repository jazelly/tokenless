---
name: tokenless
description: Package a local agent request into a Tokenless visible-session bridge prompt with explicit project context. Use when a user wants a portable Tokenless CLI runtime for ChatGPT, Claude, Gemini, Codex, or Antigravity adapters.
---

# Tokenless

This skill is self-contained. Run commands from this skill folder's project root after installing or checking out Tokenless.

Core Tokenless CLI command:

```bash
node packages/cli/src/tokenless.mjs \
  --project-root "/absolute/path/to/project" \
  --prompt "<user request>" \
  --file <relative file> \
  --output /tmp/tokenless-prompt.md
```

Do not include hidden agent reasoning, provider cookies, browser storage tokens, or secrets. Include only shareable user prompt, explicit turn context, and selected project files.
