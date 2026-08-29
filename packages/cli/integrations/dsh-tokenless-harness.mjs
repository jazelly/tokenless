/** DeepSeek Harness one-shot subagent provider backed by Tokenless Harness. */

export const name = 'subagent-tokenless-harness'
export const inject = ['subagents', 'subprocess', 'tools']

const PROTOCOL = 'tokenless.harness.delegation.v1'
const PRE_TURN_FAILURE_MARKER = 'subagent-tokenless-harness: delegated process exited before settlement'
const CHILD_DISCOVERY_FAILURE_MARKER = 'subagent-tokenless-harness: child tool discovery failed'
const CHILD_PROVIDER_SUBMIT_FAILURE_MARKER = 'subagent-tokenless-harness: child provider submission failed'
const CHILD_HARNESS_FAILURE_MARKER = 'subagent-tokenless-harness: child harness run failed'
const SUBAGENT_FAILURE_REPORT_TIMEOUT_MS = 2000
const CHILD_HARNESS_FAILURE_PATH = '/v1/private/benchmark/child-harness-failure'
const HARNESS_CORRECTIVE_PATH = '/v1/private/benchmark/harness-corrective'
const HARNESS_CORRECTIVE_REPORT_TIMEOUT_MS = 2000
const BENCHMARK_PRESERVATION_COMMAND = 'set -e\npwd >/dev/null'

const CHILD_DISCOVERY_ERROR_CODES = new Set([
  'harness_workspace_invalid',
  'harness_tool_duplicate',
  'mcp_config_invalid',
  'mcp_server_unavailable',
  'mcp_tool_discovery_failed',
  'mcp_tool_duplicate',
  'mcp_tool_name_invalid',
])
const CHILD_PROVIDER_SUBMIT_ERROR_CODES = new Set([
  'harness_provider_intent_missing',
  'harness_provider_request_invalid',
  'harness_provider_dispatch_failed',
  'harness_provider_http_error',
  'harness_provider_identity_mismatch',
  'harness_provider_capabilities_unsupported',
  'harness_bootstrap_message_too_large',
  'harness_context_source_changed',
  'harness_attachment_stage_mismatch',
  'system_prompt_too_large',
  'invalid_input',
  'local_http_error',
  'control_auth_missing',
  'control_auth_rejected',
  'daemon_starting',
  'web_ai_request_ref_conflict',
  'web_ai_request_not_found',
])
const CHILD_HARNESS_ERROR_CODE_PATTERN = /^harness_[a-z0-9_]{1,100}$/u
const SYNTHETIC_REISSUE_REASON_CODES = new Set([
  'harness_response_framing_invalid',
  'harness_response_correlation_invalid',
  'harness_protocol_invalid',
  'harness_response_json_invalid',
  'harness_response_schema_invalid',
  'harness_action_batch_json_repair_forbidden',
  'harness_response_kind_invalid',
  'harness_skill_load_invalid',
  'harness_action_batch_empty',
  'harness_final_invalid',
  'harness_final_output_invalid',
  'harness_tool_call_invalid',
  'harness_need_invalid',
  'harness_dependency_invalid',
  'harness_dependency_cycle',
  'harness_json_schema_validation_failed',
  'harness_benchmark_evidence_insufficient',
])

