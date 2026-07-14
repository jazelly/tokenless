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

  const logo = await fs.readFile(path.join(
    root,
    'packages/extension/assets/tokenless_logo.png'
  ))
  const logoDataUrl = `data:image/png;base64,${logo.toString('base64')}`
  await capturePromoImage(browser, {
    width: 440,
    height: 280,
    logoDataUrl,
    outputPath: path.join(outputDirectory, 'small-promo-440x280.png'),
  })
  await capturePromoImage(browser, {
    width: 1400,
    height: 560,
    logoDataUrl,
    outputPath: path.join(outputDirectory, 'marquee-1400x560.png'),
  })
  await fs.copyFile(
    path.join(extensionRoot, 'icons/tokenless-128.png'),
    path.join(outputDirectory, 'store-icon-128x128.png')
  )
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

console.log(JSON.stringify({
  status: 'captured',
  outputDirectory,
  screenshots: [
    'activity-1280x800.png',
    'settings-1280x800.png',
    'small-promo-440x280.png',
    'marquee-1400x560.png',
    'store-icon-128x128.png',
  ],
}, null, 2))

async function capturePromoImage(browser, { width, height, logoDataUrl, outputPath }) {
  const promoContext = await browser.newContext({ viewport: { width, height } })
  try {
    const page = await promoContext.newPage()
    await page.setContent(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <style>
            * { box-sizing: border-box; }
            html, body { height: 100%; margin: 0; }
            body {
              background:
                radial-gradient(circle at 82% 18%, rgba(255, 199, 47, 0.26), transparent 28%),
                radial-gradient(circle at 12% 92%, rgba(255, 141, 34, 0.18), transparent 31%),
                #15130f;
              color: #fffaf0;
              font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
              overflow: hidden;
            }
            .frame {
              align-items: center;
              display: flex;
              gap: clamp(22px, 5vw, 72px);
              height: 100%;
              padding: clamp(30px, 7vw, 92px);
              position: relative;
            }
            .frame::before,
            .frame::after {
              border: 1px solid rgba(255, 199, 47, 0.22);
              border-radius: 999px;
              content: "";
              position: absolute;
            }
            .frame::before {
              height: 76%;
              right: -8%;
              top: -34%;
              width: 38%;
            }
            .frame::after {
              bottom: -46%;
              height: 74%;
              left: -13%;
              width: 36%;
            }
            .logo-shell {
              background: #fff;
              border-radius: clamp(22px, 4vw, 48px);
              box-shadow: 0 22px 70px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.12);
              flex: 0 0 auto;
              height: clamp(112px, 29vw, 220px);
              overflow: hidden;
              width: clamp(112px, 29vw, 220px);
            }
            .logo-shell img { display: block; height: 100%; width: 100%; }
            .copy { max-width: 760px; position: relative; z-index: 1; }
            .name {
              color: #ffc72f;
              font-size: clamp(16px, 2.2vw, 26px);
              font-weight: 800;
              letter-spacing: 0.16em;
              margin-bottom: clamp(8px, 2vw, 18px);
              text-transform: uppercase;
            }
            h1 {
              font-size: clamp(30px, 5.2vw, 68px);
              letter-spacing: -0.045em;
              line-height: 0.98;
              margin: 0;
              max-width: 820px;
            }
            p {
              color: #d8d0c2;
              font-size: clamp(13px, 1.8vw, 22px);
              line-height: 1.35;
              margin: clamp(12px, 2.4vw, 24px) 0 0;
            }
            @media (max-width: 600px) {
              .frame { padding: 30px; }
              .name { letter-spacing: 0.1em; }
              h1 { line-height: 1.02; }
            }
          </style>
        </head>
        <body>
          <main class="frame">
            <div class="logo-shell"><img src="${logoDataUrl}" alt=""></div>
            <div class="copy">
              <div class="name">Tokenless</div>
              <h1>Save agent tokens.</h1>
              <p>Use the web AI you already have—without leaving your agent workflow.</p>
            </div>
          </main>
        </body>
      </html>`)
    await page.screenshot({ path: outputPath })
  } finally {
    await promoContext.close()
  }
}
