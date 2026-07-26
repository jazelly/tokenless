[中文](README.zh-CN.md) | [English](README.md) | [CLI commands](COMMANDS.md) | [Roadmaps](docs/roadmaps/README.md)

# Tokenless

## Overview

Tokenless is a local tool for anyone who uses AI and wants to reduce token usage. Its intelligent routing mechanism sends suitable parts of an agent's requests to web-based AI services, reducing token consumption on the agent side. Tokenless currently supports the web versions of ChatGPT, Claude, Grok, and Gemini, and can use multiple services together.

## Why We Built Tokenless

As AI agents are used in more scenarios, they consume an increasing number of tokens and costs continue to rise. Web-based AI services and the APIs used by agents draw from separate usage pools. Routing part of the workload to web-based services can therefore reduce overall AI usage costs without requiring additional API quota. We built Tokenless around this idea.

## Key Features

- **Intelligent task routing**: Customizable Skill Prompts let users define which types of tasks should be handled by which AI service, enabling flexible and controlled routing strategies.
- **Multiple AI services**: Tokenless currently supports the web versions of ChatGPT, Claude, Grok, and Gemini, and can use multiple services together.
- **Fully local operation**: All automation runs locally, with no third-party relays and no collection of user data.
- **Provider-neutral visible workflows**: Tokenless automates prompts, integrity-checked file selection, and conversation continuity across all four providers. Experimental capability inspection and Workspace handling make subscription-dependent native support and fallbacks explicit.
- **Explicit guest and sign-in routing**: ChatGPT and Gemini can run through visible guest sessions. Claude and Grok hand the existing job to the user for sign-in before Tokenless enters task content.

## Technology Stack

- **Automation layer**: Playwright, used to operate each AI provider's web interface
- **Command-line tool**: A TypeScript CLI that serves as the user-facing entry point
- **Local daemon**: A TypeScript daemon responsible for persistent local execution and state management

## Command-Line Short Options

Profile and provider selection use distinct, case-sensitive short options:

- `-P <slug>` is short for `--profile <slug>`.
- `-p <provider>` is short for `--provider <provider>`.

For example, `tokenless profiles status -P work -p claude --json` checks Claude for the `work` profile.

For the complete public command inventory, see the [Tokenless CLI Command Reference](COMMANDS.md).

## Experimental Workspace Handling

`--project-name` remains task metadata by default. Add `--workspace-mode auto` to request a provider-neutral Workspace: Tokenless uses a fixture-proven native Project only when available and otherwise reports an explicit conversation-scoped fallback. Use `--workspace-mode native` to reject fallback, or `--workspace-mode conversation` to require conversation continuity.

Run `tokenless provider-action --action capability.inspect --provider <provider> --json` to inspect the visible, subscription-dependent capability state. These contracts remain experimental until the live free, paid, unknown-plan, and managed-account matrix is complete.

## Implementation

- A TypeScript CLI provides the user-facing interface, while a local TypeScript daemon runs persistently on the user's machine and manages state.
- Routing is implemented through Skill Prompts. Users can define rules that assign different types of tasks to different AI services.
- Playwright operates provider-visible controls and reports fixture-proven postconditions. File uploads distinguish selected files from visibly accepted attachments, while Workspace requests expose whether the provider used a native resource or a conversation fallback.
- A provider catalog records guest, account-tier, selector, and capability policy; a separate provider-session state machine turns visible page evidence into guest, account, handoff, wait, or terminal outcomes.
- The entire workflow runs locally, without passing through third-party relay services or collecting user activity data.

## Current Status

Tokenless is currently in private beta. We plan to publish detailed benchmarks of its token savings in the future.

## Known Issues

### Codex sandbox policies can prevent Tokenless from running

In Codex, the sandbox policy applied to an agent may block Tokenless from launching a browser or performing required local operations. In a trusted environment, either enable Full Access or approve the operation when Codex asks for permission and choose to allow the same operation in the future.
