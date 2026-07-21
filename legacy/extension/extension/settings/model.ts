type SettingsRecord = Record<string, unknown>

export type HistoryEntry = {
  jobId: string
  taskId: string
  projectName: string
  chatName: string
  provider: string
  action: string
  status: string
  updatedAt: string
}

export function configWritePayload({
  providerOrder,
  browser,
  daemonUrl,
}: {
  providerOrder: readonly string[]
  browser: string
  daemonUrl: string
}) {
  return {
    preferredProviders: [...providerOrder],
    browser: stringValue(browser) || null,
    daemonUrl: stringValue(daemonUrl) || null,
  }
}

export function normalizeProviderOrder(value: unknown, supportedProviderIds: readonly string[]) {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const providerId of value) {
    if (typeof providerId !== 'string' || !supportedProviderIds.includes(providerId) || seen.has(providerId)) continue
    seen.add(providerId)
    normalized.push(providerId)
  }
  return normalized
}

export function normalizeHistoryEntries(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeHistoryEntry)
    .filter((entry): entry is HistoryEntry => entry !== null)
}

function normalizeHistoryEntry(value: unknown): HistoryEntry | null {
  const job = objectRecord(value)
  const jobId = stringValue(job.job_id)
  if (!jobId) return null
  const metadata = objectRecord(job.metadata)
  const request = objectRecord(job.request_json)
  const requestMetadata = objectRecord(request.metadata)
  return {
    jobId,
    taskId: firstString(
      metadata.taskId,
      metadata.idempotencyKey,
      requestMetadata.taskId,
      request.taskId,
      requestMetadata.idempotencyKey,
      request.idempotencyKey,
      jobId
    ),
    projectName: firstString(
      metadata.projectName,
      requestMetadata.projectName,
      request.projectName,
      'Unspecified project'
    ),
    chatName: firstString(
      metadata.chatName,
      requestMetadata.chatName,
      request.chatName,
      'Unspecified chat'
    ),
    provider: firstString(job.provider, 'unknown'),
    action: firstString(job.action, 'unknown'),
    status: firstString(job.status, 'unknown'),
    updatedAt: firstString(job.updated_at, job.created_at, ''),
  }
}

function objectRecord(value: unknown): SettingsRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SettingsRecord
    : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const normalized = stringValue(value)
    if (normalized) return normalized
  }
  return ''
}
