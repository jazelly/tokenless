import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createStdioMcpToolRegistry } from '../packages/web-agent-harness/dist/src/index.js'

test('Harness discovers and calls the official MCP everything server over real stdio', async () => {
  const registry = createStdioMcpToolRegistry()
  const servers = [{
    name: 'everything',
    command: process.execPath,
    args: [path.resolve('node_modules/@modelcontextprotocol/server-everything/dist/index.js')],
    enabledTools: ['echo'],
    timeoutMs: 30_000,
  }]

  const catalog = await registry.catalog(servers)
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].name, 'mcp__everything__echo')
  assert.equal(catalog[0].readOnly, false)
  assert.equal(catalog[0].approval, 'always')

  const result = await registry.execute(catalog[0], { message: 'real-mcp-boundary' }, servers)
  assert.equal(result.status, 'succeeded')
  assert.match(JSON.stringify(result.content), /Echo: real-mcp-boundary/)
})
