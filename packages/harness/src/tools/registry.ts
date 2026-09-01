import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  HarnessSkillError,
  type HarnessToolCatalogEntry,
  type HarnessToolRegistry,
  type JsonValue,
} from '../contracts.js'
import { createStdioMcpToolRegistry } from '../mcp/stdio.js'

const execFileAsync = promisify(execFile)
const WORKSPACE_SERVER = 'tokenless-workspace'
const MAX_READ_BYTES = 1024 * 1024
const MAX_SEARCH_BYTES = 256 * 1024

const WORKSPACE_TOOLS: readonly HarnessToolCatalogEntry[] = [
  {
    name: 'workspace.read',
    description: 'Read a bounded range of UTF-8 text lines from a file inside the delegated workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to an existing file inside the delegated workspace; never use an absolute path.', minLength: 1, maxLength: 4096 },
        startLine: { type: 'integer', minimum: 1 },
        lineCount: { type: 'integer', minimum: 1, maximum: 400 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    source: 'filesystem',
    server: WORKSPACE_SERVER,
    serverToolName: 'read',
    readOnly: true,
    approval: 'allow_read_only',
  },
  {
    name: 'workspace.search',
    description: 'Search UTF-8 workspace files with ripgrep and return bounded line matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1024 },
        path: { type: 'string', description: 'Relative path to an existing file or directory inside the delegated workspace; use . when unsure and never use an absolute path.', minLength: 1, maxLength: 4096 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    source: 'filesystem',
    server: WORKSPACE_SERVER,
    serverToolName: 'search',
    readOnly: true,
    approval: 'allow_read_only',
  },
]

export function createAgentToolRegistry(): HarnessToolRegistry {
  const mcp = createStdioMcpToolRegistry()
  return {
    async catalog(servers, context) {
      const workspaceRoot = context?.workspaceRoot
      const workspace = workspaceRoot === undefined
        ? []
        : (await canonicalWorkspaceRoot(workspaceRoot), [...WORKSPACE_TOOLS])
      const catalog = [...workspace, ...await mcp.catalog(servers, context)]
      const names = new Set<string>()
      for (const entry of catalog) {
        if (names.has(entry.name)) throw new HarnessSkillError('harness_tool_duplicate', `Harness tool '${entry.name}' is duplicated.`)
        names.add(entry.name)
      }
      return catalog.toSorted((left, right) => left.name.localeCompare(right.name))
    },

    async execute(entry, argumentsValue, servers, context) {
      if (entry.server !== WORKSPACE_SERVER) return mcp.execute(entry, argumentsValue, servers, context)
      const workspaceRoot = context?.workspaceRoot
      if (workspaceRoot === undefined) throw new HarnessSkillError('harness_workspace_missing', 'The delegated run has no workspace root.')
      const root = await canonicalWorkspaceRoot(workspaceRoot)
      if (entry.serverToolName === 'read') return { status: 'succeeded', content: await readWorkspaceFile(root, argumentsValue) }
      if (entry.serverToolName === 'search') return { status: 'succeeded', content: await searchWorkspace(root, argumentsValue) }
      throw new HarnessSkillError('harness_tool_not_configured', `Workspace tool '${entry.name}' is not configured.`)
    },
  }
}

async function canonicalWorkspaceRoot(value: string) {
  const requested = path.resolve(value)
  const stat = await fs.lstat(requested).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new HarnessSkillError('harness_workspace_invalid', 'The delegated workspace root must be an existing regular directory.')
  }
  return fs.realpath(requested)
}

async function workspaceTarget(root: string, value: unknown, defaultPath?: string) {
  const relative = value === undefined ? defaultPath : value
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new HarnessSkillError('harness_workspace_path_invalid', 'Workspace tool paths must be nonempty relative paths.')
  }
  const requested = path.resolve(root, relative)
  if (!isWithin(root, requested)) throw new HarnessSkillError('harness_workspace_path_invalid', 'Workspace tool path escapes the delegated root.')
  const canonical = await fs.realpath(requested).catch(() => null)
  if (!canonical || !isWithin(root, canonical)) {
    throw new HarnessSkillError('harness_workspace_path_invalid', 'Workspace tool path is missing or resolves outside the delegated root.')
  }
  return { requested, relative: path.relative(root, canonical) || '.', canonical }
}