export function apply(ctx, config) {
  const resolved = validateConfig(config)
  const benchmarkEndpoint = benchmarkOutcomeEndpoint()
  ctx.subagents.registerProvider({
    name: resolved.providerName,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: (request) => startRun(ctx, resolved, request, benchmarkEndpoint),
  })
  if (benchmarkEndpoint === null) return
  ctx.on('tools/post-execute', async (exec, result, next) => {
    let decision
    try {
      decision = await next()
    } catch (error) {
      if (isRootBash(exec)) await reportBashOutcome(ctx, benchmarkEndpoint, exec.callId, false, exec.signal)
      if (isRootSubagent(exec)) {
        await reportSubagentBash(
          ctx,
          benchmarkEndpoint,
          exec.callId,
          null,
          exec.signal,
          subagentFailureMetadata(error),
        )
      }
      throw error
    }
    if (isRootBash(exec)) {
      const observedResult = decision.kind === 'accept' && Object.hasOwn(decision, 'value')
        ? { ...result, value: decision.value }
        : result
      await reportBashOutcome(
        ctx,
        benchmarkEndpoint,
        exec.callId,
        decision.kind === 'accept' && successfulForegroundBash(observedResult),
        exec.signal,
      )
    }
    if (isRootSubagent(exec)) {
      const observedResult = decision.kind === 'accept' && Object.hasOwn(decision, 'value')
        ? { ...result, value: decision.value }
        : result
      const command = decision.kind === 'accept'
        ? benchmarkEndpoint !== null
          ? successfulForegroundSubagent(observedResult) ? BENCHMARK_PRESERVATION_COMMAND : null
          : delegatedBashCommand(observedResult)
        : null
      await reportSubagentBash(
        ctx,
        benchmarkEndpoint,
        exec.callId,
        command,
        exec.signal,
        command === null ? subagentFailureMetadata(observedResult, decision) : null,
      )
    }
    return decision
  })
}

