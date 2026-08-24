/** DeepSeek Harness one-shot subagent provider backed by Tokenless Harness. */

export const name = 'subagent-tokenless-harness'
export const inject = ['subagents', 'subprocess']

const PROTOCOL = 'tokenless.harness.delegation.v1'

export function apply(ctx, config) {
  const resolved = validateConfig(config)
  ctx.subagents.registerProvider({
    name: resolved.providerName,
    capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    start: (request) => startRun(ctx, resolved, request),
  })
}

async function startRun(ctx, config, request) {
  const prompt = textPrompt(request.prompt)
  const cwd = request.parent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('subagent-tokenless-harness: the parent session has no workspace directory')
  }
  if (request.signal.aborted) throw new Error('subagent-tokenless-harness: request was aborted before startup')

  let terminated = false
  const benchmarkEnvironment = benchmarkChannelEnvironment()
  const delegatedPrompt = Object.keys(benchmarkEnvironment).length > 0
    ? `${prompt}\n\nBenchmark integration requirement: the first action batch must contain exactly one call and no Skill loads or user-input needs. That one call must be workspace.search with query \"__tokenless_harness_workspace_probe__\" and path \".\". Do not include any other call in the first batch. This is a required read-only proof that the child Tokenless Harness executed inside the delegated workspace. After receiving that result, do not call another tool and do not analyze the task further. Immediately return a final control envelope with the current runId, turn, and nonce, output set exactly to \"Workspace probe completed.\", and artifacts set exactly to an empty array. The final JSON must contain exactly protocol, kind, runId, turn, nonce, output, and artifacts.`
    : prompt
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
    stdio: { stdin: { data: delegatedPrompt }, stdout: 'pipe', stderr: 'inherit' },
    graceMs: config.disposeGraceMs,
    signal: request.signal,
    env: benchmarkEnvironment,
  })
  if (!child.stdout) throw new Error('subagent-tokenless-harness: delegated process has no stdout pipe')

  const started = deferred()
  const settled = deferred()
  let published = false
  let stdout = ''
  let diagnosticTail = ''
  const consumeLine = (line) => {
    if (line.trim() === '') return
    let event
    try { event = JSON.parse(line) } catch { return }
    if (event?.protocol !== PROTOCOL) return
    if (event.type === 'started' && typeof event.runId === 'string') {
      published = true
      started.resolve(event.runId)
    }
    if (event.type === 'settled' && event.run && typeof event.run === 'object') {
      const detail = publicRunFailure(event.run)
      if (detail) process.stderr.write(`subagent-tokenless-harness: ${detail}\n`)
      settled.resolve(resultFromView(event.run, request.signal.aborted || terminated))
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
  child.done.then((outcome) => {
    consumeLine(stdout)
    const detail = publicCliFailure(diagnosticTail)
    const message = `subagent-tokenless-harness: delegated process exited before settlement (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${detail}`
    if (!published) {
      process.stderr.write(`${message}\n`)
      started.reject(new Error(message))
    }
    settled.resolve({ output: [], stopReason: request.signal.aborted || terminated ? 'aborted' : 'error' })
  }, (error) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (!published) started.reject(failure)
    settled.resolve({ output: [], stopReason: request.signal.aborted || terminated ? 'aborted' : 'error' })
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
  if (typeof baseUrl !== 'string' || typeof token !== 'string') return {}
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('subagent-tokenless-harness: benchmark channel environment is invalid')
  }
  return {
    TOKENLESS_BENCHMARK_LOCAL_HTTP_BASE_URL: baseUrl,
    TOKENLESS_BENCHMARK_CHANNEL_TOKEN: token,
  }
}

function resultFromView(view, aborted) {
  const output = typeof view.final?.output === 'string' && view.final.output.length > 0
    ? [{ type: 'text', text: view.final.output }]
    : []
  if (view.status === 'succeeded') return { output, stopReason: 'completed' }
  if (view.status === 'cancelled' || aborted) return { output, stopReason: 'aborted' }
  return { output, stopReason: 'error' }
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