async function readWorkspaceFile(root: string, input: Record<string, JsonValue>): Promise<JsonValue> {
  const target = await workspaceTarget(root, input.path)
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(target.canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    throw new HarnessSkillError('harness_workspace_read_invalid', 'Workspace file could not be opened safely.')
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
      throw new HarnessSkillError('harness_workspace_read_invalid', `Workspace file must be a regular UTF-8 file no larger than ${MAX_READ_BYTES} bytes.`)
    }
    await verifyOpenedWorkspaceFile(root, target.requested, handle)
    const bytes = await handle.readFile()
    await verifyOpenedWorkspaceFile(root, target.requested, handle)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new HarnessSkillError('harness_workspace_read_invalid', 'Workspace file is not UTF-8 text.')
    }
    const lines = text.split(/\r?\n/u)
    const startLine = optionalPositiveInteger(input.startLine, 1, 'startLine')
    const lineCount = optionalPositiveInteger(input.lineCount, 200, 'lineCount')
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount)
    return {
      path: target.relative,
      startLine,
      endLine: selected.length === 0 ? startLine - 1 : startLine + selected.length - 1,
      text: selected.join('\n'),
    }
  } finally {
    await handle.close()
  }
}

async function searchWorkspace(root: string, input: Record<string, JsonValue>): Promise<JsonValue> {
  const query = input.query
  if (typeof query !== 'string' || query.length === 0) throw new HarnessSkillError('harness_workspace_search_invalid', 'Workspace search query is required.')
  const target = await workspaceTarget(root, input.path, '.')
  const identity = await fs.stat(target.canonical, { bigint: true })
  if (!identity.isFile() && !identity.isDirectory()) {
    throw new HarnessSkillError('harness_workspace_search_invalid', 'Workspace search path must be a regular file or directory.')
  }
  await verifyWorkspacePathIdentity(root, target.requested, identity)
  try {
    const { stdout } = await execFileAsync('rg', [
      '--line-number', '--no-heading', '--color', 'never', '--glob', '!.git', '--', query, target.relative,
    ], { cwd: root, encoding: 'utf8', maxBuffer: MAX_SEARCH_BYTES, timeout: 30_000 })
    await verifyWorkspacePathIdentity(root, target.requested, identity)
    return { path: target.relative, query, matches: stdout.trimEnd() }
  } catch (error) {
    const failure = error as { code?: string | number }
    if (Number(failure.code) === 1) {
      await verifyWorkspacePathIdentity(root, target.requested, identity)
      return { path: target.relative, query, matches: '' }
    }
    if (error instanceof HarnessSkillError) throw error
    throw new HarnessSkillError('harness_workspace_search_failed', 'Workspace search failed at the local ripgrep boundary.')
  }
}

async function verifyOpenedWorkspaceFile(
  root: string,
  requested: string,
  handle: Awaited<ReturnType<typeof fs.open>>,
) {
  const opened = await handle.stat({ bigint: true })
  if (!opened.isFile()) throw new HarnessSkillError('harness_workspace_read_invalid', 'Workspace file must remain a regular file.')
  await verifyWorkspacePathIdentity(root, requested, opened)
}

async function verifyWorkspacePathIdentity(
  root: string,
  requested: string,
  expected: { dev: bigint; ino: bigint },
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const firstPath = await fs.realpath(requested).catch(() => null)
    if (!firstPath || !isWithin(root, firstPath)) break
    const first = await fs.stat(firstPath, { bigint: true }).catch(() => null)
    const secondPath = await fs.realpath(requested).catch(() => null)
    if (!secondPath || !isWithin(root, secondPath)) break
    const second = await fs.stat(secondPath, { bigint: true }).catch(() => null)
    if (firstPath === secondPath && first && second && sameFile(expected, first) && sameFile(expected, second)) return
  }
  throw new HarnessSkillError('harness_workspace_path_changed', 'Workspace path changed while root containment was being enforced.')
}

function sameFile(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }) {
  return left.dev === right.dev && left.ino === right.ino
}

function optionalPositiveInteger(value: JsonValue | undefined, fallback: number, label: string) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new HarnessSkillError('harness_workspace_arguments_invalid', `${label} must be a positive integer.`)
  }
  return Number(value)
}

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
