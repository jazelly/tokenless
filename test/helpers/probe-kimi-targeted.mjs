import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: {
  id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak',
} })

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-targeted', policy: 'preserve' })
  await home(page)
  const result = {
    sidebar: await page.locator('a.next-sidebar-nav-item').evaluateAll((links) => links.map((link) => ({
      label: (link.querySelector('.next-sidebar-nav-item__label')?.textContent ?? '').trim(),
      href: link instanceof HTMLAnchorElement ? link.href : '',
    })).filter((entry) => entry.label)),
  }
  try {

  await page.locator('.toolkit-trigger-btn').click()
  await page.waitForTimeout(300)
  result.toolkit = await compactPopover(page)
  await page.locator('.toolkit-item').filter({ hasText: 'Plugins' }).click()
  await page.waitForTimeout(300)
  result.plugins = await compactPopover(page)
  await home(page)

  await page.locator('.toolkit-trigger-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.toolkit-item').filter({ hasText: 'Skills' }).click()
  await page.waitForTimeout(300)
  result.skills = await compactPopover(page)
  await home(page)

  await page.locator('.toolkit-trigger-btn').click()
  await page.waitForTimeout(300)
  await page.locator('.toolkit-item').filter({ hasText: 'Web search' }).click()
  await page.waitForTimeout(300)
  result.webSearch = await compactPopover(page)
  await home(page)

  const project = page.locator('.next-sidebar-project-list__create').first()
  await project.evaluate((element) => element.click())
  await page.waitForTimeout(300)
  result.projectCreate = {
    url: page.url(),
    controls: await compactControls(page),
  }
  await home(page)

  const claw = page.locator('.next-sidebar-claw__trigger').first()
  await claw.evaluate((element) => element.click())
  await page.waitForTimeout(300)
  result.claw = {
    url: page.url(),
    controls: await compactControls(page),
  }
  } finally {
    console.log(JSON.stringify(result, null, 2))
  }
})
await manager.shutdown()

async function home(page) {
  await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })
}

async function compactPopover(page) {
  return await page.locator('.n-popover:visible').evaluateAll((roots) => roots.map((root) => ({
    class: root.getAttribute('class'),
    entries: [...root.querySelectorAll('[class*="item"], [class*="option"], button, label')]
      .filter((element) => element.children.length <= 2)
      .map((element) => ({
        class: element.getAttribute('class'),
        text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim(),
        selected: element.getAttribute('aria-selected') ?? element.getAttribute('data-state'),
        disabled: element.getAttribute('aria-disabled') ?? (element.hasAttribute('disabled') ? 'true' : null),
      }))
      .filter((entry) => entry.text)
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.class === entry.class && candidate.text === entry.text) === index)
      .slice(0, 80),
  })))
}

async function compactControls(page) {
  return await page.locator('button:visible, input:visible, textarea:visible, [contenteditable="true"]:visible, a:visible').evaluateAll((elements) => elements.map((element) => ({
    tag: element.tagName.toLowerCase(),
    class: element.getAttribute('class'),
    text: element.children.length <= 2 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160) : '',
    aria: element.getAttribute('aria-label'),
    placeholder: element.getAttribute('placeholder'),
    href: element instanceof HTMLAnchorElement ? element.href : '',
  })).filter((entry) => entry.text || entry.aria || entry.placeholder || entry.href).slice(0, 100))
}
