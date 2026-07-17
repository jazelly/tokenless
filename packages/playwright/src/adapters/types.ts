import type { Page } from 'playwright-core'
import type { VisibleActionRequest, VisibleActionResponse } from '../actions.js'
import type { ProviderConfig, ProviderId } from '../providers.js'

export type VisibleAdapterContext = {
  profileId: string
  operationId: string
  attachmentRoot?: string
  signal?: AbortSignal
  now?: () => Date
}

export type ProviderAdapter = {
  readonly provider: ProviderConfig
  execute(page: Page, request: VisibleActionRequest, context: VisibleAdapterContext): Promise<VisibleActionResponse>
}

export type ProviderAdapterRegistry = {
  list(): ProviderAdapter[]
  get(providerId: ProviderId): ProviderAdapter | null
  execute(page: Page, request: VisibleActionRequest, context: VisibleAdapterContext): Promise<VisibleActionResponse>
}
