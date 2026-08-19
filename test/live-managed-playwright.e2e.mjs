import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { createLiveBrowserInspectionSession } from './helpers/live-browser-observer.mjs'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'
import {
  knownIssueSkipForDurableBlocker,
  loadLiveProviderCapabilityMatrix,
  structuredBlockerCodes,
} from './helpers/live-provider-capability-matrix.mjs'
import {
  createLiveProviderE2eReport,
  finalizeLiveProviderE2eReport,
  formatLiveProviderE2eReport,
  recordLiveProviderCapability,
  writeLiveProviderE2eReport,
} from './helpers/live-provider-e2e-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const matrix = loadLiveProviderCapabilityMatrix()
const gate = requiredGate()
const browserTarget = await resolveConfiguredBrowserTarget()
const homeDir = browserTarget.homeDir
const profileSlug = browserTarget.profile.slug
const providerFilter = optionalProviderFilter(process.env.TOKENLESS_LIVE_E2E_PROVIDER)
const caseFilter = optionalCaseFilter(process.env.TOKENLESS_LIVE_E2E_CASES)
const suiteRunMarker = `${compactTimestamp(new Date())}_${randomUUID().slice(0, 8)}`
const submissionTrackers = new WeakMap()
const handlers = {
  'session-readiness': sessionReadiness,
  'prompt-draft': promptDraft,
  'model-choice': modelChoice,
  'effort-choice': effortChoice,
  'file-selection': fileSelection,
  'conversation-continuation': conversationContinuation,
  'model-comparison': modelComparison,
  'arena-search': arenaSearch,
  'arena-image': arenaImage,
  'meta-image': metaImage,
  'chatgpt-image': chatgptImage,
  'gemini-image': geminiImage,
  'dola-image': dolaImage,
  'doubao-image': doubaoImage,
  'grok-image': grokImage,
  'qwen-image': qwenImage,
  'arena-code': arenaCode,
  'arena-agent': arenaAgent,
  'arena-video': arenaVideo,
  'conversation-workflow': conversationWorkflow,
  'workspace-response-citations': workspaceResponseCitations,
  'workspace-response-baseline': workspaceResponseBaseline,
  'qwen-mode-workspace': qwenModeWorkspace,
  'deepseek-controls': deepSeekControls,
  'deepseek-search-reasoning': deepSeekSearchReasoning,
  'deepseek-vision-input': deepSeekVisionInput,
  'doubao-controls': doubaoControls,
  'native-project': nativeProject,
  'kimi-library-controls': kimiLibraryControls,
  'kimi-library-workflows': kimiLibraryWorkflows,
  'kimi-search': kimiSearch,
  'kimi-deep-research': kimiDeepResearch,
  'kimi-artifacts': kimiArtifacts,
  'kimi-long-running': kimiLongRunning,
  'kimi-agent-swarm': kimiAgentSwarm,
}

const selectedProviders = Object.entries(matrix.providers)
  .map(([provider, declaration]) => ({
    provider,
    declaration,
    caseIds: declaration.required.filter(
      (caseId) => (gate === 'all' || matrix.cases[caseId].gate === gate) &&
        (caseFilter === null || caseFilter.has(caseId)),
    ),
  }))
  .filter(({ provider }) => providerFilter === null || provider === providerFilter)
  .filter(({ caseIds }) => caseIds.length > 0)

assert.ok(selectedProviders.length > 0, `TOKENLESS_LIVE_E2E_GATE=${gate} selected no required providers`)
const suiteReport = createLiveProviderE2eReport({
  runId: suiteRunMarker,
  startedAt: new Date().toISOString(),
  gate,
  profileSlug,
  matrix,
  selectedProviders,
})
let sharedSession

test.before(async () => {
  const daemonUrl = `http://127.0.0.1:${await freePort()}`
  sharedSession = await createLiveBrowserInspectionSession({
    homeDir,
    profileSlug,
    daemonUrl,
  })
})

test.after(async () => {
  const cleanupErrors = []
  try {
    await sharedSession?.close()
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    finalizeLiveProviderE2eReport(suiteReport, new Date().toISOString())
    const reportPath = await writeLiveProviderE2eReport(suiteReport, path.join(root, 'test-results'))
    console.log(formatLiveProviderE2eReport(suiteReport, path.relative(root, reportPath)))
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Live provider E2E cleanup or report generation failed.')
  }
})

for (const { provider, declaration, caseIds } of selectedProviders) {
  test(`real provider ${provider}: ${gate} journey`, { timeout: 1_200_000 }, async (t) => {
    const session = sharedSession
    assert.ok(session, 'shared live E2E browser session must be initialized')
    const providerState = createProviderState()
    for (const caseId of caseIds) {
      await t.test(`${provider}: ${caseId}`, { timeout: 1_200_000 }, async (step) => {
        const caseStartedAt = Date.now()
        if (providerState.skipReason) {
          recordLiveProviderCapability(suiteReport, {
            provider,
            capability: caseId,
            status: 'known_issue',
            error: e2eSkip('e2e_known_issue_provider_blocker', providerState.skipReason),
            durationMs: Date.now() - caseStartedAt,
          })
          step.skip(providerState.skipReason)
          return
        }
        const journey = createCapabilityJourney(session, provider, caseId, providerState)
        const handler = handlers[caseId]
        assert.equal(typeof handler, 'function', `missing real E2E handler for ${caseId}`)
        submissionTrackers.set(journey, {
          attempts: 0,
          budget: matrix.cases[caseId].submissions,
          caseId,
        })
        try {
          if (
            matrix.cases[caseId].gate !== 'non_submission' &&
            declaration.account === 'signed_in_selected_setup_profile' &&
            !providerState.authenticated
          ) {
            await requireSignedInSelectedProfile(journey)
          }
          await handler({ provider, declaration, journey })
          assertSubmissionBudget(journey)
          recordLiveProviderCapability(suiteReport, {
            provider,
            capability: caseId,
            status: 'passed',
            durationMs: Date.now() - caseStartedAt,
          })
        } catch (error) {
          if (isKnownIssueSkip(error)) {
            providerState.skipReason = `${caseId}: ${error.message}`
            recordLiveProviderCapability(suiteReport, {
              provider,
              capability: caseId,
              status: 'known_issue',
              error,
              durationMs: Date.now() - caseStartedAt,
            })
            step.skip(providerState.skipReason)
            return
          }
          recordLiveProviderCapability(suiteReport, {
            provider,
            capability: caseId,
            status: 'failed',
            error,
            durationMs: Date.now() - caseStartedAt,
          })
          throw Object.assign(
            new Error(`${provider} journey step ${caseId}: ${error instanceof Error ? error.message : String(error)}`),
            { cause: error },
          )
        }
      })
    }
  })
}

async function requireSignedInSelectedProfile(journey) {
  const auth = await journey.action('auth.status')
  const result = responseResult(auth.payload, 'auth.status')
  await auth.close()
  const signedIn = result?.state === 'authenticated' || String(result?.access ?? '').startsWith('signed_in_')
  if (!signedIn) {
    throw e2eFailure(
      'e2e_provider_auth_unavailable',
      `${journey.provider} selected setup profile is not authenticated`,
    )
  }
  journey.providerState.authenticated = true
}

async function sessionReadiness({ provider, declaration, journey }) {
  const auth = await journey.action('auth.status')
  const authResult = responseResult(auth.payload, 'auth.status')
  await auth.close()
  const capabilities = await journey.action('capability.inspect')
  const capabilityResult = responseResult(capabilities.payload, 'capability.inspect')
  const navigation = await journey.action('navigation.check')
  assert.equal(responseResult(navigation.payload, 'navigation.check')?.allowed, true)
  const blocker = await journey.action('blocker.check')
  const blockerResult = responseResult(blocker.payload, 'blocker.check')
  assert.equal(blockerResult?.blocked, false)
  await Promise.all([capabilities.close(), navigation.close(), blocker.close()])
  const signedIn = authResult?.state === 'authenticated' || String(authResult?.access ?? '').startsWith('signed_in_')
  const guestReady = authResult?.access === 'guest' ||
    blockerResult?.observation?.composerVisible === true ||
    capabilityResult?.capabilities?.['conversation.continue']?.availability === 'available'
  const ready = declaration.account === 'signed_in_selected_setup_profile'
    ? signedIn
    : signedIn || guestReady
  if (!ready) {
    throw e2eFailure(
      'e2e_provider_auth_unavailable',
      `${provider} selected setup profile does not satisfy ${declaration.account}`,
    )
  }
  journey.providerState.authenticated = signedIn
}

async function promptDraft({ provider, journey }) {
  const marker = markerFor(provider, 'DRAFT')
  const input = await journey.action('prompt.input', ['--prompt', marker])
  assert.deepEqual(responseResult(input.payload, 'prompt.input'), {
    visible: true,
    inputProof: 'prompt-text-visible',
  })
  assert.equal(await composerContains(input.page, marker), true, `${provider} observer must see the unique draft`)
  await input.close()

  const clear = await journey.action('prompt.clear')
  assert.deepEqual(responseResult(clear.payload, 'prompt.clear'), {
    visible: true,
    inputProof: 'empty',
  })
  assert.equal(await composerContains(clear.page, marker), false, `${provider} observer must see the draft removed`)
  await clear.close()
}

async function modelChoice(context) {
  await choiceCase(context, 'model')
}

async function effortChoice(context) {
  await choiceCase(context, 'effort')
}

async function qwenModeWorkspace({ provider, journey }) {
  assert.equal(provider, 'qwen')
  const inspected = await journey.action('qwen.mode.inspect')
  const inspection = responseResult(inspected.payload, 'qwen.mode.inspect')
  assert.equal(inspection?.supported, true)
  assert.deepEqual(inspection?.active, { mode: 'Chat', variant: null })
  assert.equal(
    inspection?.modes?.some((mode) => mode.mode === 'Deep Research' && mode.enabled),
    true,
    'Qwen must expose an enabled Deep Research mode',
  )
  await inspected.close()

  const name = markerFor(provider, 'MODE_WORKSPACE')
  const marker = markerFor(provider, 'DEEP_RESEARCH')
  const clarification = await journey.run([
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--qwen-mode', 'Deep Research',
    '--qwen-mode-variant', 'Advanced',
    '--prompt', [
      'Proceed immediately with a standalone research report about the current official Qwen homepage.',
      'Prioritize user-visible product features rather than technical specifications.',
      'Use one unified overview rather than a breakdown by product tier.',
      'Organize the report into three sections: product features, available user entry points, and stated use cases grouped by user type.',
      'Use only official Qwen sources, do not compare competitors, and do not ask clarifying questions.',
    ].join(' '),
  ], 720_000, async ({ page }) => (
    await qwenActiveModeVisible(page, 'Deep Research', 'Advanced')
  ))
  const selected = responseResult(clarification.payload, 'qwen.mode.select')
  assert.deepEqual(selected, {
    supported: true,
    selectedMode: 'Deep Research',
    selectedVariant: 'Advanced',
    visibleProof: 'qwen-mode-and-variant-visible',
  })
  assert.equal(clarification.observerResult, true, 'Qwen observer must see Deep Research Advanced selected')
  assert.ok((responseResult(clarification.payload, 'response.read')?.text ?? '').length > 0)
  const conversationUrl = assertConversationWorkspaceResult(provider, journey.taskId, clarification)
  await clarification.close()

  const report = await journey.run([
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--prompt', [
      'Include both interactive elements and prominently advertised capabilities linked from the homepage.',
      'Include direct entry points plus pathways visible through navigation menus or footer links.',
      'Use explicitly named user types when available and otherwise synthesize categories from the stated workflows.',
      'Proceed immediately with the final report and do not ask more questions.',
      `Include this exact marker exactly once in the final report: ${marker}`,
    ].join(' '),
  ], 720_000)
  assert.match(responseResult(report.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(marker)))
  assert.equal(canonicalPageUrl(report.page.url()), conversationUrl)
  assertTaskConversationMapping(provider, journey.taskId, conversationUrl, report.payload)
  await report.close()

  const restored = await journey.action('qwen.mode.select', ['--qwen-mode', 'Chat'])
  assert.deepEqual(responseResult(restored.payload, 'qwen.mode.select'), {
    supported: true,
    selectedMode: 'Chat',
    selectedVariant: null,
    visibleProof: 'qwen-chat-mode-visible',
  })
  assert.equal(await exactTextVisible(restored.page, 'Auto'), true)
  await restored.close()
}

async function qwenActiveModeVisible(page, mode, variant) {
  const deadline = Date.now() + 30_000
  do {
    const active = page.locator('.mode-select').filter({ visible: true }).last()
    if (await active.count() > 0) {
      const label = (await active.innerText().catch(() => '')).replace(/\s+/gu, ' ').trim()
      if (label.includes(mode) && label.includes(variant)) return true
    }
    if (Date.now() < deadline) await page.waitForTimeout(100)
  } while (Date.now() < deadline)
  return false
}

