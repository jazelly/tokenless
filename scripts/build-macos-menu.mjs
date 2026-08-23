#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const swiftPackageRoot = path.join(repositoryRoot, 'apps', 'macos-menu')
const cliRoot = path.join(repositoryRoot, 'packages', 'cli')
const cliDistSource = path.join(cliRoot, 'dist')
const cliManifestPath = path.join(cliRoot, 'package.json')
const outputRoot = path.join(repositoryRoot, 'dist', 'macos')
const appPath = path.join(outputRoot, 'Tokenless API.app')
const zipPath = path.join(outputRoot, 'Tokenless API.zip')
const scratchPath = path.join(outputRoot, '.swift-build')
const executableName = 'TokenlessMenuBar'
const runtimeDirectoryName = 'runtime'
const runtimeNodeName = 'node'
const runtimeCliDirectoryName = 'cli'
const koffiPlatformPackage = '@koromix/koffi-darwin-arm64'
const runtimeDependencySeeds = [
  '@modelcontextprotocol/sdk',
  'impers',
  'playwright-core',
  'ajv',
  'ajv-formats',
]

if (process.platform !== 'darwin') {
  throw new Error('The macOS menu app must be built on macOS / macOS 菜单栏应用必须在 macOS 上构建。')
}

const cliManifest = readJSON(cliManifestPath, 'CLI package manifest')
const nodeSourcePath = resolveNodeExecutable(process.argv.slice(2))
const version = typeof cliManifest.version === 'string' ? cliManifest.version : '0.0.0'
const iconSource = path.join(repositoryRoot, 'assets', 'tokenless-mark.png')
const cliEntrypointSource = path.join(cliDistSource, 'src', 'tokenless.mjs')

requireDirectory(cliDistSource, 'CLI dist')
requireFile(cliEntrypointSource, 'CLI entrypoint')
requireFile(iconSource, 'menu bar icon')
if (cliManifest.name !== 'tokenless' || typeof cliManifest.imports !== 'object' || cliManifest.imports === null) {
  throw new Error(`CLI package.json is missing the bundled package contract / CLI package.json 缺少内置 package contract：${cliManifestPath}`)
}

fs.mkdirSync(outputRoot, { recursive: true })
fs.rmSync(appPath, { recursive: true, force: true })
fs.rmSync(zipPath, { force: true })

run('swift', [
  'build',
  '--configuration', 'release',
  '--arch', 'arm64',
  '--package-path', swiftPackageRoot,
  '--scratch-path', scratchPath,
])

const binPath = execFileSync('swift', [
  'build',
  '--configuration', 'release',
  '--arch', 'arm64',
  '--package-path', swiftPackageRoot,
  '--scratch-path', scratchPath,
  '--show-bin-path',
], { encoding: 'utf8' }).trim()
const binaryPath = path.join(binPath, executableName)
requireExecutable(binaryPath, 'Swift app executable')
validateArm64MachO(binaryPath, 'Swift app executable')

const contentsPath = path.join(appPath, 'Contents')
const macOSPath = path.join(contentsPath, 'MacOS')
const resourcesPath = path.join(contentsPath, 'Resources')
const runtimePath = path.join(resourcesPath, runtimeDirectoryName)
const runtimeNodePath = path.join(runtimePath, runtimeNodeName)
const runtimeCliPath = path.join(runtimePath, runtimeCliDirectoryName)
const runtimeCliDistPath = path.join(runtimeCliPath, 'dist')
const runtimeCliManifestPath = path.join(runtimeCliPath, 'package.json')

fs.mkdirSync(macOSPath, { recursive: true })
fs.mkdirSync(resourcesPath, { recursive: true })
fs.mkdirSync(runtimePath, { recursive: true })
fs.mkdirSync(runtimeCliPath, { recursive: true })
fs.copyFileSync(binaryPath, path.join(macOSPath, executableName))
fs.chmodSync(path.join(macOSPath, executableName), 0o755)
fs.copyFileSync(iconSource, path.join(resourcesPath, 'tokenless-mark.png'))
fs.copyFileSync(nodeSourcePath, runtimeNodePath)
fs.chmodSync(runtimeNodePath, 0o755)
fs.copyFileSync(cliManifestPath, runtimeCliManifestPath)
copyCliDist(cliDistSource, runtimeCliDistPath)
copyProductionDependencies(path.join(runtimeCliPath, 'node_modules'))
fs.writeFileSync(path.join(contentsPath, 'Info.plist'), infoPlist(version), 'utf8')

const runtimeCliEntrypointPath = path.join(runtimeCliDistPath, 'src', 'tokenless.mjs')
requireExecutable(runtimeNodePath, 'bundled Node runtime')
requireFile(runtimeCliManifestPath, 'bundled CLI package.json')
requireFile(runtimeCliEntrypointPath, 'bundled CLI entrypoint')
validateArm64MachO(runtimeNodePath, 'bundled Node runtime')
const koffiNativePath = path.join(
  runtimeCliPath,
  'node_modules',
  '@koromix',
  'koffi-darwin-arm64',
  'darwin_arm64',
  'koffi.node',
)
requireFile(koffiNativePath, 'bundled koffi macOS arm64 native addon')
validateArm64MachO(koffiNativePath, 'bundled koffi macOS arm64 native addon')
assertNoSymlinks(runtimePath)
assertPathAbsent(path.join(runtimeCliDistPath, 'runtime', 'g4f-service', '.venv'))

run('plutil', ['-lint', path.join(contentsPath, 'Info.plist')])
run('codesign', ['--force', '--deep', '--sign', '-', appPath])
run('codesign', ['--verify', '--deep', '--strict', appPath])
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

