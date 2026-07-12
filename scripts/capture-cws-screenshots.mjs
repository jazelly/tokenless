import { chromium } from 'playwright'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionRoot = path.join(root, 'packages/extension/dist/extension')
const outputDirectory = path.join(root, 'test-results/chrome-web-store')
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
}

await fs.mkdir(outputDirectory, { recursive: true })

const server = http.createServer(async (request, response) => {
  const relativePath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    .replace(/^\/+/, '')
  const filePath = path.join(extensionRoot, relativePath || 'settings/index.html')
  if (!filePath.startsWith(`${extensionRoot}${path.sep}`)) {
    response.writeHead(400)
    response.end()
    return
  }

  try {
    const body = await fs.readFile(filePath)
    response.writeHead(200, {
      'content-type': contentTypes[path.extname(filePath)] ?? 'application/octet-stream',
    })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await context.addInitScript(() => {
  function chromeEvent() {
    const listeners = []
    return {
      addListener(listener) {
        listeners.push(listener)
      },
      emit(value) {
        for (const listener of listeners) listener(value)
      },
    }
  }

  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime: {
        lastError: undefined,
        connectNative(hostName) {
          if (hostName !== 'dev.tokenless.native_host') throw new Error(`Unexpected host: ${hostName}`)
          const onMessage = chromeEvent()
          return {
            onMessage,
            onDisconnect: chromeEvent(),
            disconnect() {},
            postMessage(message) {
              const config = {
                protocol: 'tokenless.config.v1',
                preferredProviders: ['chatgpt', 'claude'],
                browser: 'chrome',
                daemonUrl: 'http://127.0.0.1:7331',
              }
              const history = [
                {
                  job_id: 'sample-job-002',
                  provider: 'chatgpt',
                  action: 'submit_and_read',
                  status: 'succeeded',
                  metadata: {
                    projectName: 'Sample local history',
                    chatName: 'Visible UI verification',
                    taskId: 'sample:visible-ui-verification',
                  },
                  updated_at: '2026-07-12T08:00:00Z',
                },
                {
                  job_id: 'sample-job-001',
                  provider: 'claude',
                  action: 'submit_and_read',
                  status: 'failed',
                  metadata: {
                    projectName: 'Sample local history',
                    chatName: 'Provider block example',
                    taskId: 'sample:provider-block-example',
                  },
                  updated_at: '2026-07-12T07:55:00Z',
                },
              ]
              const result = message.type === 'tokenless.native.read_config' ? config : history
              queueMicrotask(() => onMessage.emit({
                protocol: 'tokenless.native.v1',
                type: message.type,
                ok: true,
                result,
              }))
            },
          }
        },
      },
    },
  })
})

try {
  const page = await context.newPage()
  const address = server.address()
  await page.goto(`http://127.0.0.1:${address.port}/settings/index.html`, { waitUntil: 'domcontentloaded' })
  await page.locator('.job-card').first().waitFor()
  await page.screenshot({
    path: path.join(outputDirectory, 'activity-1280x800.png'),
  })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Routing', exact: true }).waitFor()
  await page.screenshot({
    path: path.join(outputDirectory, 'settings-1280x800.png'),
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

console.log(JSON.stringify({
  status: 'captured',
  outputDirectory,
  screenshots: ['activity-1280x800.png', 'settings-1280x800.png'],
}, null, 2))
