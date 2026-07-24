[中文](README.zh-CN.md) | [English](README.md)

# Tokenless

## Overview

Tokenless is a local tool for anyone who uses AI and wants to reduce token usage. Its intelligent routing mechanism sends suitable parts of an agent's requests to web-based AI services, reducing token consumption on the agent side. Tokenless currently supports the web versions of ChatGPT, Claude, Grok, and Gemini, and can use multiple services together.

## Why We Built Tokenless

As AI agents are used in more scenarios, they consume an increasing number of tokens and costs continue to rise. Web-based AI services and the APIs used by agents draw from separate usage pools. Routing part of the workload to web-based services can therefore reduce overall AI usage costs without requiring additional API quota. We built Tokenless around this idea.

## Key Features

- **Intelligent task routing**: Customizable Skill Prompts let users define which types of tasks should be handled by which AI service, enabling flexible and controlled routing strategies.
- **Multiple AI services**: Tokenless currently supports the web versions of ChatGPT, Claude, Grok, and Gemini, and can use multiple services together.
- **Fully local operation**: All automation runs locally, with no third-party relays and no collection of user data.
- **Complete web interaction capabilities**: Tokenless automates the full web workflow, including entering prompts, uploading files, managing Projects, managing conversation threads, and operating Connectors. These actions can be performed throughout long-running agent interactions.

## Technology Stack

- **Automation layer**: Playwright, used to operate each AI provider's web interface
- **Command-line tool**: A TypeScript CLI that serves as the user-facing entry point
- **Local daemon**: A Rust daemon responsible for persistent local execution and state management

## Implementation

- A TypeScript CLI provides the user-facing interface, while a Rust daemon runs persistently on the user's machine and manages state.
- Routing is implemented through Skill Prompts. Users can define rules that assign different types of tasks to different AI services.
- Playwright automates the full set of browser interactions, including entering prompts, uploading files, managing Projects, managing conversation threads, and operating Connectors. Together, these workflows cover the main interactions offered by web-based AI services.
- The entire workflow runs locally, without passing through third-party relay services or collecting user activity data.

## Current Status

Tokenless is currently in private beta. We plan to publish detailed benchmarks of its token savings in the future.
