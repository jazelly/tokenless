import type { Page } from 'playwright-core'
import type { ProviderDomDefinition } from './provider-definition.js'
import type { VisibleActionRequest } from './contracts.js'
import type { CaptureVisibleOutput } from '../output-savings/index.js'

export type ProviderExecutionContext = {
  profileId: string
  operationId: string
  attachmentRoot?: string
  signal?: AbortSignal
  now?: () => Date
  captureVisibleOutput?: CaptureVisibleOutput
}

export type BoundProviderExecutionContext = ProviderExecutionContext & {
  readonly provider: ProviderDomDefinition
  readonly page: Page
}

export function createProviderExecutionContext(
  provider: ProviderDomDefinition,
  page: Page,
  context: ProviderExecutionContext,
): BoundProviderExecutionContext {
  return Object.freeze({
    ...context,
    provider,
    page,
  })
}

export function assertProviderRequest(
  provider: ProviderDomDefinition,
  request: VisibleActionRequest,
) {
  return request.provider === provider.id
}
