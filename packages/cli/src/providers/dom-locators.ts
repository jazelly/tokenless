import type { Locator, Page } from 'playwright-core'

export async function firstVisibleLocator(page: Page, selectors: readonly string[], timeoutMs = 1000): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      if (await locator.isVisible({ timeout: timeoutMs })) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

export async function waitForVisibleLocator(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | null> {
  if (selectors.length === 0) return null
  const deadline = Date.now() + timeoutMs
  do {
    for (const selector of selectors) {
      const locator = page.locator(selector).filter({ visible: true }).first()
      try {
        if (await locator.isVisible({ timeout: 100 })) return locator
      } catch {
        // A provider can replace controls while the page hydrates. Re-observe until the deadline.
      }
    }
    if (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())))
    }
  } while (Date.now() < deadline)
  return null
}

export async function latestLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector)
    try {
      const count = await locator.count()
      if (count > 0) return locator.nth(count - 1)
    } catch {
      // Try the next selector.
    }
  }
  return null
}

export async function countVisibleLocators(page: Page, selectors: readonly string[]) {
  let total = 0
  for (const selector of selectors) {
    const locator = page.locator(selector)
    const count = await locator.count()
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible({ timeout: 50 }).catch(() => false)) total += 1
    }
  }
  return total
}

export async function anyVisibleLocator(page: Page, selectors: readonly string[], timeoutMs = 100) {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible({ timeout: timeoutMs }).catch(() => false)) return true
  }
  return false
}

export async function firstEnabledLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      if (await locator.isVisible({ timeout: 500 }) && !await locatorIsUnavailable(locator)) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

export async function waitForEnabledLocator(page: Page, selectors: readonly string[], timeoutMs: number): Promise<Locator | null> {
  if (selectors.length === 0) return null
  const deadline = Date.now() + timeoutMs
  do {
    const locator = await firstEnabledLocator(page, selectors)
    if (locator) return locator
    if (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())))
    }
  } while (Date.now() < deadline)
  return null
}

export async function firstUnavailableLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).filter({ visible: true }).first()
    try {
      if (await locator.isVisible({ timeout: 500 }) && await locatorIsUnavailable(locator)) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

export async function firstFileInputLocator(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    try {
      const count = typeof (locator as Locator & { count?: unknown }).count === 'function'
        ? await locator.count()
        : (await locator.isVisible({ timeout: 250 }) ? 1 : 0)
      if (count > 0 && await fileInputAcceptsUserFiles(locator)) return locator
    } catch {
      // Try the next selector.
    }
  }
  return null
}

export async function fileInputAcceptsUserFiles(locator: Locator) {
  return await locator.evaluate((element) => (
    element instanceof HTMLInputElement &&
    element.type === 'file' &&
    !element.disabled &&
    element.getAttribute('aria-disabled') !== 'true'
  )).catch(() => true)
}

async function locatorIsUnavailable(locator: Locator) {
  return await locator.evaluate((element) => {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').toLowerCase()
    const aria = (element.getAttribute('aria-label') ?? '').toLowerCase()
    const dataDisabled = element.getAttribute('data-disabled')
    return element.hasAttribute('disabled') ||
      element.getAttribute('aria-disabled') === 'true' ||
      (dataDisabled !== null && dataDisabled !== 'false') ||
      /upgrade|subscribe|requires paid|plan limit/.test(`${text} ${aria}`)
  }).catch(() => false)
}
