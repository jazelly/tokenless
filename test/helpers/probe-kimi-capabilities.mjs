import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import {
  ManagedProfileRegistry,
  PersistentContextManager,
} from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({
  browser: {
    id: 'cloak',
    executablePath: runtime.executablePath,
    runtimeId: runtime.runtimeId,
    launchPolicy: 'cloak',
  },
})

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-capabilities', policy: 'preserve' })
  await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })

  const evidence = { surface: await visibleCapabilityControls(page), menus: {} }
  try {
  await page.locator('.toolkit-trigger-btn').click()
  await page.waitForTimeout(300)
  evidence.menus.toolkit = await visibleCapabilityControls(page)

  for (const label of ['Plugins', 'Skills']) {
    const item = page.locator('.toolkit-item').filter({ hasText: label }).first()
    if (!await item.isVisible().catch(() => false)) continue
    await item.click()
    await page.waitForTimeout(400)
    evidence.menus[label.toLowerCase()] = await visibleCapabilityControls(page)
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.keyboard.press('Escape').catch(() => undefined)
    await page.locator('.toolkit-trigger-btn').click()
    await page.waitForTimeout(300)
  }
  await page.keyboard.press('Escape').catch(() => undefined)

  const search = page.locator('.toolkit-item').filter({ hasText: 'Web search' }).first()
  await page.locator('.toolkit-trigger-btn').click()
  await page.waitForTimeout(300)
  if (await search.isVisible().catch(() => false)) {
    evidence.menus.webSearchBefore = await elementEvidence(search)
    await search.click()
    await page.waitForTimeout(400)
    evidence.menus.webSearchAfter = await visibleCapabilityControls(page)
    await page.locator('.toolkit-trigger-btn').click().catch(() => undefined)
    await page.waitForTimeout(200)
    const selectedSearch = page.locator('.toolkit-item').filter({ hasText: 'Web search' }).first()
    if (await selectedSearch.isVisible().catch(() => false)) await selectedSearch.click()
    await page.keyboard.press('Escape').catch(() => undefined)
  }

  const project = page.locator('.next-sidebar-project-list__create').first()
  if (await project.isVisible().catch(() => false)) {
    await project.evaluate((element) => element.click())
    await page.waitForTimeout(400)
    evidence.menus.newProject = await visibleCapabilityControls(page)
    await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })
  }

  const claw = page.locator('.next-sidebar-claw__trigger').first()
  if (await claw.isVisible().catch(() => false)) {
    evidence.menus.clawBefore = await elementEvidence(claw)
    await claw.evaluate((element) => element.click())
    await page.waitForTimeout(500)
    evidence.menus.clawAfter = await visibleCapabilityControls(page)
    await page.keyboard.press('Escape').catch(() => undefined)
  }

  } finally {
    console.log(JSON.stringify(evidence, null, 2))
  }
})
await manager.shutdown()

async function visibleCapabilityControls(page) {
  return await page.evaluate(() => {
    const vocabulary = /project|plugin|skill|search|research|agent|claw|document|docs|sheet|slide|website|image|code|file|upload|model|thinking|effort|create|new|instruction|knowledge/i
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rectangle = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rectangle.width > 0 && rectangle.height > 0
    }
    const entries = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], label, input, textarea, [contenteditable="true"], [class*="item"], [class*="option"], [class*="modal"], [class*="popover"]')]
      .filter(visible)
      .filter((element) => !['svg', 'style'].includes(element.tagName.toLowerCase()))
      .map((element) => {
        const text = element.childElementCount <= 2
          ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 220)
          : ''
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role'),
          class: (element.getAttribute('class') ?? '').slice(0, 180),
          aria: (element.getAttribute('aria-label') ?? '').slice(0, 120),
          placeholder: (element.getAttribute('placeholder') ?? '').slice(0, 120),
          href: element instanceof HTMLAnchorElement ? element.href : '',
          selected: element.getAttribute('aria-selected') ?? element.getAttribute('data-state'),
          disabled: element.getAttribute('aria-disabled') ?? (element.hasAttribute('disabled') ? 'true' : null),
          text: vocabulary.test(text) ? text : '',
        }
      })
      .filter((entry) => entry.text || vocabulary.test(`${entry.class} ${entry.aria} ${entry.placeholder}`))
    const unique = new Map(entries.map((entry) => [JSON.stringify(entry), entry]))
    return { url: location.href, entries: [...unique.values()].slice(0, 120) }
  })
}

async function elementEvidence(locator) {
  return await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    class: element.getAttribute('class'),
    aria: element.getAttribute('aria-label'),
    selected: element.getAttribute('aria-selected') ?? element.getAttribute('data-state'),
    text: (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 220),
  }))
}
