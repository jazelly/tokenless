# Harness Integrations

Tokenless exposes two independent integration depths. Installing one does not imply the other.

## Model access through Tokenless API

An external Harness keeps its own agent loop, tools, sessions, continuation, and subagents. Only its model endpoint changes:

```text
External Harness agent loop
  -> existing model adapter with Tokenless API base URL
  -> Tokenless API
  -> selected provider
```

For DeepSeek Harness, the verified route uses its existing `llm-deepseek` adapter. The integration does not enable or require `llm-pi-ai`, and it does not delete that independent DeepSeek Harness package.

## Subagent execution through Tokenless Harness

A host with a replaceable subagent executor can delegate a child task to Tokenless Harness:

```text
Host main agent loop
  -> host subagent provider seam
  -> Tokenless Harness adapter
  -> Tokenless Harness-owned AgentRun and workspace tools
  -> Tokenless API
  -> selected provider
  -> final child result returned to the host
```

DeepSeek Harness exposes this seam through `SubagentProvider`:

```bash
tokenless agents install dsh \
  --dsh-home ~/.dsh \
  --dsh-profile headless \
  --provider chatgpt \
  --profile default \
  --json
```

The installer adds a marked block to that profile's `cordis.patch.yml`, registers the `tokenless-harness` provider, and selects it for the ordinary `subagent` tool. Other profile rows remain unchanged.

```bash
tokenless agents status dsh --dsh-home ~/.dsh --dsh-profile headless --json
tokenless agents uninstall dsh --dsh-home ~/.dsh --dsh-profile headless --json
```

The provider is one-shot in V1. A delegated task receives the parent workspace root and bounded read/search tools; Tokenless Harness owns its model/tool continuation until it returns a final result.

## Explicit delegation

Hosts without a replaceable subagent executor can invoke the same boundary explicitly:

```bash
tokenless agent delegate \
  --provider chatgpt \
  --profile default \
  --workspace-root "$PWD" \
  --prompt "Find where the API endpoint is configured." \
  --json
```

Codex currently falls into this category. Its [native spawn handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs) owns subagent creation, while the [SubagentStart hook input](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/subagent-start.command.input.schema.json) is observational context rather than an executor replacement. Tokenless therefore documents explicit delegation for Codex instead of claiming that native `spawn_agent` has been replaced.

## Codex task visibility and reporting

Internal Codex sub-agent use does not hide Codex UI delegation messages. Tokenless cannot control Codex UI or native `spawn_agent` behavior.

Use separate Codex tasks for sidebar-visible worker/reviewer work only when the user explicitly requests separate tasks or independently visible progress. The main task reads statuses and gives a short synthesis; it does not repeat long child reports. Its report contains only the child name, status, at most one blocker, and the coordinator decision.

## Ownership

| Path | Agent loop owner | Tool executor | Provider access |
| --- | --- | --- | --- |
| Model base URL | External Harness | External Harness | Tokenless API |
| DSH subagent provider | Tokenless Harness for the child | Tokenless Harness | Tokenless API |
| Explicit delegation | Tokenless Harness for the delegated run | Tokenless Harness | Tokenless API |