async function deepSeekControls({ provider, journey }) {
  assert.equal(provider, 'deepseek')
  const modeInspection = await journey.action('deepseek.mode.inspect')
  const modes = responseResult(modeInspection.payload, 'deepseek.mode.inspect')
  assert.equal(modes?.supported, true)
  assert.deepEqual(modes?.modes?.map((choice) => choice.mode), ['Instant', 'Expert', 'Vision'])
  assert.equal(modes?.modes?.find((choice) => choice.mode === 'Instant')?.controls.search, true)
  assert.equal(modes?.modes?.find((choice) => choice.mode === 'Expert')?.controls.fileUpload, false)
  assert.equal(modes?.modes?.find((choice) => choice.mode === 'Vision')?.controls.imageFileSelection, true)
  const originalMode = modes.activeMode
  await modeInspection.close()

  const deepThinkInspection = await journey.action('deepseek.deepthink.inspect')
  const originalDeepThink = responseResult(deepThinkInspection.payload, 'deepseek.deepthink.inspect')?.enabled
  assert.equal(typeof originalDeepThink, 'boolean')
  await deepThinkInspection.close()

  let originalSearch
  try {
    const instant = await journey.action('deepseek.mode.select', ['--deepseek-mode', 'Instant'])
    assert.equal(responseResult(instant.payload, 'deepseek.mode.select')?.selectedMode, 'Instant')
    await instant.close()

    const searchInspection = await journey.action('deepseek.search.inspect')
    originalSearch = responseResult(searchInspection.payload, 'deepseek.search.inspect')?.enabled
    assert.equal(typeof originalSearch, 'boolean')
    await searchInspection.close()

    const searchChanged = await journey.action('deepseek.search.select', [
      '--deepseek-search', originalSearch ? 'off' : 'on',
    ])
    assert.equal(responseResult(searchChanged.payload, 'deepseek.search.select')?.enabled, !originalSearch)
    await searchChanged.close()

    const deepThinkChanged = await journey.action('deepseek.deepthink.select', [
      '--deepseek-deepthink', originalDeepThink ? 'off' : 'on',
    ])
    assert.equal(responseResult(deepThinkChanged.payload, 'deepseek.deepthink.select')?.enabled, !originalDeepThink)
    await deepThinkChanged.close()

    for (const mode of ['Expert', 'Vision']) {
      const selected = await journey.action('deepseek.mode.select', ['--deepseek-mode', mode])
      assert.equal(responseResult(selected.payload, 'deepseek.mode.select')?.selectedMode, mode)
      await selected.close()
      const search = await journey.action('deepseek.search.inspect')
      assert.deepEqual(responseResult(search.payload, 'deepseek.search.inspect'), {
        supported: false,
        activeMode: mode,
        reason: 'unavailable_in_mode',
      })
      await search.close()
    }
  } finally {
    const restoredMode = await journey.action('deepseek.mode.select', ['--deepseek-mode', originalMode])
    await restoredMode.close()
    const restoredDeepThink = await journey.action('deepseek.deepthink.select', [
      '--deepseek-deepthink', originalDeepThink ? 'on' : 'off',
    ])
    await restoredDeepThink.close()
    if (originalMode === 'Instant' && typeof originalSearch === 'boolean') {
      const restoredSearch = await journey.action('deepseek.search.select', [
        '--deepseek-search', originalSearch ? 'on' : 'off',
      ])
      await restoredSearch.close()
    }
  }
}

async function doubaoControls({ provider, journey }) {
  assert.equal(provider, 'doubao')
  const modeInspection = await journey.action('doubao.mode.inspect')
  const modes = responseResult(modeInspection.payload, 'doubao.mode.inspect')
  assert.equal(modes?.supported, true)
  assert.equal(modes?.activeMode, 'fast')
  assert.deepEqual(modes?.modes?.map((choice) => choice.mode), [
    'fast',
    'expert',
    'work-task-turbo',
    'work-task-pro',
  ])
  assert.deepEqual(modes?.modes?.find((choice) => choice.mode === 'work-task-pro'), {
    mode: 'work-task-pro',
    nativeLabel: '工作任务 Pro',
    description: '执行 agent 任务 - 2.1 Pro',
    canonicalCapabilities: ['task.background', 'task.interactive'],
    enabled: false,
    selected: false,
    reason: 'upgrade_required',
  })
  const originalMode = modes.activeMode
  await modeInspection.close()

  try {
    for (const mode of ['expert', 'work-task-turbo']) {
      const selected = await journey.action('doubao.mode.select', ['--doubao-mode', mode])
      const result = responseResult(selected.payload, 'doubao.mode.select')
      assert.equal(result?.selectedMode, mode)
      assert.equal(await doubaoModeVisible(selected.page, result.nativeLabel), true)
      await selected.close()
    }
    const unavailable = await journey.action('doubao.mode.select', ['--doubao-mode', 'work-task-pro'])
    assert.deepEqual(responseResult(unavailable.payload, 'doubao.mode.select'), {
      supported: false,
      reason: 'mode_unavailable',
    })
    await unavailable.close()
  } finally {
    const restored = await journey.action('doubao.mode.select', ['--doubao-mode', originalMode])
    assert.equal(responseResult(restored.payload, 'doubao.mode.select')?.selectedMode, originalMode)
    await restored.close()
  }

  const skillInspection = await journey.action('doubao.skill.inspect')
  const skills = responseResult(skillInspection.payload, 'doubao.skill.inspect')
  assert.equal(skills?.supported, true)
  assert.equal(skills?.activeSkill, 'chat')
  const audioTranscription = skills?.skills?.find((choice) => choice.skill === 'audio-transcription')
  assert.deepEqual({ ...audioTranscription, reason: undefined }, {
    skill: 'audio-transcription',
    nativeLabel: '录音转写',
    canonicalCapabilities: ['audio.transcription'],
    enabled: false,
    selected: false,
    reason: undefined,
  })
  assert.ok([null, 'desktop_app_required'].includes(audioTranscription?.reason))
  const selectableSkills = skills.skills.filter((choice) => choice.enabled && choice.skill !== 'chat')
  assert.deepEqual(selectableSkills.map((choice) => choice.skill), [
    'document-writing',
    'presentation-generation',
    'image-generation',
    'video-generation',
    'deep-research',
    'music-generation',
    'problem-solving',
    'spreadsheet-generation',
  ])
  await skillInspection.close()

  try {
    for (const choice of selectableSkills) {
      const selected = await journey.action('doubao.skill.select', ['--doubao-skill', choice.skill])
      const result = responseResult(selected.payload, 'doubao.skill.select')
      assert.equal(result?.selectedSkill, choice.skill)
      assert.equal(await doubaoSkillVisible(selected.page, choice.nativeLabel), true)
      await selected.close()
    }
    const unavailable = await journey.action('doubao.skill.select', ['--doubao-skill', 'audio-transcription'])
    assert.deepEqual(responseResult(unavailable.payload, 'doubao.skill.select'), {
      supported: false,
      reason: 'skill_unavailable',
    })
    await unavailable.close()
  } finally {
    const restored = await journey.action('doubao.skill.select', ['--doubao-skill', 'chat'])
    assert.deepEqual(responseResult(restored.payload, 'doubao.skill.select'), {
      supported: true,
      selectedSkill: 'chat',
      nativeLabel: '普通对话',
      visibleProof: 'doubao-default-composer-visible',
    })
    assert.equal(await restored.page.locator('textarea.semi-input-textarea, div[role="textbox"].tiptap.ProseMirror').filter({ visible: true }).count(), 1)
    await restored.close()
  }
}

async function doubaoModeVisible(page, nativeLabel) {
  const trigger = page.locator(
    'button[aria-haspopup="menu"][aria-expanded]:has([data-valid-btn="mode-select-action-btn"])',
  ).filter({ visible: true }).last()
  return await trigger.count() > 0 && (await trigger.innerText()).replace(/\s+/gu, ' ').trim().startsWith(nativeLabel)
}

async function doubaoSkillVisible(page, nativeLabel) {
  const token = page.locator('div[data-input-engine-action-source="actionbar"][data-value]')
    .filter({ visible: true })
    .filter({ hasText: new RegExp(`^${escapeRegExp(nativeLabel)}$`) })
    .last()
  return await token.count() > 0
}

async function deepSeekSearchReasoning({ provider, journey }) {
  assert.equal(provider, 'deepseek')
  const modeInspection = await journey.action('deepseek.mode.inspect')
  const originalMode = responseResult(modeInspection.payload, 'deepseek.mode.inspect')?.activeMode
  assert.ok(['Instant', 'Expert', 'Vision'].includes(originalMode))
  await modeInspection.close()
  const deepThinkInspection = await journey.action('deepseek.deepthink.inspect')
  const originalDeepThink = responseResult(deepThinkInspection.payload, 'deepseek.deepthink.inspect')?.enabled
  assert.equal(typeof originalDeepThink, 'boolean')
  await deepThinkInspection.close()
  const instant = await journey.action('deepseek.mode.select', ['--deepseek-mode', 'Instant'])
  await instant.close()
  const searchInspection = await journey.action('deepseek.search.inspect')
  const originalSearch = responseResult(searchInspection.payload, 'deepseek.search.inspect')?.enabled
  assert.equal(typeof originalSearch, 'boolean')
  await searchInspection.close()

  try {
    const reasoningMarker = markerFor(provider, 'DEEPTHINK_RESPONSE')
    const reasoning = await journey.run([
      '--deepseek-mode', 'Instant',
      '--deepseek-deepthink', 'on',
      '--deepseek-search', 'off',
      '--prompt', `Use DeepThink to calculate 37 multiplied by 43. Include this exact marker in the final answer: ${reasoningMarker}`,
    ])
    assert.equal(responseResult(reasoning.payload, 'deepseek.mode.select')?.selectedMode, 'Instant')
    assert.equal(responseResult(reasoning.payload, 'deepseek.deepthink.select')?.enabled, true)
    assert.equal(responseResult(reasoning.payload, 'deepseek.search.select')?.enabled, false)
    assert.match(responseResult(reasoning.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(reasoningMarker)))
    await reasoning.close()

    const searchMarker = markerFor(provider, 'SEARCH_RESPONSE')
    const search = await journey.run([
      '--deepseek-mode', 'Instant',
      '--deepseek-deepthink', 'off',
      '--deepseek-search', 'on',
      '--prompt', `Use web search to identify the official Node.js homepage. Include this exact marker: ${searchMarker}. Provide visible source links.`,
    ])
    const response = responseResult(search.payload, 'response.read')
    assert.equal(responseResult(search.payload, 'deepseek.search.select')?.enabled, true)
    assert.match(response?.text ?? '', new RegExp(escapeRegExp(searchMarker)))
    assert.ok(Array.isArray(response?.citations) && response.citations.length > 0)
    assert.ok(await visibleCitationCount(search.page, response.citations) > 0)
    await search.close()
  } finally {
    const restoreInstant = await journey.action('deepseek.mode.select', ['--deepseek-mode', 'Instant'])
    await restoreInstant.close()
    const restoreSearch = await journey.action('deepseek.search.select', [
      '--deepseek-search', originalSearch ? 'on' : 'off',
    ])
    await restoreSearch.close()
    const restoreMode = await journey.action('deepseek.mode.select', ['--deepseek-mode', originalMode])
    await restoreMode.close()
    const restoreDeepThink = await journey.action('deepseek.deepthink.select', [
      '--deepseek-deepthink', originalDeepThink ? 'on' : 'off',
    ])
    await restoreDeepThink.close()
  }
}

async function choiceCase({ provider, journey }, kind) {
  const inspectAction = `${kind}.inspect`
  const selectAction = `${kind}.select`
  const inspect = await journey.action(inspectAction)
  const result = responseResult(inspect.payload, inspectAction)
  assert.equal(result?.supported, true, `${provider} ${inspectAction} must be supported`)
  const selected = result.choices.find((choice) => choice.selected && choice.enabled)
  const alternate = result.choices.find((choice) => !choice.selected && choice.enabled)
  assert.ok(selected, `${provider} ${kind} must expose the selected choice`)
  assert.ok(alternate, `${provider} ${kind} must expose a real alternate choice`)
  await inspect.close()

  const option = kind === 'model' ? '--model' : '--effort'
  const changed = await journey.action(selectAction, [option, alternate.label])
  try {
    assert.equal(responseResult(changed.payload, selectAction)?.selectedLabel, alternate.label)
    assert.equal(await choiceLabelVisible(changed.page, alternate.label), true, `${provider} observer must see selected ${kind}`)
  } finally {
    await changed.close()
    const restored = await journey.action(selectAction, [option, selected.label])
    assert.equal(responseResult(restored.payload, selectAction)?.selectedLabel, selected.label)
    await restored.close()
  }
}