async function startRun(ctx, config, request, benchmarkEndpoint) {
  const prompt = textPrompt(request.prompt)
  const cwd = request.parent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('subagent-tokenless-harness: the parent session has no workspace directory')
  }
  if (request.signal.aborted) throw new Error('subagent-tokenless-harness: request was aborted before startup')

  let terminated = false
  const benchmarkEnvironment = benchmarkChannelEnvironment()
  const authoritativeBenchmarkTask = Object.keys(benchmarkEnvironment).length > 0
    ? parentBenchmarkTaskPrompt(request)
    : null
  const delegatedPrompt = Object.keys(benchmarkEnvironment).length > 0
    ? `${prompt}\n\nAuthoritative exact benchmark task (preserve and follow this complete task; it overrides any parent delegated summary):\n${authoritativeBenchmarkTask}\n\nBenchmark integration requirement: the first action batch must contain exactly one call and no Skill loads or user-input needs. That one call must be workspace.search with query \"__tokenless_harness_workspace_probe__\" and path \".\". Do not include any other call in the first batch. This is a required read-only proof that the child Tokenless Harness executed inside the delegated workspace. An empty probe result or no existing files is normal and is never task completion. After receiving the probe result, use the authoritative exact benchmark task above as the complete specification and author the solution from scratch. Every workspace.exec call must include purpose exactly as inspect, implement, or verify: use inspect for bounded discovery, implement for creating or changing the solution, and verify only for public task-relevant end-to-end behavior, never syntax/load, existence, version, or weak smoke checks. Before any purpose=verify call or final, a successful purpose=implement call must have materially created or changed the required artifacts. A purpose=verify call is read-only and cannot substitute for implementation; if inspect shows a required artifact missing, the next call must be purpose=implement and create it before verification or finalization. Return one complete Harness final envelope using the current protocol, kind, runId, turn, and nonce values; the envelope must be valid JSON and must contain \"artifacts\": []. Its \"output\" value must be a JSON-serialized string (not an object) whose decoded value is exactly one object with the sole string field \"command\"—do not put the command object at the envelope top level. Both JSON layers must be valid, with internal quotes and control characters correctly escaped. The command must begin with \`set -e\`; use a literal single-quoted heredoc or equivalent literal-safe construction for embedded source/config; never add backslashes solely for surrounding JSON or shell quoting; every escape must be valid in the target language, and ordinary punctuation such as \`%\` must not be escaped unless that target language requires it; run a target-language syntax/load check before functional verification. The command must be compact (<=10000 characters), self-contained, materially create or configure every required artifact, conditionally install missing dependencies in the same command, and run every publicly visible task-provided test plus the strongest public task-relevant end-to-end behavior before returning final. The official benchmark verifier runs in a separate post-agent phase and is unavailable during this run; never access, mount, infer, or leak hidden verifier contents. If an observed public check fails, use its actual output to repair and rerun it. Syntax/load checks, existence checks, command exit 0, and weak smoke checks do not substitute for the required public checks. The parent executes this command verbatim. A prose-only, echo/printf-only, inspection-only, version-only, or dependency-install-only response is invalid. Do not return Markdown fences, analysis, or another action batch.`
    : prompt
  const benchmarkExecutionInstruction = Object.keys(benchmarkEnvironment).length > 0
    ? '\n\nBenchmark execution extension: after the required search probe, use the opt-in workspace.exec tool for the actual work. Every workspace.exec call must include purpose exactly as inspect, implement, or verify: use inspect for bounded discovery, implement for creating or changing the solution, and verify only for public task-relevant end-to-end behavior (not syntax/load, existence, version, or weak smoke checks). Run multiple bounded foreground commands as needed to create files, run public tests or the strongest public task-relevant end-to-end checks, inspect their results, and repair observed failures before finalizing; choose a bounded timeout for long-running commands and wait for the result. Before any purpose=verify call or final, a successful purpose=implement call must have materially created or changed the required artifacts. A purpose=verify call is read-only and cannot substitute for implementation; if inspect shows a required artifact missing, the next call must be purpose=implement and create it before verification or finalization. The child execution steps, not the final parent command, are responsible for creating the required artifacts. The official benchmark verifier runs in a separate post-agent phase and is unavailable during this run; never access, mount, infer, or leak hidden verifier contents. Before finalizing, run every publicly visible task-provided test plus the strongest public task-relevant end-to-end behavior; if an observed public check fails, use its actual output to repair and rerun it. Syntax/load checks, existence checks, command exit 0, and weak smoke checks do not substitute for those public checks. This supersedes any earlier wording that required the final command to recreate every artifact: the final command must begin with `set -e`, recheck required artifacts and observable behavior, and may repair them, but it must not be only test -f/no-op, echo/printf, inspection, version, or dependency installation. The parent still executes the final command verbatim.\n'
    : ''
  const benchmarkVerificationContract = Object.keys(benchmarkEnvironment).length > 0
    ? '\n\nBenchmark verification contract: every workspace.exec call with purpose verify must itself exercise the publicly stated behavior and assert every publicly stated observable outcome. Wait for asynchronous outputs with a bounded timeout, check generated artifacts, frames, and files for creation plus relevant public validity or content, and exit nonzero when any required outcome is missing or invalid. Merely launching a program, receiving exit 0, running syntax or load checks, checking isolated existence or versions, echoing output, or performing a weak smoke check is not verification.\n'
    : ''
  const benchmarkVersionControlInstruction = Object.keys(benchmarkEnvironment).length > 0
    ? '\n\nFor version-control recovery or merge tasks, identify the recovered revision, confirm the target branch integrates it, enumerate every path changed by that revision, and inspect the actual final post-conflict contents against the recovery goal; a reachable commit, clean status, or merge exit 0 alone is insufficient.\n'
    : ''
  const benchmarkFinalStateInstruction = Object.keys(benchmarkEnvironment).length > 0
    ? '\n\nAfter successful purpose=implement and purpose=verify calls, preserve their verified state and have the final command rerun the strongest public verification. Repair only a concrete failure reported by that check; do not rewrite verified artifacts merely to make the command self-contained.\n'
    : ''
  const benchmarkParentPreservationInstruction = Object.keys(benchmarkEnvironment).length > 0
    ? '\n\nAuthoritative parent preservation contract: the child workspace.exec calls are solely responsible for implementation and public verification. After the child succeeds, the parent receives a fixed read-only preservation command; it is not a model-generated final command and must not recreate, rewrite, or repair the workspace. If child execution does not complete successfully, do not claim completion. This supersedes any earlier wording that says the parent executes a model final command or that the final command may repair artifacts.\n'
    : ''
  const child = ctx.subprocess.spawn({
    argv: [
      config.nodeExecutable,
      config.cliScript,
      'agent', 'delegate',
      '--home', config.tokenlessHome,
      '--provider', config.provider,
      '--profile', config.profile,
      '--workspace-root', cwd,
      '--prompt-stdin',
      '--adapter-stream',
      '--json',
      '--timeout-ms', String(config.timeoutMs),
    ],
    cwd,
    stdio: { stdin: { data: `${delegatedPrompt}${benchmarkExecutionInstruction}${benchmarkVerificationContract}${benchmarkVersionControlInstruction}${benchmarkFinalStateInstruction}${benchmarkParentPreservationInstruction}` }, stdout: 'pipe', stderr: 'inherit' },
    graceMs: config.disposeGraceMs,
    signal: request.signal,
    env: benchmarkEnvironment,
  })
  if (!child.stdout) throw new Error('subagent-tokenless-harness: delegated process has no stdout pipe')

  const started = deferred()
  const settled = deferred()
  let published = false
  let settledPublished = false
  let stdout = ''
  let diagnosticTail = ''
  const workspaceReports = new Set()
  let workspaceObservationFailed = false
  const consumeLine = (line) => {
    if (line.trim() === '') return
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event?.protocol !== PROTOCOL) return
    if (event.type === 'harness.corrective') {
      if (benchmarkEndpoint === null) return
      const report = reportHarnessCorrective(benchmarkEndpoint, event)
        .catch(() => {
          workspaceObservationFailed = true
          child.terminate()
        })
      workspaceReports.add(report)
      void report.finally(() => workspaceReports.delete(report))
      return
    }
    if (event.type === 'workspace.exec') {
      const report = reportWorkspaceExec(benchmarkEndpoint, event)
        .catch(() => {
          workspaceObservationFailed = true
          child.terminate()
        })
      workspaceReports.add(report)
      void report.finally(() => workspaceReports.delete(report))
      return
    }
    if (event.type === 'started' && typeof event.runId === 'string') {
      published = true
      started.resolve(event.runId)
    }
    if (event.type === 'settled' && event.run && typeof event.run === 'object') {
      settledPublished = true
      void (async () => {
        await Promise.all([...workspaceReports])
        if (workspaceObservationFailed) {
          settled.reject(new Error('subagent-tokenless-harness: workspace execution observation failed'))
          return
        }
        const detail = publicRunFailure(event.run)
        if (detail) process.stderr.write(`subagent-tokenless-harness: ${detail}\n`)
        const aborted = request.signal.aborted || terminated
        if (!aborted && event.run.status === 'failed') {
          const failure = childSettledFailure(event.run)
          try {
            await reportChildHarnessFailure(benchmarkEndpoint, failure)
            settled.reject(new Error(childFailureMarker(failure.reason, failure.failureCode)))
          } catch (error) {
            settled.reject(error)
          }
        } else {
          settled.resolve(resultFromView(event.run, aborted))
        }
      })()
    }
  }
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    diagnosticTail = `${diagnosticTail}${text}`.slice(-8192)
    stdout += text
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline < 0) break
      consumeLine(stdout.slice(0, newline))
      stdout = stdout.slice(newline + 1)
    }
  })

  const onAbort = () => child.terminate()
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) child.terminate()
  child.done.then(async (outcome) => {
    consumeLine(stdout)
    if (settledPublished) return
    const detail = publicCliFailure(diagnosticTail)
    const message = `${PRE_TURN_FAILURE_MARKER} (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${detail}`
    if (!published) {
      process.stderr.write(`${message}\n`)
      started.reject(new Error(message))
      settled.resolve({ output: [], stopReason: request.signal.aborted || terminated ? 'aborted' : 'error' })
    } else if (!settledPublished && !request.signal.aborted && !terminated) {
      try {
        await reportChildHarnessFailure(benchmarkEndpoint, { reason: 'child_pre_turn_exit', failureCode: null })
        settled.reject(new Error(PRE_TURN_FAILURE_MARKER))
      } catch (error) {
        settled.reject(error)
      }
    } else {
      settled.resolve({ output: [], stopReason: request.signal.aborted || terminated ? 'aborted' : 'error' })
    }
  }, async (error) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (!published) started.reject(failure)
    if (published && !settledPublished && !request.signal.aborted && !terminated) {
      try {
        await reportChildHarnessFailure(benchmarkEndpoint, { reason: 'child_pre_turn_exit', failureCode: null })
        settled.reject(new Error(PRE_TURN_FAILURE_MARKER))
      } catch (reportError) {
        settled.reject(reportError)
      }
    } else {
      settled.resolve({ output: [], stopReason: request.signal.aborted || terminated ? 'aborted' : 'error' })
    }
  })

  let runId
  try {
    runId = await started.promise
  } catch (error) {
    request.signal.removeEventListener('abort', onAbort)
    child.terminate()
    await child.waitForExit()
    throw error
  }

  let disposal
  return {
    id: runId,
    localAgent: undefined,
    result: settled.promise.finally(() => request.signal.removeEventListener('abort', onAbort)),
    dispose() {
      if (disposal) return disposal
      terminated = true
      request.signal.removeEventListener('abort', onAbort)
      child.terminate()
      disposal = child.waitForExit().then(() => undefined)
      return disposal
    },
  }
}

