import readline from 'node:readline'
import { BrowserRuntimeManager } from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry, PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const homeDir = '/Users/jazelly/.tokenless/e2e/live-provider'
const profile = await new ManagedProfileRegistry(homeDir).resolveProfile('live-provider-cloak')
const runtime = await new BrowserRuntimeManager({ homeDir }).resolveForProfile(profile)
const manager = new PersistentContextManager({ browser: {
  id: 'cloak', executablePath: runtime.executablePath, runtimeId: runtime.runtimeId, launchPolicy: 'cloak',
} })

await manager.runWithProfile(profile, 'headed', async (managed) => {
  const page = await managed.acquirePage({ key: 'probe:kimi-persistent', policy: 'preserve' })
  await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.locator('.chat-input-editor').waitFor({ state: 'visible', timeout: 30_000 })
  console.log(JSON.stringify({ ready: true, url: page.url() }))

  const input = readline.createInterface({ input: process.stdin, terminal: false })
  for await (const line of input) {
    let command
    try {
      command = JSON.parse(line)
      const result = await execute(page, command)
      console.log(JSON.stringify({ id: command.id ?? null, ok: true, result }))
    } catch (error) {
      console.log(JSON.stringify({ id: command?.id ?? null, ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }
})
await manager.shutdown()

async function execute(page, command) {
  if (command.action === 'goto') {
    await page.goto(new URL(command.path, 'https://www.kimi.com').toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(command.waitMs ?? 800)
    return { url: page.url() }
  }
  if (command.action === 'click') {
    const target = locator(page, command)
    await target.waitFor({ state: 'visible', timeout: 10_000 })
    await target.evaluate((element) => element.click())
    await page.waitForTimeout(command.waitMs ?? 500)
    return { url: page.url() }
  }
  if (command.action === 'fill') {
    await locator(page, command).fill(command.value)
    await page.waitForTimeout(command.waitMs ?? 250)
    return { url: page.url() }
  }
  if (command.action === 'type') {
    const target = locator(page, command)
    await target.click()
    await page.keyboard.type(command.value)
    await page.waitForTimeout(command.waitMs ?? 500)
    return { url: page.url() }
  }
  if (command.action === 'press') {
    await page.keyboard.press(command.value)
    await page.waitForTimeout(command.waitMs ?? 250)
    return { url: page.url() }
  }
  if (command.action === 'snapshot') return await snapshot(page, command.selector)
  throw new Error(`Unsupported action: ${command.action}`)
}

function locator(page, command) {
  const base = page.locator(command.selector)
  const filtered = command.text === undefined ? base : base.filter({ hasText: command.text })
  return filtered.nth(command.index ?? 0)
}

async function snapshot(page, selector = 'button, input, textarea, [contenteditable="true"], [role="button"], [role="menuitem"], [role="option"], a[href], [class*="modal"], [class*="popover"]') {
  return await page.locator(selector).evaluateAll((elements) => {
    const visible = (element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
    }
    return {
      url: location.href,
      entries: elements.filter(visible).filter((element) => !element.closest('.next-sidebar-history')).map((element) => ({
        tag: element.tagName.toLowerCase(),
        class: (element.getAttribute('class') ?? '').slice(0, 180),
        role: element.getAttribute('role'),
        text: element.children.length <= 4 ? (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 220) : '',
        aria: element.getAttribute('aria-label'),
        placeholder: element.getAttribute('placeholder'),
        href: element instanceof HTMLAnchorElement && element.origin === location.origin ? element.pathname : '',
        disabled: element.getAttribute('aria-disabled') ?? (element.hasAttribute('disabled') ? 'true' : null),
      })).filter((entry) => entry.text || entry.aria || entry.placeholder || entry.href).slice(0, 180),
    }
  })
}