async function choiceLabelVisible(page, label) {
  if (await exactTextVisible(page, label)) return true
  const controls = page.locator('button[aria-haspopup="menu"], button[aria-haspopup="dialog"]').filter({ visible: true })
  for (let index = 0; index < await controls.count(); index += 1) {
    const text = await controls.nth(index).evaluate((element) => (
      `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`
    ).replace(/\s+/gu, ' ').trim())
    if (text === label || text.includes(label)) return true
  }
  return false
}

async function fileSelection({ provider, journey }) {
  const extension = provider === 'arena' ? '.png' : provider === 'gemini' || provider === 'meta' ? '.md' : '.txt'
  const name = provider === 'meta'
    ? `browser-fingerprint-review-${compactTimestamp(new Date())}${extension}`
    : `${markerFor(provider, 'ATTACHMENT')}${extension}`
  const file = path.join(root, 'test-results', 'live-provider-inputs', name)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const contents = provider === 'meta'
    ? [
        '# Browser Fingerprint Review',
        '',
        'A browser identity spans TLS ClientHello behavior, HTTP/2 settings, request headers, JavaScript APIs, IP reputation, and behavioral timing.',
        'Matching one layer does not establish end-to-end browser equivalence.',
      ].join('\n')
    : `${name}\n`
  if (provider === 'arena') {
    await fs.copyFile(path.join(root, 'assets', 'tokenless-logo-v1.png'), file)
    await fs.chmod(file, 0o600)
  } else {
    await fs.writeFile(file, contents, { mode: 0o600 })
  }
  const deepSeekState = provider === 'deepseek' ? await captureDeepSeekState(journey) : null
  let geminiAttachmentCardsBefore = null
  try {
    if (deepSeekState) {
      const instant = await journey.action('deepseek.mode.select', ['--deepseek-mode', 'Instant'])
      assert.equal(responseResult(instant.payload, 'deepseek.mode.select')?.selectedMode, 'Instant')
      await instant.close()
    }
    const uploaded = await journey.action(
      'file.upload',
      ['--attach-file', file],
      180_000,
      provider === 'gemini'
        ? async ({ page }) => {
          const deadline = Date.now() + 180_000
          while (Date.now() <= deadline) {
            const after = await visibleGeminiAttachmentCardCount(page)
            if (after > geminiAttachmentCardsBefore) return after
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          return await visibleGeminiAttachmentCardCount(page)
        }
        : undefined,
      provider === 'gemini'
        ? async ({ page }) => {
          geminiAttachmentCardsBefore = await visibleGeminiAttachmentCardCount(page)
        }
        : undefined,
    )
    const result = responseResult(uploaded.payload, 'file.upload')
    assert.ok(result?.attachments?.some((attachment) => attachment.name === name))
    if (provider === 'gemini') {
      assert.ok(Number.isInteger(geminiAttachmentCardsBefore), 'Gemini observer must record its initial physical card count')
      assert.equal(
        uploaded.observerResult,
        geminiAttachmentCardsBefore + 1,
        'Gemini observer must see one newly visible physical attachment card',
      )
    } else if (provider === 'arena') {
      assert.equal(
        await uploaded.page.getByAltText(name, { exact: true }).isVisible().catch(() => false),
        true,
        'Arena observer must see the selected image preview',
      )
    } else {
      const visibleName = provider === 'kimi' || provider === 'meta' ? path.parse(name).name : name
      assert.equal(await exactTextVisible(uploaded.page, visibleName), true, `${provider} observer must see selected attachment`)
    }
    await uploaded.close()
    const cleared = await journey.action('prompt.clear')
    await cleared.close()
  } finally {
    await fs.rm(file, { force: true })
    if (deepSeekState) await restoreDeepSeekState(journey, deepSeekState)
  }
}

async function conversationContinuation({ provider, journey }) {
  const name = markerFor(provider, 'CONVERSATION_CONTINUATION')
  const firstMarker = markerFor(provider, 'CONTINUATION_TURN_ONE')
  const contextSecret = markerFor(provider, 'CONTINUATION_SECRET')
  const first = await journey.run([
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--prompt', `Reply with exactly ${firstMarker}. Remember ${contextSecret} for the next message but do not include it now.`,
  ])
  const firstText = responseResult(first.payload, 'response.read')?.text ?? ''
  assert.match(firstText, new RegExp(escapeRegExp(firstMarker)))
  assert.doesNotMatch(firstText, new RegExp(escapeRegExp(contextSecret)))
  const conversationUrl = assertConversationWorkspaceResult(provider, journey.taskId, first)
  await first.close()

  const second = await journey.run([
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--capability', 'conversation.continue',
    '--prompt', 'Reply with exactly the secret from my previous message and no other text.',
  ])
  const secondText = responseResult(second.payload, 'response.read')?.text ?? ''
  assert.match(secondText, new RegExp(escapeRegExp(contextSecret)))
  assert.doesNotMatch(secondText, new RegExp(escapeRegExp(firstMarker)))
  assert.equal(canonicalPageUrl(second.page.url()), conversationUrl)
  assertTaskConversationMapping(provider, journey.taskId, conversationUrl, second.payload)
  await second.close()
}

async function modelComparison({ provider, journey }) {
  assert.equal(provider, 'arena')
  const prompt = [
    'Compare discriminated-union Result values with typed exceptions and centralized middleware',
    'for TypeScript JSON API error handling. Give executable advice and a clear recommendation.',
  ].join(' ')
  for (const mode of ['battle', 'side-by-side']) {
    const run = await journey.run([
      '--capability', 'model.compare',
      '--arena-mode', mode,
      '--arena-modality', 'text',
      '--prompt', prompt,
    ])
    const result = responseResult(run.payload, 'response.read')
    assert.equal(result?.alternatives?.length, 2)
    assert.equal(result?.text, result.alternatives.map((answer) => `${answer.label}\n\n${answer.text}`).join('\n\n'))
    assert.ok(result.alternatives.every((answer) => answer.text.length > 0))
    if (mode === 'battle') {
      assert.deepEqual(result.alternatives.map((answer) => answer.model), [null, null])
    } else {
      assert.ok(result.alternatives.every((answer) => typeof answer.model === 'string' && answer.model.length > 0))
    }
    await run.close()
  }
}

async function arenaSearch({ provider, journey }) {
  assert.equal(provider, 'arena')
  const marker = markerFor(provider, 'SEARCH_GROUNDED_RESPONSE')
  const run = await journey.run([
    '--capability', 'search.web',
    '--capability', 'response.citations',
    '--project-name', markerFor(provider, 'SEARCH_WORKSPACE'),
    '--workspace-mode', 'conversation',
    '--prompt', [
      'Use official Arena sources to list three Agent Mode tools with one-sentence purposes and visible HTTPS citations.',
      `End with this exact marker: ${marker}`,
    ].join(' '),
  ])
  const response = responseResult(run.payload, 'response.read')
  assert.ok((response?.text ?? '').length >= 300, 'Arena Search must return a substantive grounded answer')
  assert.match(response.text, new RegExp(escapeRegExp(marker)))
  assert.ok(Array.isArray(response.citations) && response.citations.length > 0)
  assert.ok(response.citations.every((citation) => citation.href.startsWith('https://')))
  assert.ok(await visibleCitationCount(run.page, response.citations) > 0)
  assertConversationWorkspaceResult(provider, journey.taskId, run)
  await run.close()
}

async function arenaImage({ provider, journey }) {
  assert.equal(provider, 'arena')
  const generated = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one flat blue paper airplane icon centered on a plain white background, with no text.',
  ])
  const generatedResponse = imageGenerationResult(generated.payload, provider)
  const generatedArtifacts = assertArenaImageArtifacts(generatedResponse)
  await assertArenaPersistedAssets(journey.session, generated.page, generatedArtifacts)
  assert.equal(await visibleArenaArtifactCount(generated.page, generatedArtifacts), generatedArtifacts.length)
  await generated.close()

  const edited = await journey.run([
    '--capability', 'image.edit',
    '--capability', 'artifact.download',
    '--attach-file', path.join(root, 'assets', 'tokenless-mark.png'),
    '--prompt', 'Edit the attached image so its background is pale yellow. Keep the existing logo shape and colors unchanged, and add no text.',
  ])
  const editedResponse = responseResult(edited.payload, 'response.read')
  const editedArtifacts = assertArenaImageArtifacts(editedResponse)
  await assertArenaPersistedAssets(journey.session, edited.page, editedArtifacts)
  assert.equal(editedResponse.text.includes('Edit the attached image so its background is pale yellow.'), false)
  assert.equal(await visibleArenaArtifactCount(edited.page, editedArtifacts), editedArtifacts.length)
  const upload = responseResult(edited.payload, 'file.upload')
  assert.equal(upload?.acceptance, 'accepted')
  assert.equal(upload?.attachments?.some((attachment) => attachment.name === 'tokenless-mark.png'), true)
  await assertArenaEditSourceDistinct(edited.page, 'tokenless-mark.png')
  await edited.close()
}

async function metaImage({ provider, journey }) {
  assert.equal(provider, 'meta')
  const run = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one flat blue paper airplane icon centered on a plain white background, with no text.',
  ], 360_000)
  try {
    const response = imageGenerationResult(run.payload, provider)
    const artifacts = assertMetaImageArtifacts(response)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    assert.equal(await visibleMetaArtifactCount(run.page, artifacts), artifacts.length)
    assert.equal(await run.page.locator('[data-testid="composer-stop-button"]').filter({ visible: true }).count(), 0)
  } finally {
    await run.close()
  }
}

async function chatgptImage({ provider, journey }) {
  assert.equal(provider, 'chatgpt')
  const run = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one flat blue paper airplane icon centered on a plain white background, with no text.',
  ], 360_000)
  try {
    const response = imageGenerationResult(run.payload, provider)
    const artifacts = assertChatGptImageArtifacts(response)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    assert.equal(await visibleChatGptArtifactCount(run.page, artifacts), artifacts.length)
    assert.equal(await run.page.locator('button[data-testid="stop-button"], button[aria-label*="Stop generating" i]').filter({ visible: true }).count(), 0)
  } finally {
    await run.close()
  }
}

async function geminiImage({ provider, journey }) {
  assert.equal(provider, 'gemini')
  const run = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one simple flat blue paper airplane icon on a plain white background, with no text.',
  ], 360_000)
  try {
    const response = imageGenerationResult(run.payload, provider)
    const artifacts = assertGeminiImageArtifacts(response)
    assert.equal(artifacts.length, 1)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    assert.equal(await visibleGeminiArtifactCount(run.page, artifacts), 1)
    assert.equal(await run.page.locator('button[aria-label="Stop response"]').filter({ visible: true }).count(), 0)
    assert.ok(await run.page.locator('image-loading-overlay .done-generating').filter({ visible: true }).count() > 0)
  } finally {
    await run.close()
  }
}

async function dolaImage({ provider, journey }) {
  assert.equal(provider, 'dola')
  const run = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one simple flat green leaf icon on a plain white background, with no text.',
  ], 360_000)
  try {
    const response = imageGenerationResult(run.payload, provider)
    const artifacts = assertDolaImageArtifacts(response)
    assertImageConversationIdentity(run.page, artifacts, provider)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    assert.equal(await visibleDolaArtifactCount(run.page, artifacts), artifacts.length)
  } finally {
    await run.close()
  }
}

async function doubaoImage({ provider, journey }) {
  assert.equal(provider, 'doubao')
  const run = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', '生成一张简洁的蓝色纸飞机图标，白色背景，不要文字。',
  ], 360_000)
  try {
    const response = imageGenerationResult(run.payload, provider)
    const artifacts = assertDoubaoImageArtifacts(response)
    assertImageConversationIdentity(run.page, artifacts, provider)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    assert.equal(await visibleDoubaoArtifactCount(run.page, artifacts), artifacts.length)
  } finally {
    await run.close()
  }
}

async function grokImage({ provider, journey }) {
  assert.equal(provider, 'grok')
  const run = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one flat blue paper airplane icon centered on a plain white background, with no text.',
  ], 360_000)
  try {
    const response = imageGenerationResult(run.payload, provider)
    const artifacts = assertGrokImageArtifacts(response)
    assert.equal(artifacts.length, 2)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    await assertGrokVisibleImagePosts(run.page, artifacts)
    assert.equal(await run.page.locator('button[aria-label="Media generation in progress"]').filter({ visible: true }).count(), 0)
    assert.equal(new URL(run.page.url()).pathname, `/imagine/post/${artifacts.at(-1).conversationId}`)
    const database = new DatabaseSync(path.join(journey.session.homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const taskMapping = database.prepare(
        'SELECT COUNT(*) AS count FROM provider_task_conversations WHERE provider = ? AND task_id = ?',
      ).get('grok', journey.taskId)
      assert.equal(taskMapping.count, 0, 'Grok Imagine post URLs must not become task chat mappings')
      const projectMapping = database.prepare(
        'SELECT COUNT(*) AS count FROM provider_conversations WHERE provider = ? AND task_id = ?',
      ).get('grok', journey.taskId)
      assert.equal(projectMapping.count, 0, 'Grok Imagine post URLs must not become Project chat mappings')
    } finally {
      database.close()
    }
  } finally {
    await run.close()
  }
}

