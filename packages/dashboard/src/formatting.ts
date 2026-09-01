import type { Language } from './types.js'

export function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]!)
}

export function formatTime(value: unknown, language: Language) {
  return value
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(String(value)))
    : '—'
}

export function formatNumber(value: number, language: Language) {
  return new Intl.NumberFormat(language).format(value)
}

export function formatAge(value: unknown, language: Language, neverChecked: string, now = Date.now()) {
  if (!value) return neverChecked
  const timestamp = Date.parse(String(value))
  if (!Number.isFinite(timestamp)) return neverChecked
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  const unit: Intl.RelativeTimeFormatUnit = seconds < 3600
    ? 'minute'
    : seconds < 86400
      ? 'hour'
      : 'day'
  const amount = unit === 'minute'
    ? Math.floor(seconds / 60)
    : unit === 'hour'
      ? Math.floor(seconds / 3600)
      : Math.floor(seconds / 86400)
  return new Intl.RelativeTimeFormat(language, { numeric: 'always' }).format(-amount, unit)
}

const chatTitleLimit = 64

export function truncateChatTitle(value: string, limit = chatTitleLimit) {
  const codePoints = Array.from(value)
  if (codePoints.length <= limit) return value
  return `${codePoints.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`
}

export function promptChatTitle(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null
  const userTurns = [...value.matchAll(/\[User\]\s*([\s\S]*?)(?=\n\n\[(?:System|Developer|Assistant|Tool|User)\]|$)/giu)]
  const source = userTurns.at(-1)?.[1] ?? value
  const normalized = source
    .replace(/\[(?:System|Developer|Assistant|Tool|User)\]\s*/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return normalized ? truncateChatTitle(normalized) : null
}

export function formatChatTitle(chatTitle: unknown, titlePrompt: unknown, untitled: string) {
  const explicitTitle = typeof chatTitle === 'string' ? chatTitle.trim() : ''
  return truncateChatTitle(explicitTitle || promptChatTitle(titlePrompt) || untitled)
}

export function isConversationJob(value: { chatTitle?: unknown; titlePrompt?: unknown }) {
  return [value.chatTitle, value.titlePrompt].some((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
}
