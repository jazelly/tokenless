---
name: tokenless
description: Package a local agent request into a Tokenless visible-session bridge prompt with explicit project context. Use when a user wants a portable local scale runtime for ChatGPT, Claude, Gemini, Codex, or Antigravity adapters.
---

# Tokenless

This skill is self-contained. Run commands from this skill folder's project root after installing or checking out Tokenless.

Core local scale command:

```bash
node packages/local-scale/src/tokenless-scale.mjs \
  --project-root "/absolute/path/to/project" \
  --prompt "<user request>" \
  --file <relative file> \
  --output /tmp/tokenless-scale-prompt.md
```

Do not include hidden agent reasoning, provider cookies, browser storage tokens, or secrets. Include only shareable user prompt, explicit turn context, and selected project files.
