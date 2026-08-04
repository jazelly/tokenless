import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: {
  id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak',
} })
const routes = [
  '/mykimi', '/plugins', '/tasks', '/agent-swarm', '/slides', '/deep-research', '/websites', '/docs', '/sheets',
]

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-routes', policy: 'preserve' })
  const evidence = []
  for (const route of routes) {
    await page.goto(new URL(route, 'https://www.kimi.com').toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1_500)
    evidence.push(await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
      }
      const controls = [...document.querySelectorAll('button, input, textarea, [contenteditable="true"], [role="button"], [role="option"], [role="tab"], a[href], [class*="input"], [class*="create"], [class*="start"], [class*="prompt"], [class*="publisher"], [class*="hero"]')]
        .filter(visible)
        .filter((element) => !element.closest('.next-sidebar'))
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          class: (element.getAttribute('class') ?? '').slice(0, 140),
          text: element.children.length <= 4 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 180) : '',
          aria: (element.getAttribute('aria-label') ?? '').slice(0, 100),
          placeholder: (element.getAttribute('placeholder') ?? '').slice(0, 140),
          href: element instanceof HTMLAnchorElement && element.origin === location.origin ? element.pathname : '',
          disabled: element.getAttribute('aria-disabled') ?? (element.hasAttribute('disabled') ? 'true' : null),
        }))
        .filter((entry) => entry.text || entry.aria || entry.placeholder || entry.href)
        .filter((entry) => !/user-profile|membership|invite|download-button/i.test(entry.class))
        .slice(0, 120)
      const headings = [...document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="empty"]')]
        .filter(visible)
        .filter((element) => !element.closest('.next-sidebar'))
        .filter((element) => element.children.length <= 2)
        .map((element) => (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 180))
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, 40)
      return { url: location.href, title: document.title, headings, controls }
    }))
  }
  console.log(JSON.stringify(evidence, null, 2))
})
await manager.shutdown()
