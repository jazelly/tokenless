import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const TOKENLESS_SKILL_SOURCE = 'jazelly/tokenless'
export const TOKENLESS_SKILL_NAMES = Object.freeze(['tokenless', 'tokenless-install'] as const)

// Keep the direct targets aligned with the globally supported agents that have
// dedicated hook/config roots in rtk. Agents whose skills CLI target is the
// universal .agents directory are covered by the canonical installation below.
const TOKENLESS_AGENT_SKILL_TARGETS = Object.freeze([
  { agent: 'claude-code', directory: '.claude' },
  { agent: 'codex', directory: '.codex' },
  { agent: 'cursor', directory: '.cursor' },
  { agent: 'github-copilot', directory: '.copilot' },
  { agent: 'gemini-cli', directory: '.gemini' },
  { agent: 'hermes-agent', directory: '.hermes' },
  { agent: 'opencode', directory: '.config/opencode' },
  { agent: 'pi', directory: '.pi/agent' },
  { agent: 'windsurf', directory: '.codeium/windsurf' },
] as const)

const TOKENLESS_LEGACY_SKILL_ROOTS = Object.freeze(['.agent'] as const)

export type TokenlessSkillCheck = {
  ok: boolean
  source: typeof TOKENLESS_SKILL_SOURCE
  lockFile: string
  skills: Record<(typeof TOKENLESS_SKILL_NAMES)[number], {
    ok: boolean
    manifest: string
    sourceVerified: boolean
  }>
  targets: Record<string, {
    root: string
    skills: Record<(typeof TOKENLESS_SKILL_NAMES)[number], {
      ok: boolean
      manifest: string
      sourceVerified: boolean
    }>
  }>
}

export async function inspectTokenlessSkills(
  home = os.homedir(),
  { codexHome }: { codexHome?: string | undefined } = {},
): Promise<TokenlessSkillCheck> {
  const sharedRoot = path.join(home, '.agents')
  const lockFile = path.join(sharedRoot, '.skill-lock.json')
  const lock = await readJson(lockFile)
  const lockedSkills = isRecord(lock?.skills) ? lock.skills : {}
  const skills = await inspectCanonicalSkills(sharedRoot, lockedSkills)
  const targets = await inspectTokenlessSkillTargets(home, skills, codexHome)
  return {
    ok: TOKENLESS_SKILL_NAMES.every((name) => skills[name].ok) &&
      Object.values(targets).every((target) => TOKENLESS_SKILL_NAMES.every((name) => target.skills[name].ok)),
    source: TOKENLESS_SKILL_SOURCE,
    lockFile,
    skills,
    targets,
  }
}

export async function installTokenlessSkills({
  home = os.homedir(),
  codexHome,
  run = runSkillsCli,
}: {
  home?: string
  codexHome?: string | undefined
  run?: (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<void>
} = {}) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = [
    '--yes',
    'skills',
    'add',
    TOKENLESS_SKILL_SOURCE,
    '--skill', 'tokenless',
    '--skill', 'tokenless-install',
    '--global',
    '--yes',
    '--agent',
    'universal',
  ]
  await run(command, args, {
    env: skillsCliEnvironment(home),
  })
  const lock = await readJson(path.join(home, '.agents', '.skill-lock.json'))
  const canonicalCheck = await inspectCanonicalSkills(
    path.join(home, '.agents'),
    isRecord(lock?.skills) ? lock.skills : {},
  )
  if (!TOKENLESS_SKILL_NAMES.every((name) => canonicalCheck[name].ok)) {
    const error = new Error('Tokenless skills command completed, but the GitHub-backed installation could not be verified.') as Error & { code?: string }
    error.code = 'tokenless_skill_install_unverified'
    throw error
  }
  await syncTokenlessSkillRoots(home, codexHome)
  const check = await inspectTokenlessSkills(home, { codexHome })
  if (!check.ok) {
    const error = new Error('Tokenless skills command completed, but the GitHub-backed installation could not be verified.') as Error & { code?: string }
    error.code = 'tokenless_skill_install_unverified'
    throw error
  }
  return { command, args, check }
}

async function inspectCanonicalSkills(
  sharedRoot: string,
  lockedSkills: Record<string, unknown>,
): Promise<TokenlessSkillCheck['skills']> {
  return Object.fromEntries(await Promise.all(TOKENLESS_SKILL_NAMES.map(async (name) => {
    const manifest = path.join(sharedRoot, 'skills', name, 'SKILL.md')
    const record = isRecord(lockedSkills[name]) ? lockedSkills[name] : null
    const sourceVerified = record?.source === TOKENLESS_SKILL_SOURCE &&
      record?.sourceType === 'github' &&
      canonicalGitHubSource(record?.sourceUrl) === `https://github.com/${TOKENLESS_SKILL_SOURCE}`
    return [name, {
      ok: await isFile(manifest) && sourceVerified,
      manifest,
      sourceVerified,
    }]
  }))) as TokenlessSkillCheck['skills']
}

