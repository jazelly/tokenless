import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_BINARY_BUILD_INFO_PROTOCOL = 'tokenless.native-binary-build-info.v1'

const scriptPath = fileURLToPath(import.meta.url)
const cliRoot = path.resolve(path.dirname(scriptPath), '..')

export function verifyNativePackage(packageRoot = process.cwd()) {
  const manifest = readJson(path.join(packageRoot, 'package.json'), 'native package manifest')
  const cliManifest = readJson(path.join(cliRoot, 'package.json'), 'tokenless package manifest')
  const platform = manifest.os?.[0]
  const arch = manifest.cpu?.[0]
  const expectedName = `tokenless-native-${platform}-${arch}`
  if (
    manifest.name !== expectedName ||
    manifest.version !== cliManifest.version ||
    !Array.isArray(manifest.os) || manifest.os.length !== 1 ||
    !Array.isArray(manifest.cpu) || manifest.cpu.length !== 1 ||
    manifest.tokenlessRuntime?.protocol !== 'tokenless.native-package.v1' ||
    manifest.tokenlessRuntime?.platform !== platform ||
    manifest.tokenlessRuntime?.arch !== arch
  ) {
    throw new Error(`Native package manifest does not match tokenless@${cliManifest.version}: ${packageRoot}`)
  }
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`Native package ${manifest.name} must be packed on ${platform}-${arch}, not ${process.platform}-${process.arch}.`)
  }

  const suffix = platform === 'win32' ? '.exe' : ''
  for (const binaryName of ['tokenless-daemon']) {
    const binary = path.join(packageRoot, 'bin', `${binaryName}${suffix}`)
    const stat = fs.statSync(binary)
    if (!stat.isFile() || stat.size < 100_000) {
      throw new Error(`Native package binary is missing or implausibly small: ${binary}`)
    }
    const prefix = fs.readFileSync(binary).subarray(0, 2).toString('binary')
    if (prefix === '#!') throw new Error(`Native package contains a script instead of a Rust binary: ${binary}`)
    if (platform === 'win32' && prefix !== 'MZ') throw new Error(`Windows native binary is not PE format: ${binary}`)
    if (platform !== 'win32' && (stat.mode & 0o111) === 0) throw new Error(`Native binary is not executable: ${binary}`)

    let rawBuildInfo
    try {
      rawBuildInfo = execFileSync(binary, ['--tokenless-build-info'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new Error(`Native binary did not return build identity within 5 seconds: ${binary}`, { cause: error })
    }
    let buildInfo
    try {
      buildInfo = JSON.parse(rawBuildInfo)
    } catch (error) {
      throw new Error(`Native binary returned invalid build identity JSON: ${binary}`, { cause: error })
    }
    validateNativeBuildInfo(buildInfo, {
      binary: binaryName,
      version: manifest.version,
      platform,
      arch,
    })
  }
}

export function validateNativeBuildInfo(buildInfo, expected) {
  const expectedBuildInfo = {
    protocol: NATIVE_BINARY_BUILD_INFO_PROTOCOL,
    binary: expected.binary,
    version: expected.version,
    platform: expected.platform,
    arch: expected.arch,
  }
  if (
    !buildInfo ||
    typeof buildInfo !== 'object' ||
    Array.isArray(buildInfo) ||
    JSON.stringify(Object.keys(buildInfo).sort()) !== JSON.stringify(Object.keys(expectedBuildInfo).sort()) ||
    Object.entries(expectedBuildInfo).some(([key, value]) => buildInfo[key] !== value)
  ) {
    throw new Error(
      `Native binary build identity mismatch: expected ${expected.binary}@${expected.version} for ${expected.platform}-${expected.arch}.`
    )
  }
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${file}`, { cause: error })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  verifyNativePackage()
}
