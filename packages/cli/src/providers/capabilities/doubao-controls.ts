import { DomAttachmentCapability } from './dom-attachment.js'
import { PROVIDER_CAPABILITIES } from '../provider-identity.js'
import { VISIBLE_ACTIONS } from '../contracts.js'
import type { Locator, Page } from 'playwright-core'
import type { ProviderActionCapability } from '../capability-set.js'
import type {
  DoubaoMode,
  DoubaoSkill,
  VisibleActionRequest,
} from '../contracts.js'
import type { ProviderExecutionContext } from '../execution-context.js'
import type { ProviderCapabilityStrategy, ProviderDomDefinition } from '../provider-definition.js'
import type {
  DoubaoModeChoice,
  DoubaoModeInspectResult,
  DoubaoModeSelectResult,
  DoubaoSkillChoice,
  DoubaoSkillInspectResult,
  DoubaoSkillSelectResult,
  FileUploadResult,
  ProviderCapabilityInspection,
} from '../../playwright/actions.js'

const CONTROL_TIMEOUT_MS = 5_000
const CONTROL_SETTLE_TIMEOUT_MS = 10_000
const MODE_TRIGGER_SELECTOR = 'button[aria-haspopup="menu"][aria-expanded]:has([data-valid-btn="mode-select-action-btn"])'
const MODE_ITEM_SELECTOR = '[role="menuitem"]'
const DEFAULT_COMPOSER_SELECTOR = 'textarea.semi-input-textarea'
const ACTIVE_SKILL_SELECTOR = 'div[data-input-engine-action-source="actionbar"][data-value]'
const MORE_SKILLS = new Set<DoubaoSkill>([
  'music-generation',
  'problem-solving',
  'spreadsheet-generation',
  'audio-transcription',
])

const MODE_DEFINITIONS: readonly Readonly<{
  mode: DoubaoMode
  nativeLabel: string
  description: string
  canonicalCapabilities: readonly string[]
}>[] = Object.freeze([
  Object.freeze({ mode: 'fast', nativeLabel: '快速', description: '适用于大部分情况', canonicalCapabilities: Object.freeze(['conversation.chat']) }),
  Object.freeze({ mode: 'expert', nativeLabel: '专家', description: '研究级智能模型', canonicalCapabilities: Object.freeze(['reasoning.extended']) }),
  Object.freeze({ mode: 'work-task-turbo', nativeLabel: '工作任务 Turbo', description: '执行 agent 任务 - 2.1 Turbo', canonicalCapabilities: Object.freeze(['task.background', 'task.interactive']) }),
  Object.freeze({ mode: 'work-task-pro', nativeLabel: '工作任务 Pro', description: '执行 agent 任务 - 2.1 Pro', canonicalCapabilities: Object.freeze(['task.background', 'task.interactive']) }),
])

const SKILL_DEFINITIONS: readonly Readonly<{
  skill: DoubaoSkill
  nativeLabel: string
  nativeValue: string | null
  canonicalCapabilities: readonly string[]
  selectable: boolean
}>[] = Object.freeze([
  skill('chat', '普通对话', null, ['conversation.chat']),
  skill('document-writing', '帮我写作', '2', ['document.generation']),
  skill('presentation-generation', 'PPT 生成', '5000', ['presentation.generation']),
  skill('image-generation', '图像生成', '3', ['image.generation']),
  skill('video-generation', '视频生成', '17', ['video.generation']),
  skill('deep-research', '深入研究', '25', ['research.deep']),
  skill('audio-podcast', 'AI 播客', '26', ['audio.generation']),
  skill('music-generation', '音乐生成', '9', ['audio.generation']),
  skill('problem-solving', '解题答疑', '11', ['conversation.chat', 'reasoning.extended']),
  skill('spreadsheet-generation', 'AI 表格', '5003', ['spreadsheet.generation', 'data.analyze']),
  skill('audio-transcription', '录音转写', null, ['audio.transcription'], false),
])

type DoubaoModeAction =
  | typeof VISIBLE_ACTIONS.DOUBAO_MODE_INSPECT
  | typeof VISIBLE_ACTIONS.DOUBAO_MODE_SELECT

type DoubaoSkillAction =
  | typeof VISIBLE_ACTIONS.DOUBAO_SKILL_INSPECT
  | typeof VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT

