import { createHash } from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import {
  HarnessSkillError,
  type AgentMcpServerSpec,
  type HarnessToolCatalogEntry,
  type HarnessToolExecution,
  type HarnessToolRegistry,
  type JsonValue,
} from './contracts.js'

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_RESULT_BYTES = 256 * 1024

export function createStdioMcpToolRegistry(): HarnessToolRegistry {
  return {
    async catalog(input) {
      const servers = validateServers(input)
      const catalog: HarnessToolCatalogEntry[] = []
      for (const server of servers) {
        const connection = await connect(server)
        try {
          const listed = await connection.client.listTools(undefined, { timeout: timeout(server) })
          for (const tool of listed.tools) {
            if (server.enabledTools && !server.enabledTools.includes(tool.name)) continue
            const name = exposedToolName(server.name, tool.name)
            catalog.push({
              name,
              server: server.name,
              serverToolName: tool.name,
              description: boundedText(tool.description ?? `MCP tool ${tool.name} from ${server.name}.`, 4096),
              inputSchema: normalizedInputSchema(tool.inputSchema),
              source: 'mcp',
              readOnly: false,
              approval: 'always',
            })
          }
        } catch (error) {
          throw redactedMcpError('mcp_tool_discovery_failed', server.name, error)
        } finally {
          await connection.close()
        }
      }
      const names = new Set<string>()
      for (const tool of catalog) {
        if (names.has(tool.name)) throw new HarnessSkillError('mcp_tool_duplicate', `MCP tool '${tool.name}' is duplicated.`)
        names.add(tool.name)
      }
      return catalog.toSorted((left, right) => left.name.localeCompare(right.name))
    },

    async execute(entry, argumentsValue, input) {
      const servers = validateServers(input)
      const server = servers.find((candidate) => candidate.name === entry.server)
      if (!server || exposedToolName(server.name, entry.serverToolName) !== entry.name) {
        throw new HarnessSkillError('mcp_tool_not_configured', `MCP tool '${entry.name}' is not backed by an explicit server.`)
      }
      if (server.enabledTools && !server.enabledTools.includes(entry.serverToolName)) {
        throw new HarnessSkillError('mcp_tool_not_configured', `MCP tool '${entry.name}' is no longer enabled by the frozen run spec.`)
      }
      const connection = await connect(server)
      try {
        const result = await connection.client.callTool(
          { name: entry.serverToolName, arguments: argumentsValue },
          undefined,
          { timeout: timeout(server) },
        )
        if (result.isError === true && authenticationRequired(result.content)) {
          return {
            status: 'authentication_required',
            handoff: `Complete authentication for MCP server '${server.name}' outside Tokenless, then resume this exact call.`,
          } satisfies HarnessToolExecution
        }
        return {
          status: result.isError === true ? 'failed' : 'succeeded',
          content: boundedResult(result),
        } satisfies HarnessToolExecution
      } catch (error) {
        throw redactedMcpError('mcp_tool_execution_failed', server.name, error)
      } finally {
        await connection.close()
      }
    },
  }
}

async function connect(server: AgentMcpServerSpec) {
  const transport = new StdioClientTransport({
    command: server.command,
    ...(server.args ? { args: [...server.args] } : {}),
    env: resolvedEnvironment(server),
    stderr: 'ignore',
    maxBufferSize: MAX_RESULT_BYTES * 2,
  })
  const client = new Client(
    { name: 'tokenless-web-agent-harness', version: '1.0.0' },
    { capabilities: {} },
  )
  try {
    await client.connect(transport, { timeout: timeout(server) })
    return {
      client,
      async close() {
        await client.close().catch(() => undefined)
        await transport.close().catch(() => undefined)
      },
    }
  } catch (error) {
    await transport.close().catch(() => undefined)
    throw redactedMcpError('mcp_server_unavailable', server.name, error)
  }
}

function validateServers(input: readonly AgentMcpServerSpec[]) {
  if (!Array.isArray(input) || input.length > 16) throw new HarnessSkillError('mcp_config_invalid', 'At most 16 explicit MCP servers are allowed.')
  const names = new Set<string>()
  return input.map((server) => {
    if (!server || typeof server !== 'object' || !SERVER_NAME.test(server.name) || names.has(server.name)) {
      throw new HarnessSkillError('mcp_config_invalid', 'Every MCP server must have a unique safe name.')
    }
    names.add(server.name)
    if (typeof server.command !== 'string' || server.command.trim() === '' || server.command.length > 1024 || server.command.includes('\0')) {
      throw new HarnessSkillError('mcp_config_invalid', `MCP server '${server.name}' command is invalid.`)
    }
    if (server.args && (!Array.isArray(server.args) || server.args.length > 64 || server.args.some((arg: unknown) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')))) {
      throw new HarnessSkillError('mcp_config_invalid', `MCP server '${server.name}' args are invalid.`)
    }
    if (server.envKeys) {
      if (!Array.isArray(server.envKeys) || server.envKeys.length > 64 || server.envKeys.some((key: unknown) => typeof key !== 'string' || !ENV_NAME.test(key))) {
        throw new HarnessSkillError('mcp_config_invalid', `MCP server '${server.name}' envKeys are invalid.`)
      }
    }
    if (!Number.isSafeInteger(server.timeoutMs ?? 30_000) || (server.timeoutMs ?? 30_000) < 1_000 || (server.timeoutMs ?? 30_000) > 120_000) {
      throw new HarnessSkillError('mcp_config_invalid', `MCP server '${server.name}' timeoutMs must be 1000-120000.`)
    }
    if (server.enabledTools && (!Array.isArray(server.enabledTools) || server.enabledTools.length > 256 || server.enabledTools.some((tool: unknown) => typeof tool !== 'string' || tool.length < 1 || tool.length > 128))) {
      throw new HarnessSkillError('mcp_config_invalid', `MCP server '${server.name}' enabledTools are invalid.`)
    }
    return server
  })
}

function exposedToolName(server: string, tool: string) {
  const value = `mcp__${server}__${tool}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new HarnessSkillError('mcp_tool_name_invalid', `MCP tool from server '${server}' cannot be represented safely.`)
  }
  return value
}

function boundedResult(result: unknown): JsonValue {
  const value = jsonValue(result)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_RESULT_BYTES) return value
  return {
    truncated: true,
    byteLength: Buffer.byteLength(serialized, 'utf8'),
    sha256: createHash('sha256').update(serialized).digest('hex'),
  }
}

function authenticationRequired(content: unknown) {
  const text = JSON.stringify(content).toLowerCase()
  return text.includes('authentication_required') || text.includes('authorization required') || text.includes('oauth required')
}

function jsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    throw new HarnessSkillError('mcp_result_invalid', 'MCP returned a non-JSON result.')
  }
}

function normalizedInputSchema(value: unknown): JsonValue {
  const schema = jsonValue(value)
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema
  const { $schema, ...rest } = schema
  if ($schema === undefined || $schema === 'http://json-schema.org/draft-07/schema#') return rest
  return schema
}

function redactedMcpError(code: string, server: string, error: unknown) {
  void error
  return new HarnessSkillError(code, `MCP server '${server}' failed with a redacted local error.`)
}

function boundedText(value: string, max: number) { return value.trim().slice(0, max) }
function timeout(server: AgentMcpServerSpec) { return server.timeoutMs ?? 30_000 }
function resolvedEnvironment(server: AgentMcpServerSpec) {
  const environment = getDefaultEnvironment()
  for (const key of server.envKeys ?? []) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}
