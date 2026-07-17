import { PROVIDER_IDS, getProviderById } from './provider-config.js'
import {
  VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
  VISIBLE_PROVIDER_ACTIONS,
  createVisibleProviderCapabilityManifest,
  listVisibleProviderActions,
} from './visible-provider-actions.js'
import type { ProviderId } from './provider-config.js'
import type {
  VisibleProviderAction,
  VisibleProviderCapabilityDeclaration,
  VisibleProviderCapabilityManifest,
} from './visible-provider-actions.js'

const verified = (
  evidence: string,
  options: Omit<VisibleProviderCapabilityDeclaration, 'state' | 'evidence'> = {}
): VisibleProviderCapabilityDeclaration => ({
  state: 'verified',
  evidence: [evidence],
  ...options,
})

const CHATGPT_CAPABILITIES = createVisibleProviderCapabilityManifest(PROVIDER_IDS.CHATGPT, {
  [VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS]: verified('chatgpt:signed-in-paid:session-status:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT]: verified('chatgpt:signed-in-paid:model-menu-open:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: verified('chatgpt:model-selection:authenticated-browser-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT]: verified('chatgpt:signed-in-paid:thinking-effort-menu-open:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT]: verified('chatgpt:effort-selection:authenticated-dom-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: verified(
    'chatgpt:signed-in-paid:file-input-ready-and-native-local-e2e:2026-07-17',
    { requiresAuthentication: true }
  ),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT]: verified('chatgpt:signed-in-paid:composer-input:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT]: verified('chatgpt:visible-submit:accepted-browser-e2e'),
})

const GEMINI_CAPABILITIES = createVisibleProviderCapabilityManifest(PROVIDER_IDS.GEMINI, {
  [VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS]: verified('gemini:signed-in-unknown:session-status:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT]: verified('gemini:signed-in-unknown:model-menu-open:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: verified('gemini:model-selection:authenticated-browser-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT]: verified('gemini:signed-in-unknown:thinking-effort-menu-open:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT]: verified('gemini:effort-selection:authenticated-browser-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT]: verified('gemini:signed-in-unknown:composer-input:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT]: verified('gemini:visible-submit:accepted-local-adapter-e2e'),
  [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: verified(
    'gemini:signed-in-unknown:file-input-ready-and-native-local-e2e:2026-07-17',
    { requiresAuthentication: true }
  ),
})

const CLAUDE_CAPABILITIES = createVisibleProviderCapabilityManifest(PROVIDER_IDS.CLAUDE, {
  [VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS]: verified('claude:signed-in-free:session-status:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: verified(
    'claude:signed-in-free:file-input-ready-and-native-local-e2e:2026-07-17',
    { requiresAuthentication: true }
  ),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT]: verified('claude:signed-in-free:composer-input:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT]: verified('claude:visible-submit:accepted-local-adapter-e2e', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT]: verified('claude:signed-in-free:model-menu-open:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: verified('claude:model-selection:authenticated-browser-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT]: verified('claude:signed-in-free:thinking-effort-menu-open:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT]: verified('claude:effort-selection:authenticated-browser-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
})

const GROK_CAPABILITIES = createVisibleProviderCapabilityManifest(PROVIDER_IDS.GROK, {
  [VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS]: verified('grok:signed-in-unknown:session-status:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT]: verified('grok:signed-in-unknown:model-menu-open:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT]: verified('grok:model-selection:authenticated-entitlement-fail-closed-and-local-e2e:2026-07-17', { requiresAuthentication: true }),
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_INSPECT]: {
    state: 'unsupported',
    requiresAuthentication: true,
    evidence: ['grok:signed-in-unknown:thinking-effort-menu-open:2026-07-17'],
    reason: 'Grok couples thinking effort to visible model profiles and exposes no independent effort control.',
  },
  [VISIBLE_PROVIDER_ACTIONS.EFFORT_SELECT]: {
    state: 'unsupported',
    requiresAuthentication: true,
    evidence: ['grok:signed-in-unknown:thinking-effort-menu-open:2026-07-17'],
    reason: 'Grok couples thinking effort to visible model profiles and exposes no independent effort control.',
  },
  [VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD]: verified(
    'grok:signed-in-unknown:file-input-ready-and-native-local-e2e:2026-07-17',
    { requiresAuthentication: true }
  ),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_INPUT]: verified('grok:signed-in-unknown:composer-input:2026-07-17'),
  [VISIBLE_PROVIDER_ACTIONS.PROMPT_SUBMIT]: verified('grok:visible-submit:accepted-local-adapter-e2e', { requiresAuthentication: true }),
})

const CAPABILITIES: Readonly<Record<ProviderId, VisibleProviderCapabilityManifest>> = Object.freeze({
  [PROVIDER_IDS.CHATGPT]: CHATGPT_CAPABILITIES,
  [PROVIDER_IDS.GEMINI]: GEMINI_CAPABILITIES,
  [PROVIDER_IDS.CLAUDE]: CLAUDE_CAPABILITIES,
  [PROVIDER_IDS.GROK]: GROK_CAPABILITIES,
})

export function getVisibleProviderActionCapabilities(providerId: unknown): VisibleProviderCapabilityManifest | null {
  const provider = getProviderById(providerId)
  return provider ? CAPABILITIES[provider.id] : null
}

export function listVisibleProviderActionCapabilities(): VisibleProviderCapabilityManifest[] {
  return Object.values(CAPABILITIES)
}

export function visibleProviderActionCapabilitiesPayload() {
  return {
    protocol: VISIBLE_PROVIDER_ACTION_PROTOCOL_VERSION,
    actions: listVisibleProviderActions(),
    providers: listVisibleProviderActionCapabilities(),
  }
}

export function isVisibleProviderActionVerified(providerId: unknown, action: VisibleProviderAction) {
  return getVisibleProviderActionCapabilities(providerId)?.actions[action]?.state === 'verified'
}
