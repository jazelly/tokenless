import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function tokenlessHome(explicitHome = process.env.TOKENLESS_HOME) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.tokenless'))
}

export async function readBootstrapDaemonUrl(homeDir = tokenlessHome()) {
  const config = await readBootstrapConfig(homeDir)
  return typeof config?.daemonUrl === 'string' ? config.daemonUrl : null
}

export async function readBootstrapLanguage(homeDir = tokenlessHome()) {
  const config = await readBootstrapConfig(homeDir)
  return config?.language === 'zh-CN' || config?.language === 'en' ? config.language : null
}

async function readBootstrapConfig(homeDir: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
