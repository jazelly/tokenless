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

export function formatAge(value: unknown, language: Language, neverChecked: string) {
  if (!value) return neverChecked
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(String(value))) / 1000))
  const unit: Intl.RelativeTimeFormatUnit = seconds < 60
    ? 'second'
    : seconds < 3600
      ? 'minute'
      : seconds < 86400
        ? 'hour'
        : 'day'
  const amount = unit === 'second'
    ? seconds
    : unit === 'minute'
      ? Math.floor(seconds / 60)
      : unit === 'hour'
        ? Math.floor(seconds / 3600)
        : Math.floor(seconds / 86400)
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-amount, unit)
}
