import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function extractChangelogSection(changelog, version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('A release version is required.')
  }

  const headings = [...changelog.matchAll(/^##\s+(.+?)\s*$/gm)]
  const matches = headings
    .map((match, index) => ({ match, next: headings[index + 1] }))
    .filter(({ match }) => match[1] === version)

  if (matches.length !== 1) {
    throw new Error(`Could not find exactly one changelog section for version ${version}.`)
  }

  const [{ match, next }] = matches
  const end = next ? next.index : changelog.length
  return `${changelog.slice(match.index, end).trimEnd()}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2]
  const outputPath = process.argv[3]
  if (!version || !outputPath) {
    throw new Error('Usage: node scripts/release/extract-changelog-section.mjs <version> <output-file>')
  }

  const changelogPath = path.join(root, 'packages', 'cli', 'CHANGELOG.md')
  const changelog = fs.readFileSync(changelogPath, 'utf8')
  fs.writeFileSync(outputPath, extractChangelogSection(changelog, version))
}