async function qwenImage({ provider, journey }) {
  assert.equal(provider, 'qwen')
  const generated = await journey.run([
    '--capability', 'image.generation',
    '--capability', 'artifact.download',
    '--prompt', 'Generate one simple flat green leaf icon on a plain white background, with no text.',
  ], 360_000)
  try {
    const response = imageGenerationResult(generated.payload, provider)
    const artifacts = assertQwenImageArtifacts(response)
    await assertPersistedImageAssets(journey.session, generated.page, artifacts)
    assert.equal(await visibleQwenArtifactCount(generated.page, artifacts), artifacts.length)
  } finally {
    await generated.close()
  }
  await runImageEdit({
    provider,
    journey,
    prompt: 'Edit the attached image so its background is pale yellow. Preserve the subject and add no text.',
    assertArtifacts: assertQwenImageArtifacts,
    visibleArtifacts: visibleQwenArtifactCount,
  })
}

async function runImageEdit({
  provider,
  journey,
  prompt,
  assertArtifacts,
  visibleArtifacts,
  assertVisible,
}) {
  const run = await journey.run([
    '--capability', 'image.edit',
    '--capability', 'artifact.download',
    '--attach-file', path.join(root, 'assets', 'tokenless-mark.png'),
    '--prompt', prompt,
  ], 360_000)
  try {
    const response = responseResult(run.payload, 'response.read')
    const artifacts = assertArtifacts(response)
    await assertPersistedImageAssets(journey.session, run.page, artifacts)
    if (visibleArtifacts) assert.equal(await visibleArtifacts(run.page, artifacts), artifacts.length)
    if (assertVisible) await assertVisible(run.page, artifacts)
    const upload = responseResult(run.payload, 'file.upload')
    assert.equal(upload?.acceptance, 'accepted')
    assert.equal(upload?.attachments?.some((attachment) => attachment.name === 'tokenless-mark.png'), true)
    assert.equal(response.text?.includes(prompt), false)
  } finally {
    await run.close()
  }
}

