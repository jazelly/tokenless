import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { G4fServiceClient } from './client.js'
import {
  G4F_PA_COMMIT,
  G4F_PYTHON_VERSION,
  G4F_SERVICE_REVISION,
  G4F_UPSTREAM_COMMIT,
  G4F_VERSION,
} from './constants.js'
import type { G4fServiceProcess } from './types.js'

const RUNTIME_METADATA_PROTOCOL = 'tokenless.g4f-runtime.v1'
const START_TIMEOUT_MS = 60_000

export type G4fRuntimeStatus = {
  installed: boolean
  runtimeDirectory: string
  pythonExecutable: string | null
  g4fVersion: string
  g4fCommit: string
  paCommit: string
}

export class G4fRuntimeManager {
  readonly runtimeDirectory: string
  readonly authRoot: string
  readonly paRoot: string
  private readonly sourceDirectory: string

  constructor(readonly homeDir: string) {
    this.runtimeDirectory = path.join(homeDir, 'runtime', 'g4f-service', G4F_VERSION)
    this.authRoot = path.join(homeDir, 'provider-auth', 'g4f')
    this.paRoot = path.join(this.runtimeDirectory, 'pa-providers')
    this.sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runtime/g4f-service')
  }

  async inspect(): Promise<G4fRuntimeStatus> {
    const pythonExecutable = this.pythonExecutable()
    try {
      const metadata = JSON.parse(await fs.readFile(this.metadataPath(), 'utf8')) as Record<string, unknown>
      await fs.access(pythonExecutable)
      const installed = metadata.protocol === RUNTIME_METADATA_PROTOCOL &&
        metadata.g4fVersion === G4F_VERSION &&
        metadata.g4fCommit === G4F_UPSTREAM_COMMIT &&
        metadata.paCommit === G4F_PA_COMMIT &&
        metadata.pythonVersion === G4F_PYTHON_VERSION
        && metadata.serviceRevision === G4F_SERVICE_REVISION
      return {
        installed,
        runtimeDirectory: this.runtimeDirectory,
        pythonExecutable: installed ? pythonExecutable : null,
        g4fVersion: G4F_VERSION,
        g4fCommit: G4F_UPSTREAM_COMMIT,
        paCommit: G4F_PA_COMMIT,
      }
    } catch {
      return {
        installed: false,
        runtimeDirectory: this.runtimeDirectory,
        pythonExecutable: null,
        g4fVersion: G4F_VERSION,
        g4fCommit: G4F_UPSTREAM_COMMIT,
        paCommit: G4F_PA_COMMIT,
      }
    }
  }

  async ensure(): Promise<G4fRuntimeStatus> {
    const current = await this.inspect()
    if (current.installed) return current
    await fs.mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 })
    await fs.chmod(this.runtimeDirectory, 0o700)
    for (const filename of ['service.py', 'pyproject.toml', 'uv.lock', 'NOTICE.md']) {
      await fs.copyFile(path.join(this.sourceDirectory, filename), path.join(this.runtimeDirectory, filename))
    }
    await runProcess('uv', [
      'sync',
      '--frozen',
      '--no-dev',
      '--project', this.runtimeDirectory,
      '--python', G4F_PYTHON_VERSION,
    ], { cwd: this.runtimeDirectory })
    await fs.mkdir(this.paRoot, { recursive: true, mode: 0o700 })
    await runProcess(this.pythonExecutable(), [
      '-c',
      'from g4f.mcp.pa_downloader import run_pa_download; run_pa_download(repo="gpt4free/pa-providers", ref="' + G4F_PA_COMMIT + '", force=True, directory=r"' + escapePythonString(this.paRoot) + '")',
    ], { cwd: this.runtimeDirectory })
    await fs.writeFile(this.metadataPath(), `${JSON.stringify({
      protocol: RUNTIME_METADATA_PROTOCOL,
      installedAt: new Date().toISOString(),
      pythonVersion: G4F_PYTHON_VERSION,
      g4fVersion: G4F_VERSION,
      g4fCommit: G4F_UPSTREAM_COMMIT,
      paCommit: G4F_PA_COMMIT,
      serviceRevision: G4F_SERVICE_REVISION,
    }, null, 2)}\n`, { mode: 0o600 })
    const installed = await this.inspect()
    if (!installed.installed) throw new Error('Tokenless G4F runtime installation could not be verified.')
    return installed
  }

  async start({ allowedRoots = [] }: { allowedRoots?: readonly string[] } = {}): Promise<G4fServiceProcess> {
    const status = await this.inspect()
    if (!status.installed) {
      const error = new Error('Tokenless G4F runtime is not installed; run tokenless setup.') as Error & { code?: string }
      error.code = 'g4f_runtime_not_installed'
      throw error
    }
    const port = await availableLoopbackPort()
    const origin = `http://127.0.0.1:${port}`
    const serviceKey = randomBytes(32).toString('base64url')
    await fs.mkdir(this.authRoot, { recursive: true, mode: 0o700 })
    const args = [
      path.join(this.runtimeDirectory, 'service.py'),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--auth-root', this.authRoot,
      '--pa-root', this.paRoot,
      ...allowedRoots.flatMap((root) => ['--allowed-root', path.resolve(root)]),
    ]
    const child = spawn(this.pythonExecutable(), args, {
      cwd: this.runtimeDirectory,
      env: {
        ...process.env,
        TOKENLESS_G4F_SERVICE_KEY: serviceKey,
        G4F_API_KEY: serviceKey,
        G4F_DISABLE_CUSTOM_API_KEY: 'false',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.resume()
    child.stderr.resume()
    const client = new G4fServiceClient(origin, serviceKey)
    try {
      const health = await waitForHealth(client, child)
      return {
        origin,
        health,
        client,
        close: async () => {
          await stopChild(child)
          await this.removeEmptyAuthDirectory()
        },
      }
    } catch (error) {
      await stopChild(child).catch(() => undefined)
      await this.removeEmptyAuthDirectory()
      throw error
    }
  }

  private async removeEmptyAuthDirectory() {
    await fs.rm(path.join(this.authRoot, '_empty'), { recursive: true, force: true })
  }

  private pythonExecutable() {
    return process.platform === 'win32'
      ? path.join(this.runtimeDirectory, '.venv', 'Scripts', 'python.exe')
      : path.join(this.runtimeDirectory, '.venv', 'bin', 'python')
  }

  private metadataPath() {
    return path.join(this.runtimeDirectory, 'runtime.json')
  }
}

async function waitForHealth(client: G4fServiceClient, child: ChildProcess) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw serviceExitError(child.exitCode)
    try {
      return await client.health(AbortSignal.timeout(1_000))
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('Timed out waiting for the private G4F service to become ready.')
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  await Promise.race([exited, timeout])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function serviceExitError(exitCode: number | null) {
  const error = new Error(`Private G4F service exited before readiness (code ${String(exitCode)}).`) as Error & { code?: string }
  error.code = 'g4f_service_start_failed'
  return error
}

async function availableLoopbackPort() {
  const server = net.createServer()
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Cannot allocate a loopback port for the private G4F service.'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function runProcess(command: string, args: readonly string[], { cwd }: { cwd: string }) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => reject(error))
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed with exit code ${String(code)}: ${sanitizeInstallError(stderr)}`))
    })
  })
}

function sanitizeInstallError(value: string) {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_000)
}

function escapePythonString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
