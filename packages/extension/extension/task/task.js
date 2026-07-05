const NATIVE_HOST_NAME = 'dev.tokenless.native_host'
const statusNode = document.querySelector('#status')

main().catch(async (error) => {
  setStatus(`Failed: ${error.message || error}`)
  await writeResult({
    jobId: params().jobId,
    nonce: params().nonce,
    ok: false,
    error: serializeError(error),
  }).catch(() => undefined)
})

async function main() {
  const { jobId, nonce } = params()
  if (!jobId || !nonce) {
    throw taskError('invalid_task_url', 'Task URL must include jobId and nonce.')
  }

  setStatus('Claiming local job...')
  const claim = await nativeRequest({ type: 'tokenless.native.claim_job', jobId, nonce })
  if (!claim.ok) {
    throw taskError(claim.error?.code, claim.error?.message)
  }

  const request = claim.result.request
  await writeState(jobId, nonce, 'running', { provider: request.provider })
  setStatus(`Opening ${request.provider} visible session...`)

  const bridgeResponse = await chrome.runtime.sendMessage({
    protocol: 'tokenless.browser-session-bridge.v1',
    requestId: request.jobId,
    provider: request.provider,
    action: request.action,
    prompt: request.prompt,
    targetUrl: request.targetUrl,
    idempotencyKey: request.idempotencyKey,
    conversation: request.conversation,
    readDelayMs: request.readDelayMs,
    readTimeoutMs: request.readTimeoutMs,
    metadata: request.metadata,
  })

  const normalized = normalizeBridgeResponse(bridgeResponse)
  await nativeRequest({
    type: 'tokenless.native.write_result',
    jobId,
    nonce,
    ok: normalized.ok,
    result: normalized.result,
    error: normalized.error,
  })

  setStatus(normalized.ok ? 'Completed.' : `Blocked: ${normalized.error.message}`)
}

function params() {
  const search = new URLSearchParams(location.search)
  return {
    jobId: search.get('jobId'),
    nonce: search.get('nonce'),
  }
}

async function writeState(jobId, nonce, status, detail) {
  const response = await nativeRequest({
    type: 'tokenless.native.write_state',
    jobId,
    nonce,
    status,
    detail,
  })
  if (!response.ok) {
    throw taskError(response.error?.code, response.error?.message)
  }
}

async function writeResult(message) {
  return nativeRequest({
    type: 'tokenless.native.write_result',
    ...message,
  })
}

function nativeRequest(message) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        port.disconnect()
        reject(taskError('native_host_timeout', `Native host did not respond to ${message.type}.`))
      }
    }, 10000)
    port.onMessage.addListener((response) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(response)
      port.disconnect()
    })
    port.onDisconnect.addListener(() => {
      if (!settled) {
        clearTimeout(timeout)
        reject(taskError('native_host_disconnected', chrome.runtime.lastError?.message || 'Native host disconnected.'))
      }
    })
    port.postMessage(message)
  })
}

function normalizeBridgeResponse(response) {
  if (!response?.ok) {
    return {
      ok: false,
      result: null,
      error: response?.error || {
        code: 'bridge_failed',
        message: 'Browser session bridge failed.',
        retryable: true,
      },
    }
  }

  const submit = response.result?.submit
  const read = response.result?.read ?? response.result
  if (submit?.status === 'blocked') {
    return {
      ok: false,
      result: response.result,
      error: { code: submit.stopReason, message: submit.message || 'Provider submit was blocked.', retryable: true },
    }
  }
  if (read?.status === 'blocked') {
    return {
      ok: false,
      result: response.result,
      error: { code: read.stopReason, message: read.message || 'Provider read was blocked.', retryable: true },
    }
  }
  return {
    ok: true,
    result: {
      ...response.result,
      text: read?.text,
      provider: read?.provider ?? response.provider,
    },
    error: null,
  }
}

function setStatus(text) {
  if (statusNode) {
    statusNode.textContent = text
  }
}

function taskError(code, message) {
  const error = new Error(message || 'Tokenless task failed.')
  error.code = code || 'tokenless_task_error'
  return error
}

function serializeError(error) {
  return {
    code: error?.code || 'tokenless_task_error',
    message: error?.message || 'Tokenless task failed.',
    retryable: Boolean(error?.retryable),
  }
}