function publicCliFailure(value) {
  let parsed
  try { parsed = JSON.parse(value.trim()) } catch { return '' }
  const error = parsed?.error
  if (!error || typeof error !== 'object') return ''
  const code = typeof error.code === 'string' ? error.code.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 120) : ''
  const message = typeof error.message === 'string' ? error.message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 300) : ''
  if (!code && !message) return ''
  return `: ${[code, message].filter(Boolean).join(': ')}`
}

function publicRunFailure(view) {
  if (view.status === 'succeeded') return ''
  const code = typeof view.error?.code === 'string'
    ? view.error.code.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 120)
    : ''
  const message = typeof view.error?.message === 'string'
    ? view.error.message.replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 300)
    : ''
  return `delegated run settled as ${String(view.status).slice(0, 40)}${code || message ? `: ${[code, message].filter(Boolean).join(': ')}` : ''}`
}

function benchmarkChannelEnvironment() {
  const baseUrl = process.env.TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL
  const token = process.env.TOKENLESS_BENCHMARK_CHANNEL_TOKEN
  const taskType = process.env.TOKENLESS_BENCHMARK_TASK_TYPE
  const complexity = process.env.TOKENLESS_BENCHMARK_COMPLEXITY
  if (typeof baseUrl !== 'string' || typeof token !== 'string') return {}
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)
    || typeof taskType !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(taskType)
    || typeof complexity !== 'string' || !['low', 'medium', 'high'].includes(complexity)) {
    throw new Error('subagent-tokenless-harness: benchmark channel environment is invalid')
  }
  return {
    TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL: baseUrl,
    TOKENLESS_BENCHMARK_CHANNEL_TOKEN: token,
    TOKENLESS_BENCHMARK_TASK_TYPE: taskType,
    TOKENLESS_BENCHMARK_COMPLEXITY: complexity,
  }
}