export class DoubaoAttachmentCapability implements ProviderActionCapability<typeof VISIBLE_ACTIONS.FILE_UPLOAD> {
  readonly capability = PROVIDER_CAPABILITIES.FILE_UPLOAD
  readonly actions = Object.freeze([VISIBLE_ACTIONS.FILE_UPLOAD])
  private readonly delegate: DomAttachmentCapability
  private readonly provider: ProviderDomDefinition<'doubao'>

  constructor(provider: ProviderDomDefinition<'doubao'>) {
    this.provider = provider
    this.delegate = new DomAttachmentCapability(provider)
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const trigger = await waitForVisibleUploadTrigger(page)
    if (!trigger) return capabilityInspection(strategy, this.actions, false, 'no-visible-doubao-upload-trigger', 'visible_upload_control_not_observed')
    await trigger.click({ timeout: CONTROL_TIMEOUT_MS }).catch(() => undefined)
    const input = await waitForFileInput(page)
    await page.keyboard.press('Escape').catch(() => undefined)
    return capabilityInspection(
      strategy,
      this.actions,
      input !== null,
      input ? 'visible-doubao-upload-trigger-and-local-file-input' : 'visible-doubao-upload-trigger-without-local-file-input',
      'visible_doubao_upload_input_not_observed',
    )
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: typeof VISIBLE_ACTIONS.FILE_UPLOAD }>,
    context: ProviderExecutionContext,
  ): Promise<FileUploadResult> {
    return await this.delegate.execute(page, request, context)
  }
}

export class DoubaoModeCapability implements ProviderActionCapability<DoubaoModeAction> {
  readonly capability = PROVIDER_CAPABILITIES.DOUBAO_MODE
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.DOUBAO_MODE_INSPECT,
    VISIBLE_ACTIONS.DOUBAO_MODE_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'doubao'>

  constructor(provider: ProviderDomDefinition<'doubao'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const trigger = await waitForModeTrigger(page)
    return capabilityInspection(
      strategy,
      this.actions,
      trigger !== null,
      trigger ? 'visible-doubao-mode-control' : 'no-visible-doubao-mode-control',
      'visible_doubao_mode_control_not_observed',
    )
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: DoubaoModeAction }>,
    context: ProviderExecutionContext,
  ): Promise<DoubaoModeInspectResult | DoubaoModeSelectResult> {
    if (request.action === VISIBLE_ACTIONS.DOUBAO_MODE_INSPECT) return await inspectModes(page, context.signal)
    return await selectMode(page, request.payload.mode, context.signal)
  }
}

export class DoubaoSkillCapability implements ProviderActionCapability<DoubaoSkillAction> {
  readonly capability = PROVIDER_CAPABILITIES.DOUBAO_SKILL
  readonly actions = Object.freeze([
    VISIBLE_ACTIONS.DOUBAO_SKILL_INSPECT,
    VISIBLE_ACTIONS.DOUBAO_SKILL_SELECT,
  ])
  private readonly provider: ProviderDomDefinition<'doubao'>

  constructor(provider: ProviderDomDefinition<'doubao'>) {
    this.provider = provider
  }

  async inspect(page: Page): Promise<ProviderCapabilityInspection> {
    const strategy = this.provider.capabilities[this.capability]
    const visible = await visibleDefaultComposer(page) !== null || await activeSkill(page) !== null
    return capabilityInspection(
      strategy,
      this.actions,
      visible,
      visible ? 'visible-doubao-skill-control-surface' : 'no-visible-doubao-skill-control-surface',
      'visible_doubao_skill_control_not_observed',
    )
  }

  async execute(
    page: Page,
    request: Extract<VisibleActionRequest, { action: DoubaoSkillAction }>,
    context: ProviderExecutionContext,
  ): Promise<DoubaoSkillInspectResult | DoubaoSkillSelectResult> {
    if (request.action === VISIBLE_ACTIONS.DOUBAO_SKILL_INSPECT) return await inspectSkills(page, context.signal)
    return await selectSkill(page, request.payload.skill, context.signal)
  }
}

