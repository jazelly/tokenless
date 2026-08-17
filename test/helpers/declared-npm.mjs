import { execFileSync } from 'node:child_process'

export function execDeclaredNpmSync(args, options) {
  const npmCli = process.env.npm_execpath
  if (npmCli) return execFileSync(process.execPath, [npmCli, ...args], options)
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options)
  }
  return execFileSync('npm', args, options)
}
