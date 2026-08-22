#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = path.join(repositoryRoot, 'apps', 'macos-menu')
const outputRoot = path.join(repositoryRoot, 'dist', 'macos')
const appPath = path.join(outputRoot, 'Tokenless API.app')
const zipPath = path.join(outputRoot, 'Tokenless API.zip')
const scratchPath = path.join(outputRoot, '.swift-build')
const executableName = 'TokenlessMenuBar'

const cliManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'packages', 'cli', 'package.json'), 'utf8'))
const version = typeof cliManifest.version === 'string' ? cliManifest.version : '0.0.0'
const iconSource = path.join(repositoryRoot, 'assets', 'tokenless-mark.png')

fs.mkdirSync(outputRoot, { recursive: true })
fs.rmSync(appPath, { recursive: true, force: true })
fs.rmSync(zipPath, { force: true })

run('swift', [
  'build',
  '--configuration', 'release',
  '--arch', 'arm64',
  '--package-path', packageRoot,
  '--scratch-path', scratchPath,
])

const binPath = execFileSync('swift', [
  'build',
  '--configuration', 'release',
  '--arch', 'arm64',
  '--package-path', packageRoot,
  '--scratch-path', scratchPath,
  '--show-bin-path',
], { encoding: 'utf8' }).trim()
const binaryPath = path.join(binPath, executableName)
if (!fs.existsSync(binaryPath)) {
  throw new Error(`Swift build did not produce the app executable / Swift build 未生成 app executable：${binaryPath}`)
}
if (!fs.existsSync(iconSource)) {
  throw new Error(`Menu bar icon is missing / 菜单栏图标缺失：${iconSource}`)
}

const contentsPath = path.join(appPath, 'Contents')
const macOSPath = path.join(contentsPath, 'MacOS')
const resourcesPath = path.join(contentsPath, 'Resources')
fs.mkdirSync(macOSPath, { recursive: true })
fs.mkdirSync(resourcesPath, { recursive: true })
fs.copyFileSync(binaryPath, path.join(macOSPath, executableName))
fs.chmodSync(path.join(macOSPath, executableName), 0o755)
fs.copyFileSync(iconSource, path.join(resourcesPath, 'tokenless-mark.png'))
fs.writeFileSync(path.join(contentsPath, 'Info.plist'), infoPlist(version), 'utf8')

run('plutil', ['-lint', path.join(contentsPath, 'Info.plist')])
run('codesign', ['--force', '--deep', '--sign', '-', appPath])
run('codesign', ['--verify', '--deep', '--strict', appPath])
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath])

console.log(`Built ${appPath} / 已构建 ${appPath}`)
console.log(`Created ${zipPath} / 已创建 ${zipPath}`)
console.log('Ad-hoc signing only; Developer ID signing and notarization remain deferred. / 当前仅使用 ad-hoc 签名；Developer ID 签名和 notarization 暂缓。')

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