async function inspectModes(page: Page, signal: AbortSignal | undefined): Promise<DoubaoModeInspectResult> {
  assertNotAborted(signal)
  const trigger = await waitForModeTrigger(page)
  if (!trigger) return { supported: false, reason: 'selector_not_available' }
  const active = modeFromLabel(normalizeText(await trigger.innerText()))
  if (!active) return { supported: false, reason: 'selector_not_available' }
  await openModeMenu(page, trigger)
  const observed = await collectStableModeItems(page, signal)
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.waitForTimeout(300)
  return {
    supported: true,
    activeMode: active,
    modes: MODE_DEFINITIONS.map((definition): DoubaoModeChoice => {
      const item = observed.get(definition.mode)
      const upgradeRequired = definition.mode === 'work-task-pro' && item?.includes('升级') === true
      return {
        mode: definition.mode,
        nativeLabel: definition.nativeLabel,
        description: definition.description,
        canonicalCapabilities: definition.canonicalCapabilities,
        enabled: item !== undefined && !upgradeRequired,
        selected: definition.mode === active,
        reason: upgradeRequired ? 'upgrade_required' : null,
      }
    }),
  }
}

async function selectMode(
  page: Page,
  mode: DoubaoMode,
  signal: AbortSignal | undefined,
): Promise<DoubaoModeSelectResult> {
  assertNotAborted(signal)
  const definition = MODE_DEFINITIONS.find((candidate) => candidate.mode === mode)
  if (!definition) return { supported: false, reason: 'exact_mode_not_found' }
  const inspected = await inspectModes(page, signal)
  if (!inspected.supported) return inspected
  const choice = inspected.modes.find((candidate) => candidate.mode === mode)
  if (!choice?.enabled) return { supported: false, reason: 'mode_unavailable' }
  if (inspected.activeMode === mode) {
    return { supported: true, selectedMode: mode, nativeLabel: definition.nativeLabel, visibleProof: 'doubao-mode-trigger-visible' }
  }
  const trigger = await waitForModeTrigger(page)
  if (!trigger) return { supported: false, reason: 'selector_not_available' }
  await openModeMenu(page, trigger)
  await page.waitForTimeout(500)
  const item = exactModeItem(page, definition.nativeLabel)
  await item.waitFor({ state: 'visible', timeout: CONTROL_TIMEOUT_MS }).catch(() => undefined)
  if (await item.count() === 0) return { supported: false, reason: 'exact_mode_not_found' }
  await item.click({ timeout: CONTROL_TIMEOUT_MS })
  const selected = await waitForActiveMode(page, mode, signal)
  if (!selected) return { supported: false, reason: 'selector_not_available' }
  return { supported: true, selectedMode: mode, nativeLabel: definition.nativeLabel, visibleProof: 'doubao-mode-trigger-visible' }
}

async function openModeMenu(page: Page, trigger: Locator) {
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await trigger.focus()
    await trigger.press('Enter', { timeout: CONTROL_TIMEOUT_MS })
  }
  await page.locator(MODE_ITEM_SELECTOR).filter({ visible: true }).first().waitFor({
    state: 'visible',
    timeout: CONTROL_TIMEOUT_MS,
  })
}

async function inspectSkills(page: Page, signal: AbortSignal | undefined): Promise<DoubaoSkillInspectResult> {
  assertNotAborted(signal)
  const active = await activeSkill(page) ?? 'chat'
  if (active === 'chat' && await visibleDefaultComposer(page) === null) {
    return { supported: false, reason: 'selector_not_available' }
  }
  const observed = new Set<DoubaoSkill>()
  for (const definition of SKILL_DEFINITIONS.filter((candidate) => !MORE_SKILLS.has(candidate.skill) && candidate.skill !== 'chat')) {
    if (await exactButton(page, definition.nativeLabel).count() > 0) observed.add(definition.skill)
  }
  const more = await waitForExactButton(page, '更多')
  if (more) {
    await more.click({ timeout: CONTROL_TIMEOUT_MS })
    for (const skillId of await collectStableMoreSkills(page, signal)) observed.add(skillId)
    await page.keyboard.press('Escape').catch(() => undefined)
  }
  return {
    supported: true,
    activeSkill: active,
    skills: SKILL_DEFINITIONS.map((definition): DoubaoSkillChoice => ({
      skill: definition.skill,
      nativeLabel: definition.nativeLabel,
      canonicalCapabilities: definition.canonicalCapabilities,
      enabled: definition.skill === 'chat' || (definition.selectable && observed.has(definition.skill)),
      selected: definition.skill === active,
      reason: definition.skill === 'audio-transcription' && observed.has(definition.skill)
        ? 'desktop_app_required'
        : null,
    })),
  }
}