function benchmarkOutcomeEndpoint() {
  const environment = benchmarkChannelEnvironment()
  if (Object.keys(environment).length === 0) return null
  return {
    baseUrl: environment.TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL,
    token: environment.TOKENLESS_BENCHMARK_CHANNEL_TOKEN,
  }
}

function isRootBash(exec) {
  return exec?.name === 'bash' && exec?.parent === undefined && typeof exec?.callId === 'string'
}

function isRootSubagent(exec) {
  return exec?.name === 'subagent' && exec?.parent === undefined && typeof exec?.callId === 'string'
}

function successfulForegroundBash(result) {
  if (!result || result.isError !== false) return false
  const value = result.value
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'foreground'
    || value.exitCode !== 0
    || value.signal !== null
    || value.timedOut !== false
    || value.aborted !== false) return false
  if (value.sandbox === undefined) return true
  return value.sandbox !== null
    && typeof value.sandbox === 'object'
    && !Array.isArray(value.sandbox)
    && value.sandbox.denied === false
    && value.sandbox.runnerFailed !== true
}

function successfulForegroundSubagent(result) {
  if (!result || result.isError !== false) return false
  const value = result.value
  const block = value?.output?.length === 1 ? value.output[0] : null
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.kind === 'foreground'
    && typeof value.runId === 'string' && value.runId.length > 0
    && Array.isArray(value.output)
    && block !== null && typeof block === 'object' && !Array.isArray(block)
    && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0
}

