import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: {
  id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak',
} })

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-project-create', policy: 'preserve' })
  await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })
  const name = `TOKENLESS_KIMI_PROJECT_${Date.now()}`
  await page.locator('.next-sidebar-project-list__create').first().evaluate((element) => element.click())
  const input = page.locator('.project-create-input').first()
  await input.waitFor({ state: 'visible', timeout: 10_000 })
  await input.fill(name)
  const submit = page.locator('button.project-create-submit[aria-label="Create"]').first()
  await submit.click()
  await page.waitForURL((url) => !url.pathname.startsWith('/project/create'), { timeout: 30_000 })
  await page.waitForTimeout(800)
  const evidence = await page.evaluate((expectedName) => {
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    return {
      nameVisible: [...document.querySelectorAll('body *')].some((element) => visible(element) && element.children.length === 0 && element.textContent?.trim() === expectedName),
      controls: [...document.querySelectorAll('button, input, textarea, [contenteditable="true"], a[href]')]
        .filter(visible)
        .filter((element) => !element.closest('.next-sidebar-history'))
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          class: (element.getAttribute('class') ?? '').slice(0, 140),
          text: element.children.length <= 2 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160) : '',
          aria: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          href: element instanceof HTMLAnchorElement ? element.pathname : '',
        }))
        .filter((entry) => /project|instruction|knowledge|file|upload|chat|setting|edit|new/i.test(`${entry.class} ${entry.text} ${entry.aria} ${entry.placeholder}`))
        .slice(0, 100),
    }
  }, name)
  console.log(JSON.stringify({ name, url: page.url(), evidence }, null, 2))
})
await manager.shutdown()