async function selectSkill(
  page: Page,
  requested: DoubaoSkill,
  signal: AbortSignal | undefined,
): Promise<DoubaoSkillSelectResult> {
  assertNotAborted(signal)
  const definition = SKILL_DEFINITIONS.find((candidate) => candidate.skill === requested)
  if (!definition) return { supported: false, reason: 'exact_skill_not_found' }
  if (!definition.selectable) return { supported: false, reason: 'skill_unavailable' }
  const current = await activeSkill(page) ?? 'chat'
  if (current === requested) return selectedSkillResult(definition)
  if (current !== 'chat' && !await exitActiveSkill(page, signal)) {
    return { supported: false, reason: 'selector_not_available' }
  }
  if (requested === 'chat') {
    const composer = await waitForDefaultComposer(page, signal)
    return composer ? selectedSkillResult(definition) : { supported: false, reason: 'selector_not_available' }
  }
  if (!await waitForDefaultComposer(page, signal)) return { supported: false, reason: 'selector_not_available' }
  await page.waitForTimeout(400)
  let trigger = await waitForExactButton(page, definition.nativeLabel, 2_000)
  if (!trigger && MORE_SKILLS.has(requested)) {
    const more = await waitForExactButton(page, '更多')
    if (!more) return { supported: false, reason: 'selector_not_available' }
    await more.click({ timeout: CONTROL_TIMEOUT_MS })
    trigger = await waitForExactButton(page, definition.nativeLabel)
  }
  if (!trigger) return { supported: false, reason: 'exact_skill_not_found' }
  await trigger.click({ timeout: CONTROL_TIMEOUT_MS })
  const selected = await waitForSkill(page, definition, signal)
  return selected ? selectedSkillResult(definition) : { supported: false, reason: 'selector_not_available' }
}

async function exitActiveSkill(page: Page, signal: AbortSignal | undefined) {
  const current = await activeSkillDefinition(page)
  if (!current?.nativeValue) return false
  const token = activeSkillToken(page, current)
  const exit = token.locator('xpath=ancestor-or-self::div[contains(concat(" ", normalize-space(@class), " "), " cursor-pointer ")][1]')
  if (await exit.count() === 0) return false
  await exit.click({ timeout: CONTROL_TIMEOUT_MS })
  return await waitForDefaultComposer(page, signal) !== null
}

async function activeSkill(page: Page): Promise<DoubaoSkill | null> {
  return (await activeSkillDefinition(page))?.skill ?? null
}

async function activeSkillDefinition(page: Page) {
  for (const definition of SKILL_DEFINITIONS) {
    if (!definition.nativeValue) continue
    if (await activeSkillToken(page, definition).count() > 0) return definition
  }
  return null
}

function activeSkillToken(page: Page, definition: (typeof SKILL_DEFINITIONS)[number]) {
  return page.locator(`${ACTIVE_SKILL_SELECTOR}[data-value="${definition.nativeValue}"]`)
    .filter({ visible: true })
    .filter({ hasText: new RegExp(`^${escapeRegExp(definition.nativeLabel)}$`) })
    .last()
}

async function waitForSkill(
  page: Page,
  definition: (typeof SKILL_DEFINITIONS)[number],
  signal: AbortSignal | undefined,
) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    assertNotAborted(signal)
    if (await activeSkillToken(page, definition).count() > 0) return true
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return false
}

async function waitForActiveMode(page: Page, mode: DoubaoMode, signal: AbortSignal | undefined) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    assertNotAborted(signal)
    const trigger = await visibleModeTrigger(page)
    if (trigger && modeFromLabel(normalizeText(await trigger.innerText())) === mode) return trigger
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return null
}

async function collectModeItems(page: Page) {
  const entries = await page.locator(MODE_ITEM_SELECTOR).filter({ visible: true }).allTextContents()
  const result = new Map<DoubaoMode, string>()
  for (const entry of entries) {
    const text = normalizeText(entry)
    const mode = modeFromLabel(text)
    if (mode) result.set(mode, text)
  }
  return result
}

