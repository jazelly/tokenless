import type { Page } from 'playwright-core'
import type { ProviderDomDefinition } from './provider-definition.js'
import type { ProviderActionPreparation, VisibleActionRequest } from './contracts.js'
import type { CaptureVisibleOutput } from '../output-savings/index.js'
import type { TaskCapabilityId } from './task-capabilities.js'

export type ProviderExecutionContext = {
  profileId: string
  operationId: string
  jobId?: string
  taskId?: string | null
  attachmentRoot?: string
  assetRoot?: string
  requirements?: readonly TaskCapabilityId[]
  responsePreparation?: ProviderActionPreparation
  resetPromptDraft?: boolean
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
  return request.provider === provider.descriptor.id
}
