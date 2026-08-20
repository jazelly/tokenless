import fs from 'node:fs/promises'
import path from 'node:path'

export const DSH_INTEGRATION_PROTOCOL = 'tokenless.dsh-integration/v1' as const
const BLOCK_START = '# tokenless-dsh-integration v1'
const BLOCK_END = '# /tokenless-dsh-integration'

export type DshIntegrationInput = {
  dshHome: string
  dshProfile: string
  tokenlessHome: string
  provider: string
  profile: string
  command: { executable: string; script: string }
}

export type DshIntegrationStatus = {
  protocol: typeof DSH_INTEGRATION_PROTOCOL
  agent: 'dsh'
  installed: boolean
  dshHome: string
  dshProfile: string
  patchPath: string
  providerName: 'tokenless-harness'
  execution: 'tokenless-harness'
}

export async function installDshIntegration(input: DshIntegrationInput): Promise<DshIntegrationStatus> {
  const resolved = resolveInput(input)
  const previous = await readOptional(resolved.patchPath)
  const next = upsertBlock(previous ?? '[]\n', integrationBlock(resolved))
  await writeAtomic(resolved.patchPath, next)
  return inspectResolved(resolved, next)
}

export async function inspectDshIntegration(input: DshIntegrationInput): Promise<DshIntegrationStatus> {
  const resolved = resolveInput(input)
  return inspectResolved(resolved, await readOptional(resolved.patchPath) ?? '')
}

export async function uninstallDshIntegration(input: DshIntegrationInput): Promise<DshIntegrationStatus> {
  const resolved = resolveInput(input)
  const previous = await readOptional(resolved.patchPath)
  if (previous !== null) await writeAtomic(resolved.patchPath, removeBlock(previous))
  return inspectResolved(resolved, previous === null ? '' : removeBlock(previous))
}

function resolveInput(input: DshIntegrationInput) {
  const dshHome = path.resolve(requiredText(input.dshHome, 'dshHome'))
  const dshProfile = requiredSlug(input.dshProfile, 'dshProfile')
  const tokenlessHome = path.resolve(requiredText(input.tokenlessHome, 'tokenlessHome'))
  const provider = requiredSlug(input.provider, 'provider')
  const profile = requiredSlug(input.profile, 'profile')
  const executable = path.resolve(requiredText(input.command?.executable, 'command.executable'))
  const script = path.resolve(requiredText(input.command?.script, 'command.script'))
  const adapterPath = path.resolve(path.dirname(script), '..', 'integrations', 'dsh-tokenless-harness.mjs')
  return {
    dshHome, dshProfile, tokenlessHome, provider, profile, executable, script, adapterPath,
    patchPath: path.join(dshHome, 'profiles', dshProfile, 'cordis.patch.yml'),
  }
}

function integrationBlock(input: ReturnType<typeof resolveInput>) {
  const quote = (value: string) => JSON.stringify(value)
  return [
    BLOCK_START,
    '- insert:',
    '    - id: subagent-tokenless-harness',
    `      name: ${quote(input.adapterPath)}`,
    '      config:',
    '        providerName: tokenless-harness',
    `        nodeExecutable: ${quote(input.executable)}`,
    `        cliScript: ${quote(input.script)}`,
    `        tokenlessHome: ${quote(input.tokenlessHome)}`,
    `        provider: ${quote(input.provider)}`,
    `        profile: ${quote(input.profile)}`,
    '        timeoutMs: 600000',
    '        disposeGraceMs: 3000',
    '- id: tool-subagent',
    '  config:',
    '    provider: tokenless-harness',
    '    toolName: subagent',
    '    backgroundMode: one-shot',
    '    maxDepth: provider-managed',
    BLOCK_END,
  ].join('\n')
}

function upsertBlock(source: string, block: string) {
  const without = removeBlock(source)
  const base = without.replace(/^\s*\[\]\s*$/mu, '').trimEnd()
  return `${base.length > 0 ? `${base}\n\n` : ''}${block}\n`
}

function removeBlock(source: string) {
  const start = source.indexOf(BLOCK_START)
  if (start < 0) return source
  const end = source.indexOf(BLOCK_END, start)
  if (end < 0) throw new Error('Tokenless DSH integration block is incomplete; repair it before uninstalling.')
  const tail = end + BLOCK_END.length
  const without = `${source.slice(0, start)}${source.slice(tail)}`.trim()
  return without.length > 0 ? `${without}\n` : '[]\n'
}

function inspectResolved(input: ReturnType<typeof resolveInput>, source: string): DshIntegrationStatus {
  const installed = source.includes(BLOCK_START) && source.includes(BLOCK_END) &&
    source.includes('provider: tokenless-harness') && source.includes(JSON.stringify(input.adapterPath))
  return {
    protocol: DSH_INTEGRATION_PROTOCOL,
    agent: 'dsh',
    installed,
    dshHome: input.dshHome,
    dshProfile: input.dshProfile,
    patchPath: input.patchPath,
    providerName: 'tokenless-harness',
    execution: 'tokenless-harness',
  }
}

async function readOptional(filePath: string) {
  try { return await fs.readFile(filePath, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tokenless-${process.pid}`
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  await fs.rename(temporary, filePath)
}

function requiredText(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`Tokenless DSH integration ${label} must be a nonempty string.`)
  }
  return value
}

function requiredSlug(value: unknown, label: string) {
  const text = requiredText(value, label)
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(text)) {
    throw new Error(`Tokenless DSH integration ${label} must be a profile/provider slug.`)
  }
  return text
}