async function collectStableModeItems(page: Page, signal: AbortSignal | undefined) {
  const deadline = Date.now() + CONTROL_TIMEOUT_MS
  let observed = new Map<DoubaoMode, string>()
  do {
    assertNotAborted(signal)
    observed = await collectModeItems(page)
    if (observed.size === MODE_DEFINITIONS.length) {
      await page.waitForTimeout(300)
      return await collectModeItems(page)
    }
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return observed
}

async function collectStableMoreSkills(page: Page, signal: AbortSignal | undefined) {
  const definitions = SKILL_DEFINITIONS.filter((candidate) => MORE_SKILLS.has(candidate.skill))
  const deadline = Date.now() + CONTROL_TIMEOUT_MS
  let observed = new Set<DoubaoSkill>()
  do {
    assertNotAborted(signal)
    observed = new Set<DoubaoSkill>()
    for (const definition of definitions) {
      if (await exactButton(page, definition.nativeLabel).count() > 0) observed.add(definition.skill)
    }
    if (observed.size === definitions.length) {
      await page.waitForTimeout(300)
      return observed
    }
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return observed
}

function modeFromLabel(label: string): DoubaoMode | null {
  return MODE_DEFINITIONS.find((definition) => label.startsWith(definition.nativeLabel))?.mode ?? null
}

function exactModeItem(page: Page, label: string) {
  return page.locator(MODE_ITEM_SELECTOR).filter({ visible: true }).filter({ hasText: new RegExp(`^${escapeRegExp(label)}`) }).last()
}

async function waitForModeTrigger(page: Page) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    const trigger = await visibleModeTrigger(page)
    if (trigger) return trigger
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return null
}

async function visibleModeTrigger(page: Page) {
  const trigger = page.locator(MODE_TRIGGER_SELECTOR).filter({ visible: true }).last()
  return await trigger.count() > 0 ? trigger : null
}

async function waitForVisibleUploadTrigger(page: Page) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    const trigger = page.locator('div.max-w-full.min-w-0.flex-1.relative.flex.items-center.h-36 > div:first-child > button[data-dbx-name="button"]')
      .filter({ visible: true })
      .last()
    if (await trigger.count() > 0) return trigger
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return null
}

async function waitForFileInput(page: Page) {
  const deadline = Date.now() + CONTROL_TIMEOUT_MS
  do {
    const input = page.locator('input[type="file"][multiple][accept*=".pdf"][accept*="py"]').last()
    if (await input.count() > 0) return input
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return null
}

async function waitForDefaultComposer(page: Page, signal: AbortSignal | undefined) {
  const deadline = Date.now() + CONTROL_SETTLE_TIMEOUT_MS
  do {
    assertNotAborted(signal)
    const composer = await visibleDefaultComposer(page)
    if (composer) return composer
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return null
}

async function visibleDefaultComposer(page: Page) {
  const composer = page.locator(DEFAULT_COMPOSER_SELECTOR).filter({ visible: true }).last()
  return await composer.count() > 0 ? composer : null
}

async function waitForExactButton(page: Page, label: string, timeoutMs = CONTROL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  do {
    const button = exactButton(page, label)
    if (await button.count() > 0) return button
    await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return null
}

function exactButton(page: Page, label: string) {
  return page.getByRole('button', { name: label, exact: true }).filter({ visible: true }).last()
}

function selectedSkillResult(definition: (typeof SKILL_DEFINITIONS)[number]): DoubaoSkillSelectResult {
  return {
    supported: true,
    selectedSkill: definition.skill,
    nativeLabel: definition.nativeLabel,
    visibleProof: definition.skill === 'chat' ? 'doubao-default-composer-visible' : 'doubao-active-skill-token-visible',
  }
}

function skill(
  skillId: DoubaoSkill,
  nativeLabel: string,
  nativeValue: string | null,
  canonicalCapabilities: readonly string[],
  selectable = true,
) {
  return Object.freeze({
    skill: skillId,
    nativeLabel,
    nativeValue,
    canonicalCapabilities: Object.freeze([...canonicalCapabilities]),
    selectable,
  })
}

function capabilityInspection(
  strategy: ProviderCapabilityStrategy,
  actions: readonly (typeof VISIBLE_ACTIONS)[keyof typeof VISIBLE_ACTIONS][],
  available: boolean,
  visibleProof: string,
  unavailableReason: string,
): ProviderCapabilityInspection {
  const availability = available ? 'available' as const : 'unknown' as const
  const reason = available ? null : unavailableReason
  return {
    ...strategy,
    actions,
    availability,
    visibleProof,
    reason,
    native: {
      ...strategy.native,
      availability,
      visibleProof,
      reason,
    },
  }
}

function normalizeText(value: string) {
  return value.replace(/\s+/gu, ' ').trim()
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Doubao control action was aborted.')
}
