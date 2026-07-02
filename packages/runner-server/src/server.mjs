#!/usr/bin/env node
import http from 'node:http'
import { createRunnerResult, validateRun } from './index.js'

const port = Number(process.env.TOKENLESS_RUNNER_PORT ?? 8787)

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { ok: true, service: 'tokenless-runner-server' })
    }

    if (request.method === 'GET' && request.url === '/v1/capabilities') {
      return sendJson(response, 200, {
        ok: true,
        protocol: 'tokenless.runner.v1',
        transports: ['server-runner', 'browser-extension-relay', 'local-scale'],
        providers: ['chatgpt', 'gemini', 'claude'],
        actions: ['capabilities', 'open', 'submit', 'read', 'submit_and_read'],
      })
    }

    if (request.method === 'POST' && request.url === '/v1/runs') {
      const body = await readJson(request)
      const validation = validateRun(body)
      if (!validation.ok) {
        return sendJson(response, 400, createRunnerResult(body, { ok: false, error: validation.error }))
      }
      return sendJson(response, 202, createRunnerResult(validation.run, {
        ok: true,
        result: {
          status: 'accepted',
          runner: 'server',
          note: 'Browser execution requires an installed Tokenless extension or a local-scale relay.',
        },
      }))
    }

    return sendJson(response, 404, { ok: false, error: { code: 'not_found', message: 'Route not found.' } })
  } catch (error) {
    return sendJson(response, 500, {
      ok: false,
      error: { code: 'runner_server_error', message: error.message || 'Runner server failed.' },
    })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`tokenless-runner-server listening on http://127.0.0.1:${port}`)
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
