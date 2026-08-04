import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: { id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak' } })

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-toolkit', policy: 'preserve' })
  await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })
  const editor = page.locator('.chat-input-editor[contenteditable="true"]:visible').first()
  await editor.click()
  await page.keyboard.type('/')
  await page.waitForTimeout(500)
  const evidence = {
    open: await snapshot(page),
    named: await page.evaluate(() => ['Web search', 'Plugins', 'Skills'].map((label) => ({
      label,
      matches: [...document.querySelectorAll('body *')].filter((element) => element.children.length === 0 && element.textContent?.trim() === label).map((element) => ({
        class: element.getAttribute('class'),
        parentClass: element.parentElement?.getAttribute('class'),
        visible: (() => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' })(),
      })),
    })),
  }
  for (const label of ['Plugins', 'Skills', 'Web search']) {
    const item = page.locator('[class*="item"]:visible').filter({ hasText: label }).first()
    if (!await item.isVisible().catch(() => false)) continue
    await item.hover().catch(() => undefined)
    await page.waitForTimeout(500)
    evidence[label] = await snapshot(page)
  }
  console.log(JSON.stringify(evidence, null, 2))
})
await manager.shutdown()

async function snapshot(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    return [...document.querySelectorAll('.chat-input *, button, [role="button"], [role="menuitem"], [role="option"], [class]')]
      .filter(visible)
      .filter((element) => !element.closest('.next-sidebar'))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        class: (element.getAttribute('class') ?? '').slice(0, 180),
        text: element.children.length <= 3 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240) : '',
        aria: element.getAttribute('aria-label'),
        selected: element.getAttribute('aria-selected') ?? element.getAttribute('data-state'),
      }))
      .filter((entry) => entry.text || entry.aria)
      .filter((entry, index, entries) => entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index)
      .slice(0, 140)
  })
}