console.log(`Built ${appPath} / 已构建 ${appPath}`)
console.log(`Created ${zipPath} / 已创建 ${zipPath}`)
console.log(`Embedded Node ${nodeSourcePath} / 已内置 Node ${nodeSourcePath}`)
console.log('Ad-hoc signing only; Developer ID signing and notarization remain deferred. / 当前仅使用 ad-hoc 签名；Developer ID 签名和 notarization 暂缓。')

function copyCliDist(source, destination) {
  const excludedPath = path.join(source, 'runtime', 'g4f-service', '.venv')
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => {
      const resolved = path.resolve(entry)
      return resolved !== excludedPath && !isPathInside(resolved, excludedPath)
    },
  })
}

function copyProductionDependencies(destinationRoot) {
  fs.mkdirSync(destinationRoot, { recursive: true })
  const copied = new Set()
  for (const dependencyName of runtimeDependencySeeds) {
    copyPackage(dependencyName, repositoryRoot)
  }

  function copyPackage(packageName, startDirectory) {
    if (copied.has(packageName)) return
    const sourceDirectory = resolvePackageDirectory(packageName, startDirectory)
    const destinationDirectory = path.join(destinationRoot, ...packageName.split('/'))
    copied.add(packageName)
    fs.cpSync(sourceDirectory, destinationDirectory, {
      recursive: true,
      dereference: true,
    })

    const manifest = readJSON(path.join(sourceDirectory, 'package.json'), `${packageName} package manifest`)
    for (const dependencyName of Object.keys(manifest.dependencies ?? {})) {
      copyPackage(dependencyName, sourceDirectory)
    }
    if (packageName === 'koffi') {
      copyPackage(koffiPlatformPackage, sourceDirectory)
    }
  }
}

function resolvePackageDirectory(packageName, startDirectory) {
  let directory = startDirectory
  while (true) {
    const candidate = path.join(directory, 'node_modules', ...packageName.split('/'))
    try {
      const resolved = fs.realpathSync(candidate)
      if (fs.statSync(resolved).isDirectory()) return resolved
    } catch {
      // Continue walking towards the repository root.
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Required production dependency is missing / 缺少必要的 production dependency：${packageName}`)
}

function resolveNodeExecutable(args) {
  let explicitPath
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--node-path') {
      explicitPath = args[index + 1]
      index += 1
    } else if (argument.startsWith('--node-path=')) {
      explicitPath = argument.slice('--node-path='.length)
    } else {
      throw new Error(`Unknown build option ${argument}. Use --node-path <path>. / 未知构建选项 ${argument}，请使用 --node-path <path>。`)
    }
  }
  const configuredPath = explicitPath || process.env.TOKENLESS_MACOS_NODE_PATH || process.execPath
  const candidatePath = path.resolve(configuredPath)
  const resolvedPath = requireExecutable(candidatePath, 'Node runtime input')
  validateArm64MachO(resolvedPath, 'Node runtime input')
  try {
    const version = execFileSync(resolvedPath, ['--version'], { encoding: 'utf8' }).trim()
    if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error('invalid version output')
  } catch (error) {
    throw new Error(`Node runtime cannot be executed / Node runtime 无法执行：${resolvedPath} (${error.message})`)
  }
  return resolvedPath
}

function requireExecutable(filePath, label) {
  const resolvedPath = resolveRealPath(filePath, label)
  const stat = fs.statSync(resolvedPath)
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file / ${label} 不是普通文件：${filePath}`)
  }
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    throw new Error(`${label} is not readable and executable / ${label} 不可读或不可执行：${filePath}`)
  }
  return resolvedPath
}

function requireFile(filePath, label) {
  const resolvedPath = resolveRealPath(filePath, label)
  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error(`${label} is not a regular file / ${label} 不是普通文件：${filePath}`)
  }
  return resolvedPath
}

function requireDirectory(directoryPath, label) {
  const resolvedPath = resolveRealPath(directoryPath, label)
  if (!fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`${label} is not a directory / ${label} 不是目录：${directoryPath}`)
  }
  return resolvedPath
}

function resolveRealPath(filePath, label) {
  try {
    return fs.realpathSync(filePath)
  } catch {
    throw new Error(`${label} is missing / 缺少 ${label}：${filePath}`)
  }
}

function validateArm64MachO(filePath, label) {
  let description
  try {
    description = execFileSync('/usr/bin/file', [filePath], { encoding: 'utf8' }).trim()
  } catch (error) {
    throw new Error(`Could not inspect ${label} architecture / 无法检查 ${label} 架构：${error.message}`)
  }
  if (!/\barm64\b/.test(description)) {
    throw new Error(`${label} is not arm64 / ${label} 不是 arm64：${description}`)
  }
}

function assertNoSymlinks(rootPath) {
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundle contains an unexpected symlink / bundle 含有不应存在的 symlink：${entryPath}`)
    }
    if (entry.isDirectory()) assertNoSymlinks(entryPath)
  }
}

function assertPathAbsent(pathToCheck) {
  if (fs.existsSync(pathToCheck)) {
    throw new Error(`Forbidden runtime was copied into the app / 禁止的 runtime 被复制进 app：${pathToCheck}`)
  }
}

function isPathInside(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
}

function readJSON(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${label} / 无法读取 ${label}：${filePath} (${error.message})`)
  }
}

function infoPlist(bundleVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Tokenless</string>
	<key>CFBundleExecutable</key>
	<string>${executableName}</string>
	<key>CFBundleIdentifier</key>
	<string>local.tokenless.api.menubar</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Tokenless</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${bundleVersion}</string>
	<key>CFBundleVersion</key>
	<string>${bundleVersion}</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
`
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  })
}
