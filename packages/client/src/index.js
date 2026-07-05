export function createRelayClient({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new TypeError('baseUrl must be a nonempty string.')
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be available.')
  }

  const root = baseUrl.replace(/\/+$/, '')

  return {
    async capabilities() {
      return requestJson(fetchImpl, `${root}/v1/capabilities`, { method: 'GET' })
    },
    async createRun(run) {
      return requestJson(fetchImpl, `${root}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(run),
      })
    },
  }
}

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, init)
  const payload = await response.json()
  if (!response.ok && payload?.error == null) {
    return {
      ok: false,
      error: {
        code: 'tokenless_http_error',
        message: `Tokenless request failed with HTTP ${response.status}.`,
        retryable: response.status >= 500,
      },
    }
  }
  return payload
}
