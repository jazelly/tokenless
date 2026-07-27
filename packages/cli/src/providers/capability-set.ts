import { tokenlessError } from '../playwright/errors.js'
import type { Page } from 'playwright-core'
import type { ProviderCapabilityId } from './provider-identity.js'
import type { VisibleAction, VisibleActionRequest } from './contracts.js'
import type { ProviderExecutionContext } from './execution-context.js'
import type { ProviderCapabilityInspection, VisibleActionResult } from '../playwright/actions.js'

export interface ProviderCapability {
  readonly capability: ProviderCapabilityId
  inspect(page: Page): Promise<ProviderCapabilityInspection>
}

export interface ProviderActionCapability<Action extends VisibleAction = VisibleAction> {
  readonly capability: string
  readonly actions: readonly Action[]
  execute(page: Page, request: Extract<VisibleActionRequest, { action: Action }>, context: ProviderExecutionContext): Promise<VisibleActionResult>
}

export interface InspectableProviderActionCapability<Action extends VisibleAction = VisibleAction>
  extends ProviderCapability, Omit<ProviderActionCapability<Action>, 'capability'> {}

export class ProviderCapabilityFailure extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, options: { retryable: boolean }) {
    super(message)
    this.name = 'ProviderCapabilityFailure'
    this.code = code
    this.retryable = options.retryable
  }
}

export function providerCapabilityFailure(code: string, message: string, options: { retryable: boolean }) {
  return new ProviderCapabilityFailure(code, message, options)
}

export class ProviderCapabilitySet {
  private readonly capabilities: readonly ProviderCapability[]
  private readonly byAction: ReadonlyMap<VisibleAction, InspectableProviderActionCapability>

  constructor(capabilities: readonly ProviderCapability[]) {
    const byAction = new Map<VisibleAction, InspectableProviderActionCapability>()
    const byCapability = new Set<ProviderCapabilityId>()
    for (const capability of capabilities) {
      if (!capability.capability) throw new Error('Provider capability id is required.')
      if (byCapability.has(capability.capability)) {
        throw new Error(`Provider capability is registered more than once: ${capability.capability}`)
      }
      byCapability.add(capability.capability)
      if (!isProviderActionCapability(capability)) continue
      const local = new Set<VisibleAction>()
      for (const action of capability.actions) {
        if (local.has(action)) throw new Error(`Duplicate action in provider capability: ${action}`)
        local.add(action)
        if (byAction.has(action)) throw new Error(`Provider action is registered more than once: ${action}`)
        byAction.set(action, capability)
      }
    }
    this.capabilities = Object.freeze([...capabilities])
    this.byAction = byAction
    Object.freeze(this)
  }

  supports(action: VisibleAction) {
    return this.byAction.has(action)
  }

  async execute(page: Page, request: VisibleActionRequest, context: ProviderExecutionContext): Promise<VisibleActionResult> {
    const capability = this.byAction.get(request.action)
    if (!capability) {
      throw tokenlessError('unknown_visible_action', 'Visible action is not supported.', { retryable: false })
    }
    return await capability.execute(page, request as never, context)
  }

  async inspectAll(page: Page) {
    const entries = await Promise.all(this.capabilities.map(async (capability) => [
      capability.capability,
      await capability.inspect(page),
    ] as const))
    return Object.fromEntries(entries) as Readonly<Record<ProviderCapabilityId, ProviderCapabilityInspection>>
  }
}

function isProviderActionCapability(capability: ProviderCapability): capability is InspectableProviderActionCapability {
  return 'actions' in capability && 'execute' in capability
}
