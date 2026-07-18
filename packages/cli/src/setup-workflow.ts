import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const TOKENLESS_SKILL_SOURCE = 'jazelly/tokenless'
export const TOKENLESS_SKILL_NAMES = Object.freeze(['tokenless', 'tokenless-install'] as const)

export type TokenlessSkillCheck = {
  ok: boolean
  source: typeof TOKENLESS_SKILL_SOURCE
  lockFile: string
  skills: Record<(typeof TOKENLESS_SKILL_NAMES)[number], {
    ok: boolean
    manifest: string
    sourceVerified: boolean
  }>
}

export async function inspectTokenlessSkills(home = os.homedir()): Promise<TokenlessSkillCheck> {
  const sharedRoot = path.join(home, '.agents')
  const lockFile = path.join(sharedRoot, '.skill-lock.json')
  const lock = await readJson(lockFile)
  const lockedSkills = isRecord(lock?.skills) ? lock.skills : {}
  const skills = Object.fromEntries(await Promise.all(TOKENLESS_SKILL_NAMES.map(async (name) => {
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
  return {
    ok: TOKENLESS_SKILL_NAMES.every((name) => skills[name].ok),
    source: TOKENLESS_SKILL_SOURCE,
    lockFile,
    skills,
  }
}

export async function installTokenlessSkills({
  home = os.homedir(),
  run = runSkillsCli,
}: {
  home?: string
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
  ]
  await run(command, args, {
    env: {
      ...process.env,
      HOME: home,
      DISABLE_TELEMETRY: '1',
    },
  })
  const check = await inspectTokenlessSkills(home)
  if (!check.ok) {
    const error = new Error('Tokenless skills command completed, but the GitHub-backed installation could not be verified.') as Error & { code?: string }
    error.code = 'tokenless_skill_install_unverified'
    throw error
  }
  return { command, args, check }
}

async function runSkillsCli(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) {
  await new Promise<void>((resolve, reject) => {
    execFile(command, [...args], {
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

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function canonicalGitHubSource(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\.git$/i, '').replace(/\/$/, '') : null
}
