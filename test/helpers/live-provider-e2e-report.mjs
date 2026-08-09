import fs from 'node:fs/promises'
import path from 'node:path'

export const LIVE_PROVIDER_E2E_REPORT_SCHEMA = 'tokenless.live-provider-e2e-report.v2'

export function createLiveProviderE2eReport({
  runId,
  startedAt,
  gate,
  profileSlug,
  matrix,
  selectedProviders,
}) {
  return {
    schema: LIVE_PROVIDER_E2E_REPORT_SCHEMA,
    runId,
    startedAt,
    completedAt: null,
    gate,
    profile: profileSlug,
    summary: null,
    providers: selectedProviders.map(({ provider, declaration, caseIds }) => {
      const selectedCases = new Set(caseIds)
      return {
        provider,
        stage: declaration.stage,
        account: declaration.account,
        status: 'pending',
        readiness: {
          status: selectedCases.has('session-readiness') ? 'pending' : 'not_selected',
          classification: selectedCases.has('session-readiness') ? 'pending' : 'gate_not_selected',
          code: null,
        },
        capabilities: Object.entries(matrix.cases).map(([caseId, definition]) => {
          const unavailableReason = declaration.unavailable[caseId]
          const selected = selectedCases.has(caseId)
          return {
            capability: caseId,
            gate: definition.gate,
            actions: definition.actions,
            closure: definition.closure,
            submissions: definition.submissions,
            availability: unavailableReason === undefined ? 'required' : 'unavailable',
            unavailableReason: unavailableReason ?? null,
            selected,
            status: unavailableReason !== undefined
              ? 'unavailable'
              : selected ? 'pending' : 'not_selected',
            classification: unavailableReason !== undefined
              ? unavailableReason
              : selected ? 'pending' : 'gate_not_selected',
            code: null,
            durationMs: null,
          }
        }),
      }
    }),
  }
}

export function recordLiveProviderCapability(report, {
  provider,
  capability,
  status,
  error,
  durationMs,
}) {
  const providerReport = requiredProviderReport(report, provider)
  const capabilityReport = providerReport.capabilities.find((candidate) => candidate.capability === capability)
  if (!capabilityReport || capabilityReport.selected !== true) {
    throw new Error(`Live provider E2E report cannot record unselected capability ${provider}.${capability}.`)
  }
  const failure = status === 'passed'
    ? { classification: 'capability_verified', code: null }
    : classifyLiveProviderE2eFailure(error)
  capabilityReport.status = status
  capabilityReport.classification = failure.classification
  capabilityReport.code = failure.code
  capabilityReport.durationMs = Math.max(0, Math.round(durationMs))

  if (capability === 'session-readiness') {
    providerReport.readiness = {
      status,
      classification: status === 'passed' ? 'ready' : failure.classification,
      code: failure.code,
    }
  }
}

export function finalizeLiveProviderE2eReport(report, completedAt) {
  report.completedAt = completedAt
  for (const provider of report.providers) {
    for (const capability of provider.capabilities) {
      if (capability.status !== 'pending') continue
      capability.status = 'not_run'
      capability.classification = 'suite_incomplete'
    }
    if (provider.readiness.status === 'pending') {
      provider.readiness = {
        status: 'not_run',
        classification: 'suite_incomplete',
        code: null,
      }
    }
    const selected = provider.capabilities.filter((capability) => capability.selected)
    provider.status = selected.some((capability) => capability.status === 'failed')
      ? 'failed'
      : selected.some((capability) => capability.status === 'not_run')
        ? 'incomplete'
        : selected.some((capability) => capability.status === 'known_issue')
          ? 'known_issue'
          : selected.length > 0 && selected.every((capability) => capability.status === 'passed')
            ? 'passed'
            : 'incomplete'
  }
  report.summary = summarize(report)
  return report
}

export async function writeLiveProviderE2eReport(report, outputRoot) {
  const directory = path.join(outputRoot, 'live-provider-e2e')
  const filename = `${report.runId}-${report.gate}.json`
  const target = path.join(directory, filename)
  const temporary = `${target}.${process.pid}.tmp`
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}

