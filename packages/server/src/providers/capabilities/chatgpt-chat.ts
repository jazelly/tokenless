import { tokenlessError } from '../../browser/errors.js'
import type { Page } from 'playwright-core'

export const CHATGPT_CHAT_TRIGGER = 'button.__composer-pill[aria-haspopup="menu"]:not([class*="WorkTrigger"])'
export const CHATGPT_CHAT_EFFORTS = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'] as const
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
  if (value.minimum !== 0 || value.maximum !== CHATGPT_CHAT_EFFORTS.length - 1
    || value.label !== CHATGPT_CHAT_EFFORTS[value.index]) {
    throw tokenlessError('chatgpt_effort_controls_changed', 'ChatGPT power labels do not match the observed slider state.', { retryable: false })
  }
  return { index: value.index, label: value.label }
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
