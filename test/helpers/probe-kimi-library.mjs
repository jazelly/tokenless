import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: {
  id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak',
} })

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-library', policy: 'preserve' })
  await page.goto('https://www.kimi.com/plugins', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.top-tab').first().waitFor({ state: 'visible', timeout: 30_000 })
  const evidence = {}
  for (const tab of ['Plugins', 'Skills']) {
    const trigger = page.locator('.top-tab').filter({ hasText: tab }).first()
    await trigger.click()
    await page.waitForTimeout(800)
    evidence[tab.toLowerCase()] = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      return [...document.querySelectorAll('button, input, [role="button"], [role="tab"], [class*="plugin"], [class*="skill"], [class*="card"], [class*="item"]')]
        .filter(visible)
        .filter((element) => !element.closest('.next-sidebar'))
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          class: (element.getAttribute('class') ?? '').slice(0, 180),
          text: element.children.length <= 4 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 240) : '',
          aria: element.getAttribute('aria-label'),
          placeholder: element.getAttribute('placeholder'),
          disabled: element.getAttribute('aria-disabled') ?? (element.hasAttribute('disabled') ? 'true' : null),
        }))
        .filter((entry) => entry.text || entry.aria || entry.placeholder)
        .filter((entry, index, entries) => entries.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(entry)) === index)
        .slice(0, 160)
    })
  }
  console.log(JSON.stringify(evidence, null, 2))
})
await manager.shutdown()
