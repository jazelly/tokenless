# Tool-Driven Agent Runtime Resources

## Knowledge

- [OpenAI: Function calling](https://developers.openai.com/api/docs/guides/function-calling)
  Primary protocol guide for tool schemas, model-emitted calls, call IDs, tool outputs, and continuation.
- [Anthropic: Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)
  Primary cross-provider reference showing the same client-tool loop with different wire message shapes.
- `/Users/jazelly/Desktop/github/deepseek-harness/packages/core/tools/src/index.ts`
  Local primary source for the distinction between model-visible `ToolSchema` data and internal execution, timeout, and presentation behavior.
- `/Users/jazelly/Desktop/github/deepseek-harness/packages/core/agent-loop/src/agent.ts`
  Local primary source for the outer loop that requests a model response, detects calls, executes them, and continues.
- `packages/harness/src/internal/system-prompt.ts`
  Local primary source for Tokenless's current text-envelope approach to advertising tools to a visible web model.

## Wisdom (Communities)

- [OpenAI Developer Community](https://community.openai.com/)
  Useful for comparing real integration behavior after the protocol boundary is understood from primary documentation.
