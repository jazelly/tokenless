import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenlessPackageVersion } from '#tokenless-server/platform-package.js'

const packagedSkillsRoot = fileURLToPath(new URL('../../skills/', import.meta.url))
export const TOKENLESS_SKILL_NAMES = Object.freeze(['tokenless', 'tokenless-install'] as const)

// Copy to existing agent roots; universal agents use the canonical .agents copy.
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

type SkillFiles = Map<string, Buffer>
type SkillStatus = { ok: boolean; manifest: string; sourceVerified: boolean }

export type TokenlessSkillCheck = {
  ok: boolean
  source: 'package' | 'checkout'
  version: string
  sourceDirectory: string
  skills: Record<(typeof TOKENLESS_SKILL_NAMES)[number], SkillStatus>
  targets: Record<string, {
    root: string
    skills: Record<(typeof TOKENLESS_SKILL_NAMES)[number], SkillStatus>
  }>
}

export async function inspectTokenlessSkills(
  home = process.env.TOKENLESS_SETUP_SKILL_HOME ?? os.homedir(),
  { codexHome, sourceRoot = packagedSkillsRoot }: { codexHome?: string | undefined; sourceRoot?: string } = {},
): Promise<TokenlessSkillCheck> {
  const targets = Object.fromEntries(await Promise.all((await skillTargets(home, codexHome)).map(async (target) => {
    const skills = Object.fromEntries(await Promise.all(TOKENLESS_SKILL_NAMES.map(async (name) => {
      const directory = path.join(target.root, 'skills', name)
      const [expected, actual] = await Promise.all([
        readSkillFiles(path.join(sourceRoot, name)),
        readSkillFiles(directory),
      ])
      const sourceVerified = expected !== null && actual !== null && expected.size === actual.size &&
        [...expected].every(([file, content]) => actual.get(file)?.equals(content) === true)
      return [name, { ok: sourceVerified, manifest: path.join(directory, 'SKILL.md'), sourceVerified }]
    }))) as TokenlessSkillCheck['skills']
    return [target.name, { root: target.root, skills }]
  }))) as TokenlessSkillCheck['targets']
  return {
    ok: Object.values(targets).every((target) => TOKENLESS_SKILL_NAMES.every((name) => target.skills[name].ok)),
    source: sourceRoot === packagedSkillsRoot ? 'package' : 'checkout',
    version: tokenlessPackageVersion(),
    sourceDirectory: sourceRoot,
    skills: targets.universal!.skills,
    targets,
  }
}

export async function installTokenlessSkills({
  home = process.env.TOKENLESS_SETUP_SKILL_HOME ?? os.homedir(),
  codexHome,
  sourceRoot = packagedSkillsRoot,
}: { home?: string; codexHome?: string | undefined; sourceRoot?: string } = {}) {
  // Validate both bundled skills before replacing any installed copy.
  for (const name of TOKENLESS_SKILL_NAMES) {
    if (await readSkillFiles(path.join(sourceRoot, name)) === null) {
      throw Object.assign(new Error('The installed Tokenless API package is missing a complete skill. / 已安装的 Tokenless API 包缺少完整 skill。'), {
        code: 'tokenless_skill_package_missing',
      })
    }
  }
  for (const target of await skillTargets(home, codexHome)) {
    for (const name of TOKENLESS_SKILL_NAMES) {
      const destination = path.join(target.root, 'skills', name)
      await fs.rm(destination, { recursive: true, force: true })
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.cp(path.join(sourceRoot, name), destination, { recursive: true })
    }
  }
  const check = await inspectTokenlessSkills(home, { codexHome, sourceRoot })
  if (!check.ok) {
    throw Object.assign(new Error('Tokenless API skill synchronization could not be verified. / 无法验证 Tokenless API skill 同步结果。'), {
      code: 'tokenless_skill_install_unverified',
    })
  }
  return { check }
}

async function skillTargets(home: string, codexHome?: string) {
  const roots = [
    { name: 'universal', root: path.join(home, '.agents') },
    ...(await existingTokenlessAgentTargets(home, codexHome)).map((target) => ({ name: target.agent, root: target.root })),
    ...(await existingLegacyTokenlessSkillRoots(home)).map((root) => ({ name: 'legacy-agent', root })),
  ]
  return [...new Map(roots.map((target) => [target.root, target])).values()]
}

async function readSkillFiles(directory: string): Promise<SkillFiles | null> {
  try {
    const files: SkillFiles = new Map()
    async function visit(relative: string) {
      for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
        const file = path.join(relative, entry.name)
        if (entry.isDirectory()) await visit(file)
        else if (entry.isFile()) files.set(file, await fs.readFile(path.join(directory, file)))
        else throw new Error('Skill resources must be regular files or directories.')
      }
    }
    await visit('')
    return files.has('SKILL.md') ? files : null
  } catch {
    return null
  }
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

async function isDirectory(directory: string) {
  return await fs.stat(directory).then((value) => value.isDirectory(), () => false)
}

function isDefaultHome(home: string) {
  return path.resolve(home) === path.resolve(os.homedir())
}

