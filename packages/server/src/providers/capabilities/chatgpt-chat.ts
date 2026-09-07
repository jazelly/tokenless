import { tokenlessError } from '../../browser/errors.js'
import type { Page } from 'playwright-core'

export const CHATGPT_CHAT_TRIGGER = 'button.__composer-pill[aria-haspopup="menu"]:not([class*="WorkTrigger"])'
export const CHATGPT_CHAT_EFFORTS = ['Light', 'Medium', 'High', 'Extra High', 'Pro'] as const
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