async function arenaCode({ provider, journey }) {
  assert.equal(provider, 'arena')
  const prompt = [
    'Build a single-file accessible HTML counter app with Increment and Reset buttons.',
    'Use semantic HTML, visible focus styles, an aria-live count, and no external dependencies.',
    'Briefly explain the generated file.',
  ].join(' ')
  const run = await journey.run([
    '--capability', 'website.generation',
    '--prompt', prompt,
  ])
  const response = responseResult(run.payload, 'response.read')
  assert.equal(response?.visibleProof, 'visible-arena-current-turn-code-artifact-read')
  assert.equal(response?.text.includes(prompt), false)
  assert.equal(response?.artifacts?.length, 1)
  const artifact = response.artifacts[0]
  assert.equal(artifact?.kind, 'code')
  assert.equal(artifact?.visibleProof, 'visible-arena-current-file-code-and-associated-preview')
  assert.equal(artifact?.files?.length, 1)
  const file = artifact.files[0]
  assert.equal(file?.name, 'index.html')
  assert.equal(file?.language, 'html')
  assert.equal(file?.mediaType, 'text/html')
  assert.match(file?.content ?? '', /<!doctype html>/iu)
  assert.match(file?.content ?? '', /aria-live=["']polite["']/iu)
  assert.match(file?.content ?? '', /focus-visible/iu)
  assert.match(file?.content ?? '', />\s*Increment\s*</iu)
  assert.match(file?.content ?? '', />\s*Reset\s*</iu)
  assert.equal(typeof artifact.previewUrl, 'string')
  const previewUrl = new URL(artifact.previewUrl)
  assert.equal(previewUrl.protocol, 'https:')
  assert.equal(previewUrl.hostname.endsWith('.arena.site'), true)
  assert.equal(artifact.downloadAvailable, true)

  const assistant = run.page.locator('ol.flex-col-reverse > :first-child + div').filter({
    visible: true,
    has: run.page.getByRole('button', { name: 'Created index.html', exact: true }),
  }).first()
  assert.equal(await assistant.isVisible({ timeout: 100 }).catch(() => false), true)
  const created = assistant.getByRole('button', { name: 'Created index.html', exact: true })
  const filePanel = created.locator('xpath=..')
  const visibleCode = filePanel.locator('.shiki.shiki-code-block').filter({ visible: true })
  assert.equal(await visibleCode.count(), 1)
  assert.equal((await visibleCode.innerText()).trim(), file.content)
  const assistantPanel = assistant.locator('xpath=ancestor::*[@data-panel][1]')
  const workspace = assistantPanel.locator('xpath=parent::*[@data-panel-group-direction][1]')
  const workspacePanels = workspace.locator(':scope > [data-panel]').filter({ visible: true })
  assert.equal(await workspacePanels.count(), 2)
  assert.equal(await assistantPanel.locator('iframe[title="Option A Preview"]').count(), 0)
  const previewPanel = workspacePanels.filter({
    has: run.page.locator('iframe[title="Option A Preview"]'),
  })
  assert.equal(await previewPanel.count(), 1)
  assert.match(await previewPanel.innerText(), /arena\.site/u)
  const preview = previewPanel.locator('iframe[title="Option A Preview"]').filter({ visible: true })
  assert.equal(await preview.count(), 1)
  assert.equal(canonicalPageUrl(await preview.getAttribute('src')), canonicalPageUrl(artifact.previewUrl))
  assert.equal(await previewPanel.getByRole('button', { name: 'Download', exact: true }).filter({ visible: true }).isVisible(), true)
  await run.close()
}

async function arenaAgent({ provider, journey }) {
  assert.equal(provider, 'arena')
  const marker = markerFor(provider, 'AGENT_TERMINAL_RESPONSE')
  const run = await journey.run([
    '--capability', 'agent.execute',
    '--prompt', [
      'Using only official Arena sources, summarize exactly three Agent Mode tools in a small Markdown table',
      'with columns Tool, Purpose, and Official source. Cite one visible official HTTPS source for each row.',
      'Do not use external integrations or take actions outside web research.',
      `End with this exact marker: ${marker}`,
    ].join(' '),
  ])
  assert.match(run.page.url(), /^https:\/\/arena\.ai\/agent\/[A-Za-z0-9-]+$/u)
  const response = responseResult(run.payload, 'response.read')
  assert.equal(response?.visibleProof, 'visible-arena-current-agent-run-terminal-answer-read')
  assert.match(response?.text ?? '', new RegExp(escapeRegExp(marker)))
  assert.equal(response?.agentRun?.status, 'succeeded')
  assert.equal(response?.agentRun?.visibleProof, 'visible-arena-current-agent-run-tool-steps-and-terminal-review')
  assert.ok(Array.isArray(response?.agentRun?.steps) && response.agentRun.steps.length > 0)
  assert.ok(response.agentRun.steps.some((step) => step.label === 'Searched the web'))
  assert.ok(response.agentRun.steps.every((step) => typeof step.details === 'string' && step.details.length > 0))
  assert.ok(Array.isArray(response?.citations) && response.citations.length > 0)
  assert.ok(response.citations.every((citation) => (
    citation.href.startsWith('https://arena.ai/') || citation.href.startsWith('https://help.arena.ai/')
  )))
  assert.equal(response?.artifacts, undefined)

  const log = run.page.getByRole('log').filter({ visible: true })
  assert.equal(await log.count(), 1)
  const copy = log.getByRole('button', { name: 'Copy', exact: true }).filter({ visible: true })
  assert.equal(await copy.count(), 1)
  const card = copy.locator(
    'xpath=ancestor::div[.//div[contains(concat(" ", normalize-space(@class), " "), " body-base ")]][1]',
  )
  assert.equal(await card.count(), 1)
  const final = card.locator('.prose.body-base').filter({ visible: true })
  assert.equal(await final.count(), 1)
  assert.equal((await final.innerText()).replace(/\s+/gu, ' ').trim(), response.text)
  const visibleCitations = await final.locator('a[href]').filter({ visible: true }).evaluateAll((anchors) => (
    [...new Set(anchors.map((anchor) => anchor instanceof HTMLAnchorElement ? anchor.href : '').filter(Boolean))]
  ))
  assert.deepEqual(
    visibleCitations.map(canonicalPageUrl).sort(),
    response.citations.map((citation) => canonicalPageUrl(citation.href)).sort(),
  )
  const toolControls = card.locator('button[aria-expanded]').filter({ visible: true })
  assert.equal(await toolControls.count(), response.agentRun.steps.length)
  assert.equal(await run.page.getByText('Was this task successful?', { exact: true }).filter({ visible: true }).count(), 1)
  await run.close()
}

async function arenaVideo({ provider, journey }) {
  assert.equal(provider, 'arena')
  const run = await journey.run([
    '--capability', 'video.generation',
    '--prompt', [
      'Generate a short seamless loop of a flat blue paper airplane gliding smoothly from left to right',
      'across a clean white background. Use a minimal flat vector style with steady framing,',
      'no camera movement, no text, and no audio.',
    ].join(' '),
  ], 300_000)
  assert.match(run.page.url(), /^https:\/\/arena\.ai\/c\/[A-Za-z0-9-]+$/u)
  const response = responseResult(run.payload, 'response.read')
  assert.equal(response?.visibleProof, 'visible-arena-current-turn-video-artifacts-read')
  assert.equal(response?.alternatives?.length, 2)
  assert.equal(response?.artifacts?.length, 2)
  const artifacts = response.artifacts
  assert.deepEqual(artifacts.map((artifact) => artifact.label), ['A', 'B'])
  assert.deepEqual(response.alternatives.map((alternative) => alternative.label), ['A', 'B'])
  assert.ok(response.alternatives.every((alternative, index) => (
    alternative.model === null &&
    alternative.text === artifacts[index].url &&
    alternative.citations.length === 0
  )))
  assert.equal(new Set(artifacts.map((artifact) => canonicalPageUrl(artifact.url))).size, 2)
  assert.ok(artifacts.every((artifact) => (
    artifact.kind === 'video' &&
    artifact.model === null &&
    artifact.mediaType === 'video/mp4' &&
    artifact.url.startsWith('https://') &&
    new URL(artifact.url).pathname.endsWith('.mp4') &&
    Number.isFinite(artifact.width) && artifact.width > 0 &&
    Number.isFinite(artifact.height) && artifact.height > 0 &&
    Number.isFinite(artifact.durationSeconds) && artifact.durationSeconds > 0 &&
    artifact.downloadAvailable === false &&
    artifact.visibleProof === 'visible-arena-current-assistant-video-panel'
  )))
  assert.ok(artifacts.every((artifact) => response.text.includes(`${artifact.label}: ${artifact.url}`)))
  assert.equal(response.text.includes('https://arena.ai/videos/cta/agents-cta.mp4'), false)

  const assistant = run.page.locator('ol.flex-col-reverse > :first-child + div').filter({
    visible: true,
    has: run.page.getByText('Assistant A', { exact: true }),
  }).filter({
    has: run.page.getByText('Assistant B', { exact: true }),
  })
  assert.equal(await assistant.count(), 1)
  for (const artifact of artifacts) {
    const label = assistant.getByText(`Assistant ${artifact.label}`, { exact: true }).filter({ visible: true })
    assert.equal(await label.count(), 1)
    const panel = label.locator('xpath=ancestor::div[.//video][1]')
    assert.equal(await panel.count(), 1)
    const video = panel.locator('video').filter({ visible: true })
    assert.equal(await video.count(), 1)
    const metadata = await video.evaluate((element) => ({
      url: element.currentSrc || element.src,
      width: element.videoWidth,
      height: element.videoHeight,
      durationSeconds: element.duration,
    }))
    assert.equal(canonicalPageUrl(metadata.url), canonicalPageUrl(artifact.url))
    assert.equal(metadata.width, artifact.width)
    assert.equal(metadata.height, artifact.height)
    assert.equal(metadata.durationSeconds, artifact.durationSeconds)
    assert.equal(await panel.getByText(/Download/iu).filter({ visible: true }).count(), 0)
  }
  assert.equal(await run.page.locator('button[aria-label*="Stop" i]').filter({ visible: true }).count(), 0)
  await run.close()
}

async function conversationWorkflow({ provider, journey }) {
  const name = markerFor(provider, 'CONVERSATION_WORKFLOW')
  const attachmentMarker = markerFor(provider, 'ATTACHMENT')
  const responseMarker = markerFor(provider, 'TURN_ONE_RESPONSE')
  const contextSecret = markerFor(provider, 'CONTEXT_SECRET')
  const attachmentName = `${attachmentMarker}.txt`
  const attachment = path.join(root, 'test-results', 'live-provider-inputs', attachmentName)
  await fs.mkdir(path.dirname(attachment), { recursive: true, mode: 0o700 })
  await fs.writeFile(attachment, `${attachmentMarker}\n`, { mode: 0o600 })
  const deepSeekState = provider === 'deepseek' ? await captureDeepSeekState(journey) : null
  try {
    const first = await journey.run([
      '--project-name', name,
      '--workspace-mode', 'conversation',
      ...(provider === 'deepseek' ? [
        '--deepseek-mode', 'Instant',
        '--deepseek-deepthink', 'off',
        '--deepseek-search', 'on',
      ] : []),
      '--attach-file', attachment,
      '--prompt', [
        'Read the attached text file.',
        'Respond with exactly three lines: the exact file contents; then the following response marker;',
        `${responseMarker}; then a Markdown link to the official Node.js homepage.`,
        `Remember ${contextSecret} for my next message, but do not include it in this response.`,
      ].join(' '),
    ], 360_000, ({ page }) => waitForExactText(
      page,
      provider === 'kimi' ? path.parse(attachmentName).name : attachmentName,
      180_000,
    ))
    const firstText = responseResult(first.payload, 'response.read')?.text ?? ''
    const citations = responseResult(first.payload, 'response.read')?.citations
    assert.match(firstText, new RegExp(escapeRegExp(attachmentMarker)))
    assert.match(firstText, new RegExp(escapeRegExp(responseMarker)))
    assert.doesNotMatch(firstText, new RegExp(escapeRegExp(contextSecret)))
    assert.ok(responseResult(first.payload, 'file.upload')?.attachments?.some(
      (attachmentResult) => attachmentResult.name === attachmentName,
    ))
    assert.equal(first.observerResult, true, `${provider} observer must see the submitted attachment`)
    assert.equal(await pageContains(first.page, responseMarker, 2), true)
    assert.ok(Array.isArray(citations) && citations.length > 0, `${provider} must return normalized real citations`)
    assert.ok(await visibleCitationCount(first.page, citations) > 0, `${provider} observer must see a returned citation link`)
    const firstUrl = assertConversationWorkspaceResult(provider, journey.taskId, first)
    await first.close()

    const second = await journey.run([
      '--project-name', name,
      '--workspace-mode', 'conversation',
      ...(provider === 'deepseek' ? [
        '--deepseek-mode', 'Instant',
        '--deepseek-deepthink', 'off',
        '--deepseek-search', 'on',
      ] : []),
      '--prompt', 'Return a JSON object with the secret from my previous message and its exact character count.',
    ])
    const secondText = responseResult(second.payload, 'response.read')?.text ?? ''
    assert.match(secondText, new RegExp(escapeRegExp(contextSecret)))
    assert.equal(canonicalPageUrl(second.page.url()), firstUrl, `${provider} both CLI processes must share one exact conversation`)
    assertTaskConversationMapping(provider, journey.taskId, firstUrl, second.payload)
    await second.close()
  } finally {
    await fs.rm(attachment, { force: true })
    if (deepSeekState) await restoreDeepSeekState(journey, deepSeekState)
  }
}

async function deepSeekVisionInput({ provider, journey }) {
  assert.equal(provider, 'deepseek')
  const original = await captureDeepSeekState(journey)
  const image = path.join(root, 'assets', 'tokenless-mark.png')
  const marker = markerFor(provider, 'VISION_RESPONSE')
  try {
    const run = await journey.run([
      '--deepseek-mode', 'Vision',
      '--deepseek-deepthink', 'off',
      '--attach-file', image,
      '--prompt', [
        'Describe the central mark in the attached image in one short sentence.',
        `Include this exact marker: ${marker}`,
      ].join(' '),
    ], 360_000, ({ page }) => waitForExactText(page, path.basename(image), 180_000))
    assert.equal(responseResult(run.payload, 'deepseek.mode.select')?.selectedMode, 'Vision')
    assert.ok(responseResult(run.payload, 'file.upload')?.attachments?.some(
      (attachment) => attachment.name === path.basename(image),
    ))
    assert.equal(run.observerResult, true, 'DeepSeek observer must see the selected Vision image')
    assert.match(responseResult(run.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(marker)))
    await run.close()
  } finally {
    await restoreDeepSeekState(journey, original)
  }
}

async function captureDeepSeekState(journey) {
  const modeInspection = await journey.action('deepseek.mode.inspect')
  const mode = responseResult(modeInspection.payload, 'deepseek.mode.inspect')?.activeMode
  assert.ok(['Instant', 'Expert', 'Vision'].includes(mode))
  await modeInspection.close()

  const deepThinkInspection = await journey.action('deepseek.deepthink.inspect')
  const deepThink = responseResult(deepThinkInspection.payload, 'deepseek.deepthink.inspect')?.enabled
  assert.equal(typeof deepThink, 'boolean')
  await deepThinkInspection.close()

  let search = null
  if (mode === 'Instant') {
    const searchInspection = await journey.action('deepseek.search.inspect')
    search = responseResult(searchInspection.payload, 'deepseek.search.inspect')?.enabled
    assert.equal(typeof search, 'boolean')
    await searchInspection.close()
  }
  return { mode, deepThink, search }
}

async function restoreDeepSeekState(journey, state) {
  const instant = await journey.action('deepseek.mode.select', ['--deepseek-mode', 'Instant'])
  await instant.close()
  if (typeof state.search === 'boolean') {
    const search = await journey.action('deepseek.search.select', [
      '--deepseek-search', state.search ? 'on' : 'off',
    ])
    await search.close()
  }
  const mode = await journey.action('deepseek.mode.select', ['--deepseek-mode', state.mode])
  await mode.close()
  const deepThink = await journey.action('deepseek.deepthink.select', [
    '--deepseek-deepthink', state.deepThink ? 'on' : 'off',
  ])
  await deepThink.close()
}

async function workspaceResponseCitations({ provider, journey }) {
  const name = markerFor(provider, 'WORKSPACE_RESPONSE')
  const responseMarker = markerFor(provider, 'WORKSPACE_RESPONSE_MARKER')
  const run = await journey.run([
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--prompt', `Include this exact marker: ${responseMarker}. Identify the official Node.js homepage and cite that official source.`,
  ])
  const response = responseResult(run.payload, 'response.read')
  assert.match(response?.text ?? '', new RegExp(escapeRegExp(responseMarker)))
  assert.equal(await pageContains(run.page, responseMarker, 2), true)
  assert.ok(Array.isArray(response?.citations) && response.citations.length > 0, `${provider} must return normalized real citations`)
  assert.ok(await visibleCitationCount(run.page, response.citations) > 0, `${provider} observer must see a returned citation link`)
  assertConversationWorkspaceResult(provider, journey.taskId, run)
  await run.close()
}

async function workspaceResponseBaseline({ provider, journey }) {
  const name = markerFor(provider, 'WORKSPACE_RESPONSE')
  const prompt = 'What is the capital of Australia? Answer in one sentence.'
  const run = await journey.run([
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--prompt', prompt,
  ])
  const response = responseResult(run.payload, 'response.read')
  assert.match(response?.text ?? '', /Canberra/i)
  assert.equal(await pageContains(run.page, 'Canberra', 2), true)
  assertConversationWorkspaceResult(provider, journey.taskId, run)
  await run.close()
}

async function nativeProject({ provider, journey }) {
  const projectName = provider === 'kimi'
    ? `TLP_KIMI_PROJECT_${randomUUID().slice(0, 8)}`
    : markerFor(provider, 'PROJECT')
  const instructionMarker = markerFor(provider, 'PROJECT_INSTRUCTION')
  const instructions = `Fully answer each request, then append this exact marker on a new final line: ${instructionMarker}`
  const created = await journey.action('workspace.ensure', [
    '--project-name', projectName,
    '--workspace-mode', 'native',
    '--project-instructions', instructions,
  ], 240_000)
  const createdResult = responseResult(created.payload, 'workspace.ensure')
  assert.equal(createdResult?.mode, 'native')
  assert.equal(createdResult?.resource?.disposition, 'created')
  assert.equal(createdResult?.instructionOutcome, 'applied_on_creation')
  assert.equal(await exactTextVisible(created.page, projectName), true)
  const projectUrl = createdResult.resource.canonicalUrl
  await created.close()

  const reused = await journey.action('workspace.ensure', [
    '--project-name', projectName,
    '--workspace-mode', 'native',
    '--project-instructions', instructions,
  ], 240_000)
  const reusedResult = responseResult(reused.payload, 'workspace.ensure')
  assert.equal(reusedResult?.resource?.disposition, 'reused')
  assert.equal(reusedResult?.resource?.canonicalUrl, projectUrl)
  assert.equal(reusedResult?.instructionOutcome, 'skipped_on_reuse')
  await reused.close()

  const controls = []
  if (matrix.providers[provider].required.includes('model-choice')) {
    controls.push(await projectChoice(provider, journey, projectUrl, 'model'))
  }
  if (matrix.providers[provider].required.includes('effort-choice')) {
    controls.push(await projectChoice(provider, journey, projectUrl, 'effort'))
  }

  const firstMarker = markerFor(provider, 'PROJECT_TURN_ONE')
  const attachmentName = `${markerFor(provider, 'PROJECT_ATTACHMENT')}.txt`
  const attachment = path.join(root, 'test-results', 'live-provider-inputs', attachmentName)
  await fs.mkdir(path.dirname(attachment), { recursive: true, mode: 0o700 })
  await fs.writeFile(attachment, `${firstMarker}\n`, { mode: 0o600 })
  let primaryError
  try {
    const first = await journey.run([
      '--project-name', projectName,
      '--project-instructions', instructions,
      '--workspace-mode', 'native',
      '--attach-file', attachment,
      ...controls.flatMap((control) => [control.option, control.alternate]),
      '--prompt', `Read the Project file named ${attachmentName}, report the exact marker it contains, and follow the Project instructions. Return both markers.`,
    ], 360_000, ({ page }) => waitForExactText(
      page,
      provider === 'kimi' ? path.parse(attachmentName).name : attachmentName,
      180_000,
    ))
    const firstText = responseResult(first.payload, 'response.read')?.text ?? ''
    assert.match(firstText, new RegExp(escapeRegExp(firstMarker)))
    assert.match(firstText, new RegExp(escapeRegExp(instructionMarker)))
    assert.ok(responseResult(first.payload, 'file.upload')?.attachments?.some(
      (candidate) => candidate.name === attachmentName,
    ))
    assert.equal(first.observerResult, true, `${provider} observer must see the Project attachment`)
    for (const control of controls) {
      assert.equal(responseResult(first.payload, `${control.kind}.select`)?.selectedLabel, control.alternate)
    }
    const conversationUrl = canonicalPageUrl(first.page.url())
    assert.notEqual(conversationUrl, canonicalPageUrl(projectUrl))
    await first.close()

    const secondMarker = markerFor(provider, 'PROJECT_TURN_TWO')
    const second = await journey.run([
      '--project-name', projectName,
      '--workspace-mode', 'native',
      '--prompt', `Reply with both the earlier file marker and this marker: ${secondMarker}`,
    ], 360_000)
    const text = responseResult(second.payload, 'response.read')?.text ?? ''
    assert.match(text, new RegExp(escapeRegExp(firstMarker)))
    assert.match(text, new RegExp(escapeRegExp(secondMarker)))
    assert.match(text, new RegExp(escapeRegExp(instructionMarker)))
    assert.equal(canonicalPageUrl(second.page.url()), conversationUrl)

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const project = database.prepare(
        'SELECT resource_id, canonical_url FROM provider_projects WHERE provider = ? AND profile_id = ? AND name = ?',
      ).get(provider, createdResult.scope.profileId, projectName)
      assert.equal(project?.canonical_url, projectUrl)
      const conversation = database.prepare(
        `SELECT canonical_url FROM provider_conversations
         WHERE provider = ? AND profile_id = ? AND project_resource_id = ? AND task_id = ?`,
      ).get(provider, createdResult.scope.profileId, project.resource_id, journey.taskId)
      assert.equal(conversation?.canonical_url, conversationUrl)
    } finally {
      database.close()
    }
    await second.close()
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await fs.rm(attachment, { force: true })
    for (const control of controls) {
      try {
        const restored = await journey.action(`${control.kind}.select`, [
          '--target-url', projectUrl,
          control.option, control.original,
        ])
        assert.equal(responseResult(restored.payload, `${control.kind}.select`)?.selectedLabel, control.original)
        await restored.close()
      } catch (error) {
        if (primaryError === undefined) throw error
      }
    }
  }
}

async function kimiLibraryControls({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const plugins = await journey.action('kimi.plugin.inspect')
  const pluginInspection = responseResult(plugins.payload, 'kimi.plugin.inspect')
  assert.equal(pluginInspection?.supported, true)
  assert.ok(Array.isArray(pluginInspection?.choices))
  const plugin = pluginInspection.choices.find((choice) => choice.enabled)
  await plugins.close()
  if (!plugin) {
    throw e2eFailure(
      'e2e_provider_prerequisite_unavailable',
      'Kimi selected profile has no enabled Plugin; connect one explicitly before the Plugin selection gate',
    )
  }
  const selectedPlugin = await journey.action('kimi.plugin.select', ['--kimi-plugin', plugin.label])
  assert.equal(responseResult(selectedPlugin.payload, 'kimi.plugin.select')?.selectedLabel, plugin.label)
  assert.equal(await exactTextVisible(selectedPlugin.page, plugin.label), true)
  await selectedPlugin.close()
  const clearedPlugin = await journey.action('prompt.clear')
  assert.equal(await composerContains(clearedPlugin.page, plugin.label), false)
  await clearedPlugin.close()

  const skills = await journey.action('kimi.skill.inspect', ['--target-url', 'https://www.kimi.com/'])
  const skillInspection = responseResult(skills.payload, 'kimi.skill.inspect')
  assert.equal(skillInspection?.supported, true)
  const skill = skillInspection?.choices?.find((choice) => choice.enabled && !choice.selected) ??
    skillInspection?.choices?.find((choice) => choice.enabled)
  assert.ok(skill, 'Kimi must expose at least one enabled Skill in the selected profile')
  await skills.close()
  const selectedSkill = await journey.action('kimi.skill.select', [
    '--target-url', 'https://www.kimi.com/',
    '--kimi-skill', skill.label,
  ])
  assert.equal(responseResult(selectedSkill.payload, 'kimi.skill.select')?.selectedLabel, skill.label)
  assert.equal(await exactTextVisible(selectedSkill.page, `/${skill.label}`), true)
  await selectedSkill.close()
  const clearedSkill = await journey.action('prompt.clear')
  assert.equal(await composerContains(clearedSkill.page, skill.label), false)
  await clearedSkill.close()
}

async function kimiSearch({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const inspected = await journey.action('kimi.search.inspect')
  const inspection = responseResult(inspected.payload, 'kimi.search.inspect')
  assert.equal(inspection?.supported, true)
  assert.deepEqual(inspection?.choices?.map((choice) => choice.label), ['Auto', 'Off'])
  const original = inspection.choices.find((choice) => choice.selected)?.label ?? 'Auto'
  await inspected.close()
  let primaryError
  try {
    const marker = markerFor(provider, 'WEB_SEARCH')
    const run = await journey.run([
      '--capability', 'search.web',
      '--kimi-search', 'auto',
      '--prompt', `Use web search to identify the official Node.js homepage and include this exact marker: ${marker}`,
    ], 360_000)
    assert.equal(responseResult(run.payload, 'kimi.search.select')?.selectedLabel, 'Auto')
    const response = responseResult(run.payload, 'response.read')
    assert.match(response?.text ?? '', new RegExp(escapeRegExp(marker)))
    assert.ok(Array.isArray(response?.citations) && response.citations.length > 0)
    assert.ok(await visibleCitationCount(run.page, response.citations) > 0)
    await run.close()
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      const restored = await journey.action('kimi.search.select', [
        '--kimi-search', original === 'Off' ? 'off' : 'auto',
      ])
      assert.equal(responseResult(restored.payload, 'kimi.search.select')?.selectedLabel, original)
      await restored.close()
    } catch (error) {
      if (primaryError === undefined) throw error
    }
  }
}

async function kimiLibraryWorkflows({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const pluginMarker = markerFor(provider, 'PLUGIN_SOURCE')
  const plugin = await journey.run([
    '--kimi-plugin', 'SEC',
    '--prompt', `Use the SEC Plugin to identify the purpose of Form 10-K and include this exact marker: ${pluginMarker}`,
  ], 360_000)
  assert.equal(responseResult(plugin.payload, 'kimi.plugin.select')?.selectedLabel, 'SEC')
  assert.match(responseResult(plugin.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(pluginMarker)))
  await plugin.close()

  const skillMarker = markerFor(provider, 'SKILL')
  const skill = await journey.run([
    '--kimi-skill', 'humanizer',
    '--prompt', `Rewrite "We are excited to leverage innovative solutions" naturally and include this exact marker: ${skillMarker}`,
  ], 360_000)
  assert.equal(responseResult(skill.payload, 'kimi.skill.select')?.selectedLabel, 'humanizer')
  assert.match(responseResult(skill.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(skillMarker)))
  await skill.close()
}

async function kimiDeepResearch({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const marker = markerFor(provider, 'DEEP_RESEARCH')
  const run = await journey.run([
    '--target-url', 'https://www.kimi.com/deep-research',
    '--long-running',
    '--prompt', [
      'Proceed immediately without clarification.',
      'Research the current official Node.js release lines using official sources only.',
      `Include this exact marker in the final cited report: ${marker}`,
    ].join(' '),
  ], 1_080_000)
  assert.equal(new URL(run.page.url()).pathname.startsWith('/deep-research'), true)
  const response = responseResult(run.payload, 'response.read')
  assert.match(response?.text ?? '', new RegExp(escapeRegExp(marker)))
  assert.ok(Array.isArray(response?.citations) && response.citations.length > 0)
  assert.ok(await visibleCitationCount(run.page, response.citations) > 0)
  assert.equal(await visibleResearchProgress(run.page), true)
  await run.close()
}

async function kimiArtifacts({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const surfaces = [
    ['/docs', 'DOC'],
    ['/slides', 'SLIDES'],
    ['/sheets', 'SHEET'],
    ['/websites', 'WEBSITE'],
  ]
  for (const [pathname, kind] of surfaces) {
    const marker = markerFor(provider, kind)
    const run = await journey.run([
      '--target-url', `https://www.kimi.com${pathname}`,
      '--long-running',
      '--prompt', `Create a small finished artifact titled ${marker}. Include ${marker} visibly in the artifact.`,
    ], 1_080_000)
    assert.equal(new URL(run.page.url()).pathname.startsWith(pathname), true)
    assert.ok((responseResult(run.payload, 'response.read')?.text ?? '').length > 0)
    assert.equal(await visibleArtifactDownload(run.page), true, `${pathname} must expose a visible download or export control`)
    await run.close()
  }
}

async function kimiLongRunning({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const background = await journey.run([
    '--target-url', 'https://www.kimi.com/agent',
    '--long-running',
    '--prompt', `Complete a multi-step analysis and finish with ${markerFor(provider, 'BACKGROUND')}.`,
  ], 1_080_000)
  assert.match(
    responseResult(background.payload, 'response.read')?.text ?? '',
    new RegExp(escapeRegExp(markerFor(provider, 'BACKGROUND'))),
  )
  await background.close()
}

async function kimiAgentSwarm({ provider, journey }) {
  assert.equal(provider, 'kimi')
  const marker = markerFor(provider, 'AGENT_SWARM')
  const run = await journey.run([
    '--target-url', 'https://www.kimi.com/agent-swarm',
    '--long-running',
    '--prompt', `Use coordinated agents to compare the current official Node.js LTS lines and finish with ${marker}.`,
  ], 1_080_000)
  assert.equal(new URL(run.page.url()).pathname.startsWith('/agent-swarm'), true)
  assert.match(responseResult(run.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(marker)))
  assert.equal(await visibleAgentProgress(run.page), true)
  await run.close()
}

async function projectChoice(provider, journey, targetUrl, kind) {
  const inspectAction = `${kind}.inspect`
  const inspected = await journey.action(inspectAction, ['--target-url', targetUrl])
  const result = responseResult(inspected.payload, inspectAction)
  assert.equal(result?.supported, true)
  const selected = result.choices.find((choice) => choice.selected && choice.enabled)
  const alternate = result.choices.find((choice) => !choice.selected && choice.enabled)
  assert.ok(selected, `${provider} Project must expose the selected ${kind}`)
  assert.ok(alternate, `${provider} Project must expose an alternate ${kind}`)
  await inspected.close()
  return {
    kind,
    option: kind === 'model' ? '--model' : '--effort',
    original: selected.label,
    alternate: alternate.label,
  }
}

function createProviderState() {
  return {
    authenticated: false,
    skipReason: null,
    taskIds: new Set(),
    targetIds: new Set(),
    pageRefs: new Set(),
  }
}

function createCapabilityJourney(session, provider, caseId, providerState) {
  const journey = {
    session,
    provider,
    caseId,
    providerState,
    taskId: markerFor(provider, 'JOURNEY_TASK'),
    pageRef: `page:${markerFor(provider, 'JOURNEY_PAGE')}`,
    targetId: null,
    daemonPid: null,
    pageRefHash: null,
    actionDocumentTimeOrigin: null,
  }
  assert.equal(
    providerState.taskIds.has(journey.taskId),
    false,
    `${provider} capability cases must use distinct task ids`,
  )
  providerState.taskIds.add(journey.taskId)
  assert.equal(
    providerState.pageRefs.has(journey.pageRef),
    false,
    `${provider} capability cases must use distinct page refs`,
  )
  providerState.pageRefs.add(journey.pageRef)
  journey.action = (visibleAction, args = [], timeoutMs = 120_000, observeAfterRelease, observeBeforeRelease) => (
    action(journey, visibleAction, args, timeoutMs, observeAfterRelease, observeBeforeRelease)
  )
  journey.run = (args, timeoutMs = 300_000, observeAfterRelease) => (
    cliRun(journey, args, timeoutMs, observeAfterRelease)
  )
  return journey
}

async function action(
  journey,
  visibleAction,
  args = [],
  timeoutMs = 120_000,
  observeAfterRelease,
  observeBeforeRelease,
) {
  assert.equal(args.includes('--page-ref'), false, 'provider journey owns the stable page ref')
  assert.equal(args.includes('--task-id'), false, 'provider journey owns the stable task id')
  const operation = await journey.session.startCli([
    'provider-action',
    '--provider', journey.provider,
    '--task-id', journey.taskId,
    '--page-ref', journey.pageRef,
    '--action', visibleAction,
    ...args,
    '--browser-visibility', 'headed',
    '--timeout-ms', String(timeoutMs),
  ], {
    startTimeoutMs: timeoutMs,
    beforeRelease: async ({ waiting, page }) => {
      await assertJourneyPage(journey, waiting, page, true)
      await observeBeforeRelease?.({ waiting, page })
    },
    observeAfterRelease,
  })
  try {
    const result = await operation.wait()
    assertDurableSuccess(result.payload, journey.provider)
    return { ...operation, ...result }
  } catch (error) {
    await operation.close()
    throw error
  }
}

async function cliRun(journey, args, timeoutMs = 300_000, observeAfterRelease) {
  assert.equal(args.includes('--page-ref'), false, 'provider journey owns the stable page ref')
  assert.equal(args.includes('--task-id'), false, 'provider journey owns the stable task id')
  recordSubmissionAttempt(journey)
  journey.actionDocumentTimeOrigin = null
  const operation = await journey.session.startCli([
    'run',
    '--provider', journey.provider,
    '--task-id', journey.taskId,
    '--page-ref', journey.pageRef,
    ...args,
    '--browser-visibility', 'headed',
    '--timeout-ms', String(timeoutMs),
  ], {
    startTimeoutMs: timeoutMs,
    beforeRelease: async ({ waiting, page }) => {
      await assertJourneyPage(journey, waiting, page, false)
    },
    observeAfterRelease,
  })
  try {
    const result = await operation.wait()
    assertDurableSuccess(result.payload, journey.provider)
    return { ...operation, ...result }
  } catch (error) {
    await operation.close()
    throw error
  }
}

async function assertJourneyPage(journey, waiting, page, preserveActionDocument) {
  assert.equal(waiting.provider, journey.provider)
  assert.equal(canonicalPageUrl(waiting.url), canonicalPageUrl(page.url()))
  if (journey.daemonPid === null) journey.daemonPid = waiting.daemonPid
  assert.equal(waiting.daemonPid, journey.daemonPid, `${journey.provider} capability journey must stay on one daemon`)
  if (journey.pageRefHash === null) journey.pageRefHash = waiting.pageRefHash
  assert.equal(waiting.pageRefHash, journey.pageRefHash, `${journey.provider} capability journey must keep one page ref`)
  assert.equal(
    waiting.reusedPageBinding,
    journey.targetId !== null,
    `${journey.provider} capability journey must reuse its managed page binding after the first action`,
  )
  if (journey.targetId === null) {
    assert.equal(
      journey.providerState.targetIds.has(waiting.targetId),
      false,
      `${journey.provider} capability case ${journey.caseId} must use a distinct Chromium page target`,
    )
    journey.providerState.targetIds.add(waiting.targetId)
    journey.targetId = waiting.targetId
  }
  assert.equal(
    waiting.targetId,
    journey.targetId,
    `${journey.provider} capability journey must stay on one exact Chromium page target`,
  )
  if (preserveActionDocument && ['qwen', 'deepseek'].includes(journey.provider)) {
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    if (journey.actionDocumentTimeOrigin === null) journey.actionDocumentTimeOrigin = timeOrigin
    assert.equal(
      timeOrigin,
      journey.actionDocumentTimeOrigin,
      `${journey.provider} provider actions must not refresh their shared document`,
    )
  }
}

function recordSubmissionAttempt(journey) {
  const tracker = submissionTrackers.get(journey)
  assert.ok(tracker, 'live E2E submission tracker must be initialized')
  tracker.attempts += 1
  assert.ok(
    tracker.attempts <= tracker.budget,
    `${tracker.caseId} exceeded its provider submission budget of ${tracker.budget}`,
  )
}

function assertSubmissionBudget(journey) {
  const tracker = submissionTrackers.get(journey)
  assert.ok(tracker, 'live E2E submission tracker must be initialized')
  assert.equal(
    tracker.attempts,
    tracker.budget,
    `${tracker.caseId} must use exactly ${tracker.budget} provider submissions`,
  )
}

function assertDurableSuccess(payload, provider) {
  assert.equal(payload?.ok, true)
  if (payload?.status === 'waiting_for_user' || payload?.waitingForUser === true) {
    const knownIssueSkip = knownIssueSkipForDurableBlocker(matrix, provider, payload)
    if (knownIssueSkip) {
      assertDurableWaitingForUser(payload, provider, knownIssueSkip.blockerCode)
      throw e2eSkip(
        'e2e_known_issue_provider_blocker',
        `${provider} known issue ${knownIssueSkip.reason}: ${knownIssueSkip.blockerCode}`,
      )
    }
    const blockerCode = structuredBlockerCodes(payload?.blocker)[0] ?? 'provider_user_handover_required'
    throw e2eFailure(
      'e2e_provider_prerequisite_unavailable',
      `provider job requires user action: ${blockerCode}`,
    )
  }
  assert.equal(payload?.status, 'succeeded')
  const jobId = payload.jobId
  assert.equal(typeof jobId, 'string')
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const row = database.prepare(
      'SELECT status, result_json, error_json FROM jobs WHERE job_id = ?',
    ).get(jobId)
    assert.equal(row?.status, 'succeeded')
    assert.equal(typeof row?.result_json, 'string')
    assert.equal(row?.error_json, null)
  } finally {
    database.close()
  }
}

function assertDurableWaitingForUser(payload, provider, blockerCode) {
  const jobId = payload.jobId
  assert.equal(typeof jobId, 'string')
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const row = database.prepare(
      'SELECT provider, status, blocker_json, error_json FROM jobs WHERE job_id = ?',
    ).get(jobId)
    assert.equal(row?.provider, provider)
    assert.equal(row?.status, 'waiting_for_user')
    assert.equal(row?.error_json, null)
    const durableBlocker = typeof row?.blocker_json === 'string'
      ? JSON.parse(row.blocker_json)
      : null
    assert.equal(
      structuredBlockerCodes(durableBlocker).includes(blockerCode),
      true,
      `durable blocker must include ${blockerCode}`,
    )
  } finally {
    database.close()
  }
}

function responseResult(payload, actionName) {
  const responses = payload?.result?.result?.responses ??
    payload?.result?.responses ??
    payload?.latest?.result?.value?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse().find((response) => response?.ok === true && response.action === actionName)?.result ?? null
}

function imageGenerationResult(payload, provider) {
  assert.equal(payload?.tokenless?.provider, provider)
  assert.equal(payload?.tokenless?.execution_mode, 'browser')
  assert.equal(typeof payload?.tokenless?.job_id, 'string')
  assert.ok(Array.isArray(payload?.data) && payload.data.length > 0)
  assert.ok(payload.data.every((entry) => (
    typeof entry?.url === 'string' &&
    entry.url.startsWith('/v1/private/assets/') &&
    entry?.asset?.provider === provider
  )))
  return { artifacts: payload.data.map((entry) => entry.asset) }
}

function assertConversationWorkspaceResult(provider, taskId, run) {
  const result = responseResult(run.payload, 'workspace.ensure')
  assert.equal(result?.mode, 'conversation')
  assert.equal(result?.resource?.kind, 'conversation')
  assert.equal(result?.resource?.native, false)
  assert.equal(result?.resource?.disposition, 'fallback')
  const conversationUrl = canonicalPageUrl(run.page.url())
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const mapping = database.prepare(
      `SELECT canonical_url
       FROM provider_task_conversations
       WHERE provider = ? AND profile_id = ? AND task_id = ?`,
    ).get(provider, result.scope.profileId, taskId)
    assert.equal(typeof mapping?.canonical_url, 'string', `${provider} must persist the conversation Workspace mapping`)
    assert.equal(canonicalPageUrl(mapping?.canonical_url), conversationUrl)
  } finally {
    database.close()
  }
  return conversationUrl
}

function assertTaskConversationMapping(provider, taskId, expectedUrl, payload) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const job = database.prepare('SELECT profile_id FROM jobs WHERE job_id = ?').get(payload?.jobId)
    assert.equal(typeof job?.profile_id, 'string')
    const mapping = database.prepare(
      `SELECT canonical_url
       FROM provider_task_conversations
       WHERE provider = ? AND profile_id = ? AND task_id = ?`,
    ).get(provider, job.profile_id, taskId)
    assert.equal(typeof mapping?.canonical_url, 'string', `${provider} must persist the continuation mapping`)
    assert.equal(canonicalPageUrl(mapping.canonical_url), expectedUrl)
  } finally {
    database.close()
  }
}

async function composerContains(page, marker) {
  const fields = page.locator('textarea, [contenteditable="true"]')
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index)
    if (!await field.isVisible({ timeout: 100 }).catch(() => false)) continue
    const value = await field.evaluate((element) => (
      element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : element.textContent ?? ''
    ))
    if (value.includes(marker)) return true
  }
  return false
}

