#!/usr/bin/env node
import http from 'node:http'
import { createRelayResult, validateRelayRun } from './index.js'

const port = Number(process.env.TOKENLESS_RELAY_PORT ?? 8787)

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { ok: true, service: 'tokenless-relay' })
    }

    if (request.method === 'GET' && request.url === '/v1/capabilities') {
      return sendJson(response, 200, {
        ok: true,
        protocol: 'tokenless.relay.v1',
        transports: ['tokenless-relay', 'browser-extension', 'tokenless-cli'],
        providers: ['chatgpt', 'gemini', 'claude'],
        actions: ['capabilities', 'open', 'submit', 'read', 'submit_and_read'],
      })
    }

    if (request.method === 'POST' && request.url === '/v1/runs') {
      const body = await readJson(request)
      const validation = validateRelayRun(body)
      if (!validation.ok) {
        return sendJson(response, 400, createRelayResult(body, { ok: false, error: validation.error }))
      }
      return sendJson(response, 202, createRelayResult(validation.run, {
        ok: true,
        result: {
          status: 'accepted',
          relay: 'server',
          note: 'Browser execution requires an installed Tokenless extension or a Tokenless CLI relay.',
        },
      }))
    }

    return sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Route not found.' } })
  } catch (error) {
    return sendJson(response, 500, {
      ok: false,
      error: { code: 'relay_server_error', message: error.message || 'Tokenless Relay failed.' },
    })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`tokenless-relay listening on http://127.0.0.1:${port}`)
})

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}