export function formatLiveProviderE2eReport(report, reportPath) {
  const lines = [`Live provider E2E report: ${reportPath}`]
  for (const provider of report.providers) {
    const selected = provider.capabilities.filter((capability) => capability.selected)
    const passed = selected.filter((capability) => capability.status === 'passed').length
    const failed = selected.filter((capability) => capability.status === 'failed').length
    const knownIssues = selected.filter((capability) => capability.status === 'known_issue').length
    const incomplete = selected.filter((capability) => capability.status === 'not_run').length
    lines.push(
      `  ${provider.provider}: ${provider.status}; readiness=${provider.readiness.classification}; ` +
      `capabilities=${passed} passed, ${failed} failed, ${knownIssues} known issue, ${incomplete} not run`,
    )
    for (const capability of selected.filter((candidate) => candidate.status !== 'passed')) {
      lines.push(
        `    ${capability.capability}: ${capability.status} (${capability.classification}` +
        `${capability.code ? `, ${capability.code}` : ''})`,
      )
    }
  }
  return lines.join('\n')
}

export function classifyLiveProviderE2eFailure(error) {
  const code = errorCode(error)
  const message = errorMessages(error).join('\n')
  if (code === 'e2e_known_issue_provider_blocker') {
    return { classification: 'known_provider_issue', code }
  }
  if (code === 'e2e_provider_auth_unavailable') {
    return { classification: 'authentication_unavailable', code }
  }
  if (code === 'e2e_provider_prerequisite_unavailable') {
    return { classification: 'provider_blocker', code }
  }
  if (
    /ERR_(?:NAME_NOT_RESOLVED|CONNECTION|NETWORK|TIMED_OUT)|net::|navigation|page URL|provider page|DevToolsActivePort/iu.test(message)
  ) {
    return { classification: 'network_or_navigation', code }
  }
  if (code?.startsWith('e2e_') || /browser observer barrier|E2E inspection session/iu.test(message)) {
    return { classification: 'harness', code }
  }
  if (errorNames(error).includes('AssertionError')) {
    return { classification: 'capability_assertion', code: code ?? 'assertion_failed' }
  }
  return { classification: 'unclassified_failure', code }
}

function summarize(report) {
  const providerStatuses = countBy(report.providers, (provider) => provider.status)
  const selectedCapabilities = report.providers.flatMap((provider) => (
    provider.capabilities.filter((capability) => capability.selected)
  ))
  return {
    providers: {
      total: report.providers.length,
      passed: providerStatuses.passed ?? 0,
      failed: providerStatuses.failed ?? 0,
      knownIssue: providerStatuses.known_issue ?? 0,
      incomplete: providerStatuses.incomplete ?? 0,
    },
    capabilities: {
      selected: selectedCapabilities.length,
      passed: selectedCapabilities.filter((capability) => capability.status === 'passed').length,
      failed: selectedCapabilities.filter((capability) => capability.status === 'failed').length,
      knownIssue: selectedCapabilities.filter((capability) => capability.status === 'known_issue').length,
      notRun: selectedCapabilities.filter((capability) => capability.status === 'not_run').length,
    },
  }
}

function requiredProviderReport(report, provider) {
  const providerReport = report.providers.find((candidate) => candidate.provider === provider)
  if (!providerReport) throw new Error(`Live provider E2E report does not include provider ${provider}.`)
  return providerReport
}

function errorCode(error) {
  for (const candidate of errorChain(error)) {
    if (typeof candidate?.code === 'string' && candidate.code) return candidate.code
  }
  return null
}

function errorMessages(error) {
  return errorChain(error)
    .map((candidate) => candidate instanceof Error ? candidate.message : String(candidate ?? ''))
    .filter(Boolean)
}

function errorNames(error) {
  return errorChain(error)
    .map((candidate) => candidate instanceof Error ? candidate.name : '')
    .filter(Boolean)
}

function errorChain(error) {
  const chain = []
  let current = error
  while (current !== undefined && current !== null && chain.length < 8) {
    chain.push(current)
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

function countBy(values, keyForValue) {
  const counts = {}
  for (const value of values) {
    const key = keyForValue(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
