import { providerCapabilityFailure } from '../capability-set.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import type { Page } from 'playwright-core'
import type { ProviderCapability } from '../capability-set.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderDomDefinition } from '../provider-definition.js'
import type { ProviderCapabilityInspection } from '../../playwright/actions.js'

export type ImageGenerationCursor = {
  readonly schema: 'tokenless.provider.image-generation-cursor.v1'
  readonly value: {
    readonly operationId: string
    readonly startedAt: string
  }
}

export type ImageGenerationInspection = {
  readonly availability: 'available' | 'unavailable' | 'unknown'
  readonly visibleProof: string | null
  readonly reason: string | null
}

export type ImageGenerationStart = {
  readonly operationId: string
  readonly cursor: ImageGenerationCursor
  readonly visibleProof: string
}

export type ImageGenerationObservation = {
  readonly state: 'running' | 'completed' | 'failed' | 'unknown'
  readonly visibleProof: string | null
  readonly reason: string | null
}

export type ImageGenerationRead = {
  readonly images: readonly {
    readonly url: string | null
    readonly alt: string | null
    readonly visibleProof: string
  }[]
  readonly visibleProof: string | null
}

export interface ImageGenerationCapability extends ProviderCapability {
  inspect(page: Page, context?: ProviderExecutionContext): Promise<ProviderCapabilityInspection & ImageGenerationInspection>
  cursor(page: Page, context: ProviderExecutionContext): Promise<ImageGenerationCursor>
  start(page: Page, prompt: string, context: ProviderExecutionContext): Promise<ImageGenerationStart>
  observe(page: Page, operationId: string, context: ProviderExecutionContext): Promise<ImageGenerationObservation>
  read(page: Page, operationId: string, context: ProviderExecutionContext): Promise<ImageGenerationRead>
}

export class UnsupportedImageGenerationCapability implements ImageGenerationCapability {
  readonly capability = PROVIDER_CAPABILITIES.IMAGE_GENERATION
  private readonly provider: ProviderDomDefinition

  constructor(provider: ProviderDomDefinition) {
    this.provider = provider
  }

  async inspect(_page: Page, _context?: ProviderExecutionContext): Promise<ProviderCapabilityInspection & ImageGenerationInspection> {
    const strategy = this.provider.capabilities[PROVIDER_CAPABILITIES.IMAGE_GENERATION]
    return {
      ...strategy,
      actions: [],
    }
  }

  async cursor(_page: Page, _context: ProviderExecutionContext): Promise<ImageGenerationCursor> {
    throw unsupportedImageGeneration()
  }

  async start(_page: Page, _prompt: string, _context: ProviderExecutionContext): Promise<ImageGenerationStart> {
    throw unsupportedImageGeneration()
  }

  async observe(_page: Page, _operationId: string, _context: ProviderExecutionContext): Promise<ImageGenerationObservation> {
    throw unsupportedImageGeneration()
  }

  async read(_page: Page, _operationId: string, _context: ProviderExecutionContext): Promise<ImageGenerationRead> {
    throw unsupportedImageGeneration()
  }
}

function unsupportedImageGeneration() {
  return providerCapabilityFailure(
    'image_generation_unavailable',
    'Visible image generation is not available without real-provider acceptance evidence.',
    { retryable: false },
  )
}