async function reportBashOutcome(ctx, endpoint, callId, success, signal) {
  try {
    const response = await fetch(`${endpoint.baseUrl}/v1/private/benchmark/bash-outcome`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ callId, success }),
      signal,
    })
    if (response.status !== 204) {
      ctx.logger.warn(`subagent-tokenless-harness: bash outcome endpoint returned HTTP ${response.status}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`subagent-tokenless-harness: bash outcome report failed: ${detail.slice(0, 160)}`)
  }
}

async function reportSubagentBash(ctx, endpoint, callId, command, signal, failure = null) {
  const failureMetadata = failure ?? { reason: 'child_spawn_failed', failureCode: null }
  const requiredFailureReport = command === null
  const payload = command === null
    ? {
        callId,
        failed: true,
        reason: failureMetadata.reason,
        failureCode: failureMetadata.failureCode,
      }
    : { callId, command }
  const reportController = requiredFailureReport ? new AbortController() : null
  const reportTimeout = reportController === null
    ? null
    : setTimeout(() => reportController.abort(), SUBAGENT_FAILURE_REPORT_TIMEOUT_MS)
  try {
    const response = await fetch(`${endpoint.baseUrl}/v1/private/benchmark/subagent-bash`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: reportController?.signal ?? signal,
    })
    if (response.status !== 204) {
      const detail = `subagent-tokenless-harness: subagent bash endpoint returned HTTP ${response.status}`
      if (requiredFailureReport) throw new Error(detail)
      ctx.logger.warn(detail)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (requiredFailureReport) {
      throw new Error(`subagent-tokenless-harness: required subagent failure report failed: ${detail.slice(0, 160)}`)
    }
    ctx.logger.warn(`subagent-tokenless-harness: subagent bash report failed: ${detail.slice(0, 160)}`)
  } finally {
    if (reportTimeout !== null) clearTimeout(reportTimeout)
  }
}

async function reportChildHarnessFailure(endpoint, failure) {
  if (endpoint === null) return
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SUBAGENT_FAILURE_REPORT_TIMEOUT_MS)
  try {
    const response = await fetch(`${endpoint.baseUrl}${CHILD_HARNESS_FAILURE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: failure.reason, failureCode: failure.failureCode }),
      signal: controller.signal,
    })
    if (response.status !== 204) {
      throw new Error(`child Harness failure endpoint returned HTTP ${response.status}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`subagent-tokenless-harness: required child failure report failed: ${detail.slice(0, 160)}`)
  } finally {
    clearTimeout(timeout)
  }
}

async function reportWorkspaceExec(endpoint, event) {
  const fields = [
    'callIdSha256', 'purpose', 'commandCharacters', 'commandSha256', 'timeoutMs',
    'outcome', 'exitCode', 'signal', 'timedOut',
  ]
  if (event.type !== 'workspace.exec'
    || Object.keys(event).some((key) => !['protocol', 'type', ...fields].includes(key))
    || event.callIdSha256 !== null && (typeof event.callIdSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(event.callIdSha256))
    || !['inspect', 'implement', 'verify'].includes(event.purpose)
    || !Number.isSafeInteger(event.commandCharacters) || event.commandCharacters < 1 || event.commandCharacters > 32768
    || typeof event.commandSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(event.commandSha256)
    || !Number.isSafeInteger(event.timeoutMs) || event.timeoutMs < 1000 || event.timeoutMs > 120000
    || !['succeeded', 'failed'].includes(event.outcome)
    || event.exitCode !== null && (!Number.isSafeInteger(event.exitCode) || event.exitCode < -1 || event.exitCode > 255)
    || event.signal !== null && (typeof event.signal !== 'string' || !/^[A-Z][A-Z0-9_]{0,15}$/u.test(event.signal))
    || (event.timedOut !== null && typeof event.timedOut !== 'boolean')) {
    throw new Error('subagent-tokenless-harness: workspace execution observation is invalid')
  }
  const response = await fetch(`${endpoint.baseUrl}/v1/private/benchmark/workspace-exec`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.fromEntries(fields.map((field) => [field, event[field]]))),
  })
  if (response.status !== 204) throw new Error('subagent-tokenless-harness: workspace execution observation was rejected')
}

async function reportHarnessCorrective(endpoint, event) {
  if (event.protocol !== PROTOCOL
    || event.type !== 'harness.corrective'
    || Object.keys(event).some((key) => !['protocol', 'type', 'turn', 'reasonCode'].includes(key))
    || !Number.isSafeInteger(event.turn) || event.turn < 1 || event.turn > 64
    || typeof event.reasonCode !== 'string' || !SYNTHETIC_REISSUE_REASON_CODES.has(event.reasonCode)) {
    throw new Error('subagent-tokenless-harness: Harness corrective observation is invalid')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HARNESS_CORRECTIVE_REPORT_TIMEOUT_MS)
  try {
    const response = await fetch(`${endpoint.baseUrl}${HARNESS_CORRECTIVE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ turn: event.turn, reasonCode: event.reasonCode }),
      signal: controller.signal,
    })
    if (response.status !== 204) throw new Error('subagent-tokenless-harness: Harness corrective observation was rejected')
  } finally {
    clearTimeout(timeout)
  }
}

