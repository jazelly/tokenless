import { tokenlessError } from '../../browser/errors.js'
import type { Page } from 'playwright-core'

export const CHATGPT_CHAT_TRIGGER = 'button.__composer-pill[aria-haspopup="menu"]:not([class*="WorkTrigger"])'
export const CHATGPT_MODEL_CHOICES = '[data-testid="composer-model-picker-slider-advanced-view"][data-active="true"] [role="menuitemradio"]'
export const CHATGPT_POWER_SLIDER = '[data-testid="composer-model-picker-slider-simple-view"][data-active="true"] [role="slider"]'

export async function readChatGptEffort(page: Page) {
  const slider = page.locator(CHATGPT_POWER_SLIDER)
  await slider.waitFor({ state: 'visible', timeout: 5000 })
  const value = await slider.evaluate((element) => {
    const power = element.closest('[role="menuitem"]')
    const description = (power?.getAttribute('aria-describedby') ?? '').split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    return {
      index: Number(element.getAttribute('aria-valuenow')),
      minimum: Number(element.getAttribute('aria-valuemin')),
      maximum: Number(element.getAttribute('aria-valuemax')),
      label: description.split(',')[0]?.trim(),
    }
  })
  if (!Number.isInteger(value.index) || !Number.isInteger(value.minimum) || !Number.isInteger(value.maximum)
    || value.minimum < 0 || value.maximum > 10 || value.index < value.minimum || value.index > value.maximum
    || !value.label) {
    throw tokenlessError('chatgpt_effort_controls_changed', 'ChatGPT power labels do not match the observed slider state.', { retryable: false })
  }
  return { ...value, label: value.label }
}

export async function inspectChatGptEfforts(page: Page) {
  const original = await readChatGptEffort(page)
  const slider = page.locator(CHATGPT_POWER_SLIDER)
  const choices = []
  await slider.focus()
  try {
    for (let index = original.minimum; index <= original.maximum; index += 1) {
      const current = await readChatGptEffort(page)
      for (let step = 0; step < Math.abs(index - current.index); step += 1) {
        await slider.press(index > current.index ? 'ArrowRight' : 'ArrowLeft')
      }
      const selected = await readChatGptEffort(page)
      if (selected.index !== index) {
        throw tokenlessError('chatgpt_effort_not_selected', 'ChatGPT did not select the requested power position.', { retryable: false })
      }
      choices.push({ label: selected.label, selected: index === original.index, enabled: true })
    }
  } finally {
    const current = await readChatGptEffort(page)
    for (let step = 0; step < Math.abs(original.index - current.index); step += 1) {
      await slider.press(original.index > current.index ? 'ArrowRight' : 'ArrowLeft')
    }
    if ((await readChatGptEffort(page)).index !== original.index) {
      throw tokenlessError('chatgpt_effort_not_restored', 'ChatGPT did not restore the original power position after inspection.', { retryable: false })
    }
  }
  return choices
}

const historyWarningPages = new WeakSet<Page>()

export async function dismissChatGptHistoryWarning(page: Page) {
  if (!historyWarningPages.has(page)) {
    await page.addLocatorHandler(
      page.locator('[data-testid="modal-conversation-history-rate-limit"] [role="dialog"]'),
      async (dialog) => { await dialog.getByRole('button', { name: 'Got it', exact: true }).click({ timeout: 5000 }) },
    )
    historyWarningPages.add(page)
  }
}

export async function ensureChatGptChat(page: Page) {
  await dismissChatGptHistoryWarning(page)
  const chat = page.getByRole('radio', { name: 'Chat', exact: true })
  if (await chat.isVisible().catch(() => false)) {
    if (await chat.getAttribute('aria-checked') !== 'true') await chat.click({ timeout: 5000 })
    if (await chat.getAttribute('aria-checked') !== 'true') {
      throw tokenlessError('chatgpt_chat_surface_not_selected', 'ChatGPT Chat mode could not be selected.', { retryable: false })
    }
  }
  if (await page.locator('button.__composer-pill[class*="WorkTrigger"]').isVisible().catch(() => false)) {
    throw tokenlessError('chatgpt_work_surface_unsupported', 'This conversation uses ChatGPT Work. Open a new Chat conversation.', { retryable: false })
  }
  if (!await page.locator(CHATGPT_CHAT_TRIGGER).waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
    throw tokenlessError('chatgpt_chat_surface_not_visible', 'The ChatGPT Chat composer control is not visible.', { retryable: false })
  }
}