async function exactTextVisible(page, value) {
  const locator = page.getByText(value, { exact: true })
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible({ timeout: 100 }).catch(() => false)) return true
  }
  return false
}

async function waitForExactText(page, value, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await exactTextVisible(page, value)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function pageContains(page, value, minimumVisibleMatches = 1) {
  const matches = page.getByText(new RegExp(escapeRegExp(value)))
  let visible = 0
  for (let index = 0; index < await matches.count(); index += 1) {
    if (await matches.nth(index).isVisible({ timeout: 100 }).catch(() => false)) visible += 1
    if (visible >= minimumVisibleMatches) return true
  }
  return false
}

async function visibleCitationCount(page, citations) {
  const expected = new Set(citations.map((citation) => canonicalPageUrl(citation.href)))
  const controls = page.locator('a[href]')
  let count = 0
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index)
    const href = await control.getAttribute('href').catch(() => null)
    if (!href) continue
    const canonical = canonicalPageUrl(new URL(href, page.url()).toString())
    if (expected.has(canonical) && await control.isVisible({ timeout: 100 }).catch(() => false)) count += 1
  }
  return count
}

function assertArenaImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length > 0)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.createdAt === 'string' &&
    artifact.provider === 'arena' &&
    typeof artifact.jobId === 'string' &&
    (artifact.taskId === null || typeof artifact.taskId === 'string') &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width >= 256 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height >= 256
  )))
  return response.artifacts
}

function assertMetaImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length > 0)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.createdAt === 'string' &&
    artifact.provider === 'meta' &&
    typeof artifact.jobId === 'string' &&
    (artifact.taskId === null || typeof artifact.taskId === 'string') &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width > 0 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height > 0
  )))
  return response.artifacts
}

function assertChatGptImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length > 0)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.createdAt === 'string' &&
    artifact.provider === 'chatgpt' &&
    typeof artifact.jobId === 'string' &&
    (artifact.taskId === null || typeof artifact.taskId === 'string') &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width > 0 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height > 0
  )))
  return response.artifacts
}

function assertGeminiImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length === 1)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.createdAt === 'string' &&
    artifact.provider === 'gemini' &&
    typeof artifact.jobId === 'string' &&
    (artifact.taskId === null || typeof artifact.taskId === 'string') &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width > 0 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height > 0
  )))
  return response.artifacts
}

function assertDolaImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length > 0)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    artifact.provider === 'dola' &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width > 0 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height > 0
  )))
  return response.artifacts
}

function assertDoubaoImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length > 0)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    artifact.provider === 'doubao' &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width > 0 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height > 0
  )))
  return response.artifacts
}

function assertImageConversationIdentity(page, artifacts, provider) {
  const current = new URL(page.url())
  const expectedOrigin = provider === 'dola' ? 'https://www.dola.com' : 'https://www.doubao.com'
  assert.equal(current.origin, expectedOrigin)
  const match = current.pathname.match(/^\/chat\/([^/]+)$/u)
  assert.ok(match?.[1] && match[1] !== 'create-image', `${provider} must reach an exact image conversation URL`)
  assert.ok(artifacts.every((artifact) => artifact.conversationId === match[1]))
}

function assertGrokImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length === 2)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType === 'image/jpeg' &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.createdAt === 'string' &&
    artifact.provider === 'grok' &&
    typeof artifact.jobId === 'string' &&
    (artifact.taskId === null || typeof artifact.taskId === 'string') &&
    /^[A-Za-z0-9_-]+$/u.test(artifact.conversationId) &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width === 768 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height === 1152
  )))
  assert.equal(new Set(response.artifacts.map((artifact) => artifact.conversationId)).size, 2)
  return response.artifacts
}

function assertQwenImageArtifacts(response) {
  assert.ok(Array.isArray(response.artifacts) && response.artifacts.length > 0)
  assert.ok(response.artifacts.every((artifact) => (
    artifact?.kind === 'image' &&
    !Object.prototype.hasOwnProperty.call(artifact, 'url') &&
    typeof artifact.mediaType === 'string' &&
    artifact.mediaType.startsWith('image/') &&
    typeof artifact.assetRef === 'string' &&
    artifact.assetRef.startsWith('assets/') &&
    artifact.downloadAvailable === true &&
    Number.isSafeInteger(artifact.byteSize) &&
    artifact.byteSize > 0 &&
    /^[a-f0-9]{64}$/u.test(artifact.sha256) &&
    typeof artifact.createdAt === 'string' &&
    artifact.provider === 'qwen' &&
    typeof artifact.jobId === 'string' &&
    (artifact.taskId === null || typeof artifact.taskId === 'string') &&
    typeof artifact.conversationId === 'string' &&
    Number.isSafeInteger(artifact.width) &&
    artifact.width > 0 &&
    Number.isSafeInteger(artifact.height) &&
    artifact.height > 0
  )))
  return response.artifacts
}

async function assertArenaPersistedAssets(session, page, artifacts) {
  const daemonToken = (await fs.readFile(path.join(session.homeDir, 'daemon.token'), 'utf8')).trim()
  for (const artifact of artifacts) {
    const file = path.join(session.homeDir, artifact.assetRef)
    const bytes = await fs.readFile(file)
    assert.equal(bytes.byteLength, artifact.byteSize)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
    const assetRoute = artifact.assetRef.slice('assets/'.length)
    const response = await fetch(`${session.daemonUrl}/v1/private/assets/${assetRoute}`, {
      headers: { authorization: `Bearer ${daemonToken}` },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), artifact.mediaType)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
  }
  const traversal = await fetch(`${session.daemonUrl}/v1/private/assets/${encodeURIComponent('../tokenless.sqlite3')}/unused/unused/0.png`, {
    headers: { authorization: `Bearer ${daemonToken}` },
  })
  assert.equal(traversal.status, 400)
}

async function assertPersistedImageAssets(session, page, artifacts) {
  const daemonToken = (await fs.readFile(path.join(session.homeDir, 'daemon.token'), 'utf8')).trim()
  for (const artifact of artifacts) {
    const file = path.join(session.homeDir, artifact.assetRef)
    const bytes = await fs.readFile(file)
    assert.equal(bytes.byteLength, artifact.byteSize)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
    const assetRoute = artifact.assetRef.slice('assets/'.length)
    const response = await fetch(`${session.daemonUrl}/v1/private/assets/${assetRoute}`, {
      headers: { authorization: `Bearer ${daemonToken}` },
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), artifact.mediaType)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
  }
}

async function visibleArenaArtifactCount(page, artifacts) {
  const expected = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]))
  const assistant = currentArenaImageAssistant(page)
  assert.equal(await assistant.isVisible({ timeout: 100 }).catch(() => false), true)
  const images = assistant.locator('img').filter({ visible: true })
  let count = 0
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index)
    const source = await image.getAttribute('src').catch(() => null)
    if (!source) continue
    const response = await page.request.get(new URL(source, page.url()).toString(), {
      timeout: 60_000,
      failOnStatusCode: false,
      headers: { referer: page.url() },
    })
    assert.equal(response.ok(), true)
    const bytes = Buffer.from(await response.body())
    const artifact = expected.get(createHash('sha256').update(bytes).digest('hex'))
    if (!artifact) continue
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
    count += 1
  }
  return count
}