function subagentFailureMetadata(...values) {
  for (const value of values) {
    const message = value instanceof Error
      ? value.message
      : value && typeof value === 'object'
        ? typeof value.error?.message === 'string'
          ? value.error.message
          : typeof value.message === 'string' ? value.message : null
        : null
    if (message === 'subagent-tokenless-harness: benchmark parent session events are unavailable') {
      return { reason: 'parent_events_missing', failureCode: null }
    }
    if (message?.startsWith('subagent-tokenless-harness: expected exactly one benchmark user task event, found ')
      || message === 'subagent-tokenless-harness: benchmark user task must contain only nonempty text blocks'
      || message === 'subagent-tokenless-harness: the task must not be empty') {
      return { reason: 'parent_user_task_invalid', failureCode: null }
    }
    if (message?.startsWith('subagent-tokenless-harness: delegated process exited before settlement')) {
      return { reason: 'child_pre_turn_exit', failureCode: null }
    }
    const marker = parseChildFailureMarker(message)
    if (marker) return marker
  }
  return { reason: 'child_spawn_failed', failureCode: null }
}

function childSettledFailure(view) {
  const code = view?.error?.code
  if (typeof code === 'string' && CHILD_DISCOVERY_ERROR_CODES.has(code)) {
    return { reason: 'child_discovery_failed', failureCode: code }
  }
  if (typeof code === 'string' && CHILD_PROVIDER_SUBMIT_ERROR_CODES.has(code)) {
    return { reason: 'child_provider_submit_failed', failureCode: code }
  }
  return {
    reason: 'child_harness_failed',
    failureCode: isChildHarnessErrorCode(code) ? code : null,
  }
}

function isChildHarnessErrorCode(value) {
  return typeof value === 'string' && CHILD_HARNESS_ERROR_CODE_PATTERN.test(value)
}

function childFailureMarker(reason, failureCode) {
  const prefix = reason === 'child_discovery_failed'
    ? CHILD_DISCOVERY_FAILURE_MARKER
    : reason === 'child_provider_submit_failed'
      ? CHILD_PROVIDER_SUBMIT_FAILURE_MARKER
      : CHILD_HARNESS_FAILURE_MARKER
  return failureCode === null ? prefix : `${prefix} [code=${failureCode}]`
}

