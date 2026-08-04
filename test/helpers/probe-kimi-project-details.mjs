import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: {
  id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak',
} })
const url = process.argv[2]
if (!url) throw new Error('url required')

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-project-details', policy: 'preserve' })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })
  const evidence = { initial: await snapshot(page) }
  evidence.knowledge = await page.locator('.project-knowledge').evaluate((root) => [...root.querySelectorAll('*')].map((element) => ({
    tag: element.tagName.toLowerCase(),
    class: element.getAttribute('class'),
    text: element.children.length <= 2 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim() : '',
    aria: element.getAttribute('aria-label'),
  })).filter((entry) => entry.text || entry.aria))
  const addPrompt = page.locator('.project-knowledge .knowledge-action').first()
  if (await addPrompt.isVisible().catch(() => false)) {
    await addPrompt.evaluate((element) => element.click())
    await page.waitForTimeout(300)
    evidence.instructions = await snapshot(page)
    evidence.instructionControls = await page.locator('.project-prompt-edit-modal').evaluate((root) => [...root.querySelectorAll('*')].map((element) => ({
      tag: element.tagName.toLowerCase(),
      class: element.getAttribute('class'),
      text: element.children.length <= 2 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim() : '',
      placeholder: element.getAttribute('placeholder'),
      aria: element.getAttribute('aria-label'),
    })).filter((entry) => entry.text || entry.placeholder || entry.aria))
    console.log(JSON.stringify(evidence, null, 2))
    return
  }
  const more = page.locator('button.project-more-button').first()
  if (await more.isVisible().catch(() => false)) {
    await more.click()
    await page.waitForTimeout(300)
    evidence.more = await snapshot(page)
    await page.keyboard.press('Escape')
  }
  const folder = page.locator('button.project-cover-folder').first()
  if (await folder.isVisible().catch(() => false)) {
    await folder.click()
    await page.waitForTimeout(300)
    evidence.folder = await snapshot(page)
  }
  console.log(JSON.stringify(evidence, null, 2))
})
await manager.shutdown()

async function snapshot(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
    }
    const selectors = 'button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="menuitem"], [role="dialog"], label, a[href], [class*="project"]'
    const controls = [...document.querySelectorAll(selectors)]
      .filter(visible)
      .filter((element) => !element.closest('.next-sidebar-history'))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        class: (element.getAttribute('class') ?? '').slice(0, 180),
        role: element.getAttribute('role'),
        text: element.children.length <= 4 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 220) : '',
        aria: element.getAttribute('aria-label'),
        placeholder: element.getAttribute('placeholder'),
        href: element instanceof HTMLAnchorElement ? element.pathname : '',
      }))
      .filter((entry) => entry.text || entry.aria || entry.placeholder || entry.href)
    return { url: location.href, controls: controls.slice(0, 160) }
  })
}
