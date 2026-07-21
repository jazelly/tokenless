import { createDomProviderAdapter } from './provider-dom-adapter.js'
import type { ProviderAdapter, ProviderAdapterRegistry, VisibleAdapterContext } from './types.js'
import type { Page } from 'playwright-core'
import type { VisibleActionRequest, VisibleActionResponse } from '../actions.js'
import type { ProviderId } from '../providers.js'
import { listProviders } from '../providers.js'
import { errorResponse } from '../errors.js'
import { VISIBLE_ACTION_PROTOCOL_VERSION } from '../actions.js'

export type { ProviderAdapter, ProviderAdapterRegistry, VisibleAdapterContext } from './types.js'

export function createProviderAdapterRegistry(
  adapters: readonly ProviderAdapter[] = listProviders().map((provider) => createDomProviderAdapter(provider))
): ProviderAdapterRegistry {
  const byProvider = new Map<ProviderId, ProviderAdapter>()
  for (const adapter of adapters) byProvider.set(adapter.provider.id, adapter)
  return {
    list() {
      return [...byProvider.values()]
    },
    get(providerId) {
      return byProvider.get(providerId) ?? null
    },
    async execute(page: Page, request: VisibleActionRequest, context: VisibleAdapterContext): Promise<VisibleActionResponse> {
      const adapter = byProvider.get(request.provider)
      if (!adapter) {
        return {
          protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
          requestId: request.requestId,
          provider: request.provider,
          action: request.action,
          ok: false,
          result: null,
          error: {
            code: 'unknown_visible_provider',
            message: 'Visible provider is not registered.',
            retryable: false,
          },
        }
      }
      try {
        return await adapter.execute(page, request, context)
      } catch (error) {
        return {
          protocol: VISIBLE_ACTION_PROTOCOL_VERSION,
          requestId: request.requestId,
          provider: request.provider,
          action: request.action,
          ok: false,
          result: null,
          error: errorResponse(error),
        }
      }
    },
  }
}
