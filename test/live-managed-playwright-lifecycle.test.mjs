import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const liveManagedPlaywrightFiles = [
  'test/live-managed-playwright.e2e.mjs',
  'test/live-managed-playwright-prompt-actions.e2e.mjs',
]

test('managed Playwright live suites reuse existing Tokenless profiles without import or removal', () => {
  for (const relativePath of liveManagedPlaywrightFiles) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert.match(source, /TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME/, `${relativePath} must require an existing Tokenless home`)
    assert.match(source, /TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE/, `${relativePath} must require an existing managed profile slug`)
    assert.match(source, /profiles['"],\s*['"]list/, `${relativePath} must resolve the managed profile before provider actions`)
    assert.doesNotMatch(source, /profiles['"],\s*['"]add/, `${relativePath} must not import or create profiles`)
    assert.doesNotMatch(source, /profiles['"],\s*['"]remove/, `${relativePath} must not remove managed profiles`)
    assert.doesNotMatch(source, /--import-chrome-profile|--consent-local-profile-copy|--chrome-user-data-dir/, `${relativePath} must not copy from Chrome`)
    assert.doesNotMatch(source, /TOKENLESS_LIVE_PROFILE_COPY_CONSENT|TOKENLESS_LIVE_CHROME_PROFILE|TOKENLESS_LIVE_CHROME_USER_DATA_DIR/, `${relativePath} must not depend on Chrome source-profile gates`)
    assert.doesNotMatch(source, /\bimportChromeProfile\b|\bdiscoverChromeProfiles\b|\bcopyFile\b|\bmkdtemp\b/, `${relativePath} must not reach Chrome import or temporary-copy helpers`)
    assert.doesNotMatch(source, /fs\.rm\(.*homeDir|fs\.rmSync\(.*homeDir/, `${relativePath} must not delete the managed home`)
    assert.match(source, /profile\.import\?\.profileDirectoryKey/, `${relativePath} must require a user-imported managed profile`)
    assert.match(source, /promptInputConfirmed|draftInputConfirmed/, `${relativePath} must track confirmed prompt input before cleanup`)
    assert.match(source, /attemptPromptClearCleanup/, `${relativePath} must best-effort clear confirmed prompt drafts on failure`)
  }
})

test('managed Playwright full live suite removes only generated upload marker files', () => {
  const relativePath = 'test/live-managed-playwright.e2e.mjs'
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
  assert.match(source, /finally\s*{\s*const cleanup = await removeGeneratedUploadFile\(upload\)/, `${relativePath} must remove marker uploads in a finally after use`)
  assert.match(source, /await fs\.unlink\(file\)/, `${relativePath} must remove the exact generated marker file`)
  assert.doesNotMatch(source, /fs\.rm\(/, `${relativePath} must not use broad recursive deletion for live cleanup`)
  assert.doesNotMatch(source, /fs\.rmdir|fsSync\.rm|fsSync\.unlink/, `${relativePath} must keep live cleanup scoped to async unlink`)
})