async function inspectTokenlessSkillTargets(
  home: string,
  canonicalSkills: TokenlessSkillCheck['skills'],
  codexHome?: string | undefined,
): Promise<TokenlessSkillCheck['targets']> {
  const roots = [
    { name: 'universal', root: path.join(home, '.agents') },
    ...(await existingTokenlessAgentTargets(home, codexHome)).map((target) => ({
      name: target.agent,
      root: target.root,
    })),
    ...(await existingLegacyTokenlessSkillRoots(home)).map((root) => ({
      name: 'legacy-agent',
      root,
    })),
  ]
  const uniqueRoots = [...new Map(roots.map((target) => [target.root, target])).values()]
  return Object.fromEntries(await Promise.all(uniqueRoots.map(async (target) => [
    target.name,
    {
      root: target.root,
      skills: await inspectSkillRoot(target.root, canonicalSkills),
    },
  ]))) as TokenlessSkillCheck['targets']
}

async function inspectSkillRoot(
  root: string,
  canonicalSkills: TokenlessSkillCheck['skills'],
): Promise<TokenlessSkillCheck['targets'][string]['skills']> {
  return Object.fromEntries(await Promise.all(TOKENLESS_SKILL_NAMES.map(async (name) => {
    const manifest = path.join(root, 'skills', name, 'SKILL.md')
    const sourceVerified = canonicalSkills[name].ok && await filesEqual(manifest, canonicalSkills[name].manifest)
    return [name, {
      ok: sourceVerified,
      manifest,
      sourceVerified,
    }]
  }))) as TokenlessSkillCheck['targets'][string]['skills']
}

async function existingTokenlessAgentTargets(home: string, codexHome?: string | undefined) {
  const targets = []
  for (const target of TOKENLESS_AGENT_SKILL_TARGETS) {
    const root = target.agent === 'codex' && codexHome
      ? path.resolve(codexHome)
      : resolveTokenlessAgentRoot(home, target.agent, target.directory)
    if (await isDirectory(root)) targets.push({ ...target, root })
  }
  return targets
}

async function existingLegacyTokenlessSkillRoots(home: string) {
  const roots = []
  for (const directory of TOKENLESS_LEGACY_SKILL_ROOTS) {
    const root = path.join(home, directory)
    if (await isDirectory(root)) roots.push(root)
  }
  return roots
}

function resolveTokenlessAgentRoot(home: string, agent: string, directory: string) {
  if (isDefaultHome(home) && agent === 'codex') {
    return process.env.CODEX_HOME?.trim() || path.join(home, directory)
  }
  if (isDefaultHome(home) && agent === 'claude-code') {
    return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, directory)
  }
  if (isDefaultHome(home) && agent === 'opencode' && process.env.XDG_CONFIG_HOME?.trim()) {
    return path.join(process.env.XDG_CONFIG_HOME.trim(), 'opencode')
  }
  return path.join(home, directory)
}

function skillsCliEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DISABLE_TELEMETRY: '1',
  }
  if (process.platform === 'win32') environment.USERPROFILE = home
  if (!isDefaultHome(home)) {
    environment.CODEX_HOME = path.join(home, '.codex')
    environment.CLAUDE_CONFIG_DIR = path.join(home, '.claude')
    environment.XDG_CONFIG_HOME = path.join(home, '.config')
  }
  return environment
}

async function syncTokenlessSkillRoots(home: string, codexHome?: string | undefined) {
  const roots = [
    ...(await existingTokenlessAgentTargets(home, codexHome)).map((target) => target.root),
    ...(await existingLegacyTokenlessSkillRoots(home)),
  ]
  const uniqueRoots = [...new Set(roots)]
  const sourceRoot = path.join(home, '.agents', 'skills')
  for (const root of uniqueRoots) {
    for (const name of TOKENLESS_SKILL_NAMES) {
      const source = path.join(sourceRoot, name)
      const destination = path.join(root, 'skills', name)
      await fs.rm(destination, { recursive: true, force: true })
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.cp(source, destination, { recursive: true })
    }
  }
}

async function runSkillsCli(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) {
  const executable = process.platform === 'win32'
    ? process.env.ComSpec?.trim() || 'cmd.exe'
    : command
  const executableArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', command, ...args]
    : [...args]
  await new Promise<void>((resolve, reject) => {
    execFile(executable, executableArgs, {
      env: options.env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error) => error ? reject(error) : resolve())
  })
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

async function isFile(file: string) {
  return await fs.stat(file).then((value) => value.isFile(), () => false)
}

async function isDirectory(directory: string) {
  return await fs.stat(directory).then((value) => value.isDirectory(), () => false)
}

async function filesEqual(left: string, right: string) {
  const [leftContent, rightContent] = await Promise.all([
    fs.readFile(left),
    fs.readFile(right),
  ]).catch(() => [null, null] as const)
  return leftContent !== null && rightContent !== null && leftContent.equals(rightContent)
}

function isDefaultHome(home: string) {
  return path.resolve(home) === path.resolve(os.homedir())
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalGitHubSource(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\.git$/i, '').replace(/\/$/, '') : null
}