async function visibleMetaArtifactCount(page, artifacts) {
  const expected = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]))
  const assistant = currentMetaImageAssistant(page)
  assert.equal(await assistant.isVisible({ timeout: 100 }).catch(() => false), true)
  const images = assistant.locator('button[aria-label="View media"] img[data-testid="ur-image-tile"]').filter({ visible: true })
  let count = 0
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index)
    const source = await image.evaluate((element) => element instanceof HTMLImageElement
      ? element.currentSrc || element.src
      : '')
    if (!source) continue
    const response = await page.request.get(new URL(source, page.url()).toString(), {
      timeout: 60_000,
      failOnStatusCode: false,
      headers: { referer: page.url() },
    })
    assert.equal(response.ok(), true)
    const bytes = Buffer.from(await response.body())
    const artifact = expected.get(createHash('sha256').update(bytes).digest('hex'))
    assert.ok(artifact, 'Meta DOM image bytes must match a persisted asset digest')
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
    count += 1
  }
  return count
}

async function visibleChatGptArtifactCount(page, artifacts) {
  const expected = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]))
  const assistant = currentChatGptImageAssistant(page)
  assert.equal(await assistant.isVisible({ timeout: 100 }).catch(() => false), true)
  const images = assistant.locator('[id^="image-"] img').filter({ visible: true })
  const seen = new Set()
  let count = 0
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index)
    const source = await image.evaluate((element) => element instanceof HTMLImageElement
      ? element.currentSrc || element.src
      : '')
    if (!source) continue
    const parsed = new URL(source, page.url())
    parsed.hash = ''
    const canonical = parsed.toString()
    if (seen.has(canonical)) continue
    seen.add(canonical)
    const response = await page.request.get(canonical, {
      timeout: 60_000,
      failOnStatusCode: false,
      headers: { referer: page.url() },
    })
    assert.equal(response.ok(), true)
    const bytes = Buffer.from(await response.body())
    const artifact = expected.get(createHash('sha256').update(bytes).digest('hex'))
    assert.ok(artifact, 'ChatGPT unique DOM image bytes must match a persisted asset digest')
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
    count += 1
  }
  return count
}

async function visibleGeminiArtifactCount(page, artifacts) {
  const expected = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]))
  const images = page.locator('message-content response-element generated-image single-image img.image.animate.loaded').filter({ visible: true })
  const seen = new Set()
  let count = 0
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index)
    const source = await image.evaluate((element) => element instanceof HTMLImageElement
      ? element.currentSrc || element.src
      : '')
    if (!source.startsWith('blob:https://gemini.google.com/') || seen.has(source)) continue
    seen.add(source)
    const encoded = await image.evaluate(async (element) => {
      if (!(element instanceof HTMLImageElement)) throw new Error('Gemini image element is invalid')
      const canvas = document.createElement('canvas')
      canvas.width = element.naturalWidth
      canvas.height = element.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Gemini canvas context unavailable')
      context.drawImage(element, 0, 0)
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Gemini canvas export failed')), 'image/png')
      })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
      }
      return btoa(binary)
    })
    const bytes = Buffer.from(encoded, 'base64')
    const artifact = expected.get(createHash('sha256').update(bytes).digest('hex'))
    assert.ok(artifact, 'Gemini current-response blob bytes must match a persisted asset digest')
    assert.equal(bytes.byteLength, artifact.byteSize)
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
    count += 1
  }
  return count
}

async function visibleDolaArtifactCount(page, artifacts) {
  return await visibleProviderImageArtifactCount(
    page,
    artifacts,
    '[data-render-engine="node"]:not(.justify-end) img',
  )
}

async function visibleQwenArtifactCount(page, artifacts) {
  return await visibleProviderImageArtifactCount(
    page,
    artifacts,
    '.qwen-chat-message-assistant img.qwen-image',
  )
}

async function visibleDoubaoArtifactCount(page, artifacts) {
  return await visibleProviderImageArtifactCount(
    page,
    artifacts,
    'div[data-message-id].grid img',
  )
}

async function visibleProviderImageArtifactCount(page, artifacts, selector) {
  const expected = new Map(artifacts.map((artifact) => [artifact.sha256, artifact]))
  const images = page.locator(selector).filter({ visible: true })
  let count = 0
  for (let index = 0; index < await images.count(); index += 1) {
    const image = images.nth(index)
    const source = await image.evaluate((element) => element instanceof HTMLImageElement
      ? element.currentSrc || element.src
      : '')
    if (!source.startsWith('https://')) continue
    const response = await page.request.get(new URL(source, page.url()).toString(), {
      timeout: 60_000,
      failOnStatusCode: false,
      headers: { referer: page.url() },
    })
    assert.equal(response.ok(), true)
    const bytes = Buffer.from(await response.body())
    const artifact = expected.get(createHash('sha256').update(bytes).digest('hex'))
    assert.ok(artifact, 'provider DOM image bytes must match a persisted asset digest')
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
    count += 1
  }
  return count
}

async function assertGrokVisibleImagePosts(page, artifacts) {
  const expected = new Map(artifacts.map((artifact) => [artifact.conversationId, artifact]))
  for (const [postId, artifact] of expected) {
    await page.goto(`https://grok.com/imagine/post/${encodeURIComponent(postId)}?scope=asset`, {
      waitUntil: 'commit',
      timeout: 60_000,
    })
    await page.locator(`main img[src*="/generated/${postId}/"]`).filter({ visible: true }).first().waitFor({
      state: 'visible',
      timeout: 60_000,
    })
    await page.waitForFunction((expectedPostId) => [...document.querySelectorAll('main img')].some((element) => (
      element instanceof HTMLImageElement &&
      (element.currentSrc || element.src).includes(`/generated/${expectedPostId}/`) &&
      element.naturalWidth > 0 &&
      element.naturalHeight > 0
    )), postId, { timeout: 60_000 })
    const source = await page.locator('main img').filter({ visible: true }).evaluateAll((elements, expectedPostId) => {
      for (const element of elements) {
        if (!(element instanceof HTMLImageElement)) continue
        const candidate = element.currentSrc || element.src
        if (!candidate.startsWith('https://')) continue
        try {
          const parsed = new URL(candidate)
          if (parsed.hostname === 'assets.grok.com' && parsed.pathname.includes(`/generated/${expectedPostId}/`)) {
            return {
              url: candidate,
              width: element.naturalWidth,
              height: element.naturalHeight,
            }
          }
        } catch {
          // Ignore malformed visible images and fail closed below.
        }
      }
      return null
    }, postId)
    assert.ok(source, `Grok current post ${postId} must expose its matching main image`)
    assert.equal(source.width, artifact.width)
    assert.equal(source.height, artifact.height)
    const response = await page.request.get(source.url, {
      timeout: 60_000,
      failOnStatusCode: false,
      headers: { referer: page.url() },
    })
    assert.equal(response.ok(), true)
    assert.equal(response.headers()['content-type']?.split(';', 1)[0], artifact.mediaType)
    const bytes = Buffer.from(await response.body())
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256)
    const decoded = await decodeImageBytesInBrowser(page, bytes, artifact.mediaType)
    assert.deepEqual([decoded.width, decoded.height], [artifact.width, artifact.height])
  }
}

async function assertArenaEditSourceDistinct(page, sourceName) {
  const assistant = currentArenaImageAssistant(page)
  const providerLabels = (await assistant.locator('p.text-xs').filter({ visible: true }).allInnerTexts())
    .map((value) => value.replace(/\s+/gu, ' ').trim())
  assert.equal(providerLabels[0], 'Response provided by')
  assert.ok(providerLabels[1], 'Arena assistant output must expose its visible response provider label')

  const output = await assistant.locator('img').filter({ visible: true }).first().evaluate((image) => ({
    url: image instanceof HTMLImageElement ? image.currentSrc || image.src : '',
    width: image instanceof HTMLImageElement ? image.naturalWidth : 0,
    height: image instanceof HTMLImageElement ? image.naturalHeight : 0,
  }))
  const user = page.locator('ol.flex-col-reverse > div.mx-auto.flex.w-full.justify-end').filter({
    has: page.locator(`img[alt="${sourceName}"]`),
  }).first()
  assert.equal(await user.isVisible({ timeout: 100 }).catch(() => false), true)
  const source = await user.locator(`img[alt="${sourceName}"]`).filter({ visible: true }).first().evaluate((image) => ({
    url: image instanceof HTMLImageElement ? image.currentSrc || image.src : '',
    width: image instanceof HTMLImageElement ? image.naturalWidth : 0,
    height: image instanceof HTMLImageElement ? image.naturalHeight : 0,
  }))

  assert.notEqual(output.url, source.url)
  assert.notDeepEqual([output.width, output.height], [source.width, source.height])
}

async function decodeImageBytesInBrowser(page, bytes, mediaType) {
  const encodedBytes = Buffer.from(bytes).toString('base64')
  const decoded = await page.evaluate(async ({ encodedBytes: encoded, type }) => {
    const binary = atob(encoded)
    const decodedBytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) decodedBytes[index] = binary.charCodeAt(index)
    const blob = new Blob([decodedBytes], { type })
    const bitmap = await createImageBitmap(blob)
    const dimensions = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return dimensions
  }, { encodedBytes, type: mediaType })
  assert.ok(Number.isSafeInteger(decoded.width) && decoded.width > 0)
  assert.ok(Number.isSafeInteger(decoded.height) && decoded.height > 0)
  return decoded
}

function currentArenaImageAssistant(page) {
  return page.locator('ol.flex-col-reverse > :first-child + div').filter({
    visible: true,
    has: page.locator('p.text-tertiary').filter({ hasText: /^Response provided by$/u }),
  }).first()
}

function currentMetaImageAssistant(page) {
  return page.locator('[data-testid="assistant-message"]').filter({ visible: true }).last()
}

function currentChatGptImageAssistant(page) {
  return page.locator('section[data-turn="assistant"]').filter({ visible: true }).last()
}

async function visibleResearchProgress(page) {
  return await visibleLocatorCount(page.locator(
    '[class*="research"] [class*="plan"], [class*="research"] [class*="step"], [class*="research-progress"]',
  )) > 0
}

async function visibleArtifactDownload(page) {
  return await visibleLocatorCount(page.locator([
    'a[download]',
    'button[aria-label*="Download" i]',
    'button[aria-label*="Export" i]',
    'button:has-text("Download")',
    'button:has-text("Export")',
  ].join(', '))) > 0
}

async function visibleAgentProgress(page) {
  return await visibleLocatorCount(page.locator(
    '[class*="agent"] [class*="plan"], [class*="agent"] [class*="task"], [class*="agent"] [class*="progress"]',
  )) > 0
}

async function visibleLocatorCount(locator) {
  let visible = 0
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible({ timeout: 100 }).catch(() => false)) visible += 1
  }
  return visible
}

async function visibleGeminiAttachmentCardCount(page) {
  return await visibleLocatorCount(page.locator('.gem-attachment'))
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function requiredGate() {
  const value = requiredEnv('TOKENLESS_LIVE_E2E_GATE')
  if (!['all', 'non_submission', 'mutation', 'project'].includes(value)) {
    throw e2eFailure('e2e_gate_invalid', 'TOKENLESS_LIVE_E2E_GATE must be all, non_submission, mutation, or project')
  }
  return value
}

function optionalProviderFilter(value) {
  const provider = value?.trim()
  if (!provider) return null
  if (!Object.hasOwn(matrix.providers, provider)) {
    throw e2eFailure(
      'e2e_provider_filter_invalid',
      `TOKENLESS_LIVE_E2E_PROVIDER must name a provider declared in the live capability matrix: ${provider}`,
    )
  }
  return provider
}

function optionalCaseFilter(value) {
  const caseIds = value?.split(',').map((caseId) => caseId.trim()).filter(Boolean)
  if (!caseIds || caseIds.length === 0) return null
  for (const caseId of caseIds) {
    if (!Object.hasOwn(matrix.cases, caseId)) {
      throw e2eFailure(
        'e2e_case_filter_invalid',
        `TOKENLESS_LIVE_E2E_CASES contains a case not declared in the live capability matrix: ${caseId}`,
      )
    }
  }
  return new Set(caseIds)
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw e2eFailure(
      'e2e_activation_missing',
      `${name} is required; only declared durable provider known issues may skip`,
    )
  }
  return value
}

function markerFor(provider, kind) {
  return `TOKENLESS_E2E_${kind}_${provider}_${suiteRunMarker}_${randomUUID().slice(0, 8)}`
}

function compactTimestamp(value) {
  return value.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

function canonicalPageUrl(value) {
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function e2eFailure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function e2eSkip(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

function isKnownIssueSkip(error) {
  return error?.code === 'e2e_known_issue_provider_blocker'
}