function parseChildFailureMarker(message) {
  if (typeof message !== 'string') return null
  const markers = [
    ['child_discovery_failed', CHILD_DISCOVERY_FAILURE_MARKER, CHILD_DISCOVERY_ERROR_CODES],
    ['child_provider_submit_failed', CHILD_PROVIDER_SUBMIT_FAILURE_MARKER, CHILD_PROVIDER_SUBMIT_ERROR_CODES],
    ['child_harness_failed', CHILD_HARNESS_FAILURE_MARKER, null],
  ]
  for (const [reason, prefix, codes] of markers) {
    if (message === prefix) return { reason, failureCode: null }
    const codePrefix = `${prefix} [code=`
    if (!message.startsWith(codePrefix) || !message.endsWith(']')) continue
    const failureCode = message.slice(codePrefix.length, -1)
    if (reason === 'child_harness_failed'
      ? isChildHarnessErrorCode(failureCode)
      : codes.has(failureCode)) {
      return { reason, failureCode }
    }
  }
  return null
}

function delegatedBashCommand(result) {
  if (!result || result.isError !== false) return null
  const value = result.value
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.kind !== 'foreground' || !Array.isArray(value.output) || value.output.length !== 1) return null
  const block = value.output[0]
  if (!block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text' || typeof block.text !== 'string') {
    return null
  }
  let parsed
  try { parsed = JSON.parse(block.text) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'command')) return null
  const command = parsed.command
  if (typeof command !== 'string' || command.trim() === '' || command.length > 10000) return null
  const trimmed = command.trim()
  if (/^(?:echo|printf)(?:\s|$)/u.test(trimmed) && !/[\r\n>|;&]|\$\(|`/u.test(trimmed)) return null
  return command
}

function resultFromView(view, aborted) {
  const output = typeof view.final?.output === 'string' && view.final.output.length > 0
    ? [{ type: 'text', text: view.final.output }]
    : []
  if (view.status === 'succeeded') return { output, stopReason: 'completed' }
  if (view.status === 'cancelled' || aborted) return { output, stopReason: 'aborted' }
  return { output, stopReason: 'error' }
}

function parentBenchmarkTaskPrompt(request) {
  const events = request.parent?.session?.events
  if (!Array.isArray(events)) {
    throw new Error('subagent-tokenless-harness: benchmark parent session events are unavailable')
  }
  const userTasks = events.filter((event) => event?.type === 'user/message' && event.data?.source?.kind === 'user')
  if (userTasks.length !== 1) {
    throw new Error(`subagent-tokenless-harness: expected exactly one benchmark user task event, found ${userTasks.length}`)
  }
  const content = userTasks[0].data?.content
  if (!Array.isArray(content) || content.length === 0
    || content.some((block) => block?.type !== 'text' || typeof block.text !== 'string')) {
    throw new Error('subagent-tokenless-harness: benchmark user task must contain only nonempty text blocks')
  }
  return textPrompt(content)
}

function textPrompt(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.some((block) => block?.type !== 'text')) {
    throw new Error('subagent-tokenless-harness: the task must contain only text blocks')
  }
  const prompt = blocks.map((block) => block.text).join('\n\n')
  if (prompt.trim() === '') throw new Error('subagent-tokenless-harness: the task must not be empty')
  return prompt
}

function validateConfig(value) {
  if (!value || typeof value !== 'object') throw new Error('subagent-tokenless-harness: config is required')
  for (const key of ['providerName', 'nodeExecutable', 'cliScript', 'tokenlessHome', 'provider', 'profile']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`subagent-tokenless-harness: ${key} must be a nonempty string`)
    }
  }
  return {
    ...value,
    timeoutMs: positiveInteger(value.timeoutMs, 'timeoutMs'),
    disposeGraceMs: positiveInteger(value.disposeGraceMs, 'disposeGraceMs'),
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`subagent-tokenless-harness: ${label} must be a positive integer`)
  }
  return value
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
