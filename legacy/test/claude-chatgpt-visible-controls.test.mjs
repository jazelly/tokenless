import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const providerContentPath = path.join(root, 'legacy/extension/dist/extension/content/provider-content.js')

test('ChatGPT and Claude auth probes use compound visible signals without returning account identity', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const sessions = []
  try {
    const chatGptSignedIn = await openProviderFixture(browser, 'https://chatgpt.com/', readFixture(
      'test/fixtures/provider-dom/chatgpt/signed-in-paid/session-status.html'
    )
      .replace('[redacted account identity], Plus', 'private-marker, Plus')
      .replace('role="button"', 'role="button" style="width:40px;height:40px"'))
    sessions.push(chatGptSignedIn)
    const chatGptAuth = await inspectAuth(chatGptSignedIn.page, 'chatgpt')
    assert.deepEqual(chatGptAuth.auth, {
      state: 'authenticated',
      plan: { label: 'Plus', free: false },
    })
    assert.doesNotMatch(JSON.stringify(chatGptAuth), /private-marker/)

    const claudeSignedIn = await openProviderFixture(browser, 'https://claude.ai/new', readFixture(
      'test/fixtures/provider-dom/claude/signed-in-free/session-status.html'
    ).replace('[redacted account identity]', 'private-marker'))
    sessions.push(claudeSignedIn)
    const claudeAuth = await inspectAuth(claudeSignedIn.page, 'claude')
    assert.deepEqual(claudeAuth.auth, {
      state: 'authenticated',
      plan: { label: 'Free', free: true },
    })
    assert.doesNotMatch(JSON.stringify(claudeAuth), /private-marker/)

    const chatGptSignedOut = await openProviderFixture(browser, 'https://chatgpt.com/', `
      <!doctype html><html><body>
        <a href="/auth/login">Log in</a>
        <a href="/auth/signup">Sign up</a>
      </body></html>
    `)
    sessions.push(chatGptSignedOut)
    assert.deepEqual((await inspectAuth(chatGptSignedOut.page, 'chatgpt')).auth, {
      state: 'unauthenticated',
    })

    const claudeSignedOut = await openProviderFixture(browser, 'https://claude.ai/new', `
      <!doctype html><html><body>
        <form><input placeholder="Enter your email"><button data-testid="continue">Continue</button></form>
      </body></html>
    `)
    sessions.push(claudeSignedOut)
    assert.deepEqual((await inspectAuth(claudeSignedOut.page, 'claude')).auth, {
      state: 'unauthenticated',
    })

    const geminiPlanLookalike = await openProviderFixture(browser, 'https://gemini.google.com/app', `
      <!doctype html><html><body>
        <div><a href="https://accounts.google.com/SignOutOptions">Account</a><button>Pro</button></div>
      </body></html>
    `)
    sessions.push(geminiPlanLookalike)
    assert.deepEqual((await inspectAuth(geminiPlanLookalike.page, 'gemini')).auth, {
      state: 'authenticated',
    })

    const grokPlanLookalike = await openProviderFixture(browser, 'https://grok.com/', `
      <!doctype html><html><body>
        <div><a href="/skills-and-connectors">Skills and connectors</a><span>Free</span></div>
      </body></html>
    `)
    sessions.push(grokPlanLookalike)
    assert.deepEqual((await inspectAuth(grokPlanLookalike.page, 'grok')).auth, {
      state: 'authenticated',
    })

    const conflicting = await openProviderFixture(browser, 'https://chatgpt.com/', `
      <!doctype html><html><body>
        <div data-testid="accounts-profile-button" role="button" aria-label="Account menu, Plus plan">Plus</div>
        <a href="/auth/login">Log in</a>
      </body></html>
    `)
    sessions.push(conflicting)
    assert.deepEqual((await inspectAuth(conflicting.page, 'chatgpt')).auth, { state: 'unknown' })

    for (const session of sessions) assert.deepEqual(session.pageErrors, [])
  } finally {
    await Promise.all(sessions.map((session) => session.context.close()))
    await browser.close()
  }
})

test('Claude inventories model-dependent controls, blocks Upgrade rows, and verifies exact model and effort selections', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const claude = await openProviderFixture(browser, 'https://claude.ai/new', claudeControlsFixture())
  try {
    const initial = await inspectControls(claude.page, 'claude')
    assert.deepEqual(initial.controls.models, [
      { label: 'Fable 5', selected: false, available: false },
      { label: 'Opus 4.8', selected: false, available: false },
      { label: 'Sonnet 5', selected: false, available: true },
      { label: 'Haiku 4.5', selected: true, available: true },
    ])
    assert.deepEqual(initial.controls.efforts, [
      { id: 'extended', label: 'Extended', selected: false, available: true },
    ])

    const upgradeBlocked = await configureControls(claude.page, 'claude', { model: 'Fable 5' })
    assert.equal(upgradeBlocked.status, 'blocked')
    assert.equal(upgradeBlocked.stopReason, 'model_control_unavailable')
    assert.equal(await claude.page.locator('[data-testid="model-selector-dropdown"]').getAttribute('aria-label'), 'Model: Haiku 4.5')

    const selected = await configureControls(claude.page, 'claude', {
      model: 'Sonnet 5',
      effort: 'High',
    })
    assert.equal(selected.status, 'configured')
    assert.equal(selected.model.applied, 'Sonnet 5')
    assert.equal(selected.effort.applied, 'High')
    assert.equal(await claude.page.locator('[data-testid="model-selector-dropdown"]').getAttribute('aria-label'), 'Model: Sonnet 5 High')

    const sonnet = await inspectControls(claude.page, 'claude')
    assert.deepEqual(sonnet.controls.efforts.map(({ id, label, selected }) => ({ id, label, selected })), [
      { id: 'low', label: 'Low', selected: false },
      { id: 'medium', label: 'Medium', selected: false },
      { id: 'high', label: 'High', selected: true },
      { id: 'extra', label: 'Extra', selected: false },
      { id: 'max', label: 'Max', selected: false },
      { id: 'thinking', label: 'Thinking', selected: true },
    ])

    const extended = await configureControls(claude.page, 'claude', {
      model: 'Haiku 4.5',
      effort: 'Extended',
    })
    assert.equal(extended.status, 'configured')
    assert.equal(extended.effort.applied, 'Extended')
    const haiku = await inspectControls(claude.page, 'claude')
    assert.equal(haiku.controls.efforts.find((choice) => choice.label === 'Extended')?.selected, true)

    const partial = await configureControls(claude.page, 'claude', { model: 'Sonnet' })
    assert.equal(partial.status, 'blocked')
    assert.equal(partial.stopReason, 'model_control_unavailable')
    assert.deepEqual(claude.pageErrors, [])
  } finally {
    await claude.context.close()
    await browser.close()
  }
})

test('ChatGPT uses the current dynamic Intelligence labels and strips model descriptions from exact selection', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const chatgpt = await openProviderFixture(browser, 'https://chatgpt.com/', chatGptControlsFixture())
  try {
    const inspected = await inspectControls(chatgpt.page, 'chatgpt')
    assert.deepEqual(inspected.controls.efforts, [
      { id: 'instant', label: 'Instant', selected: false, available: true },
      { id: 'medium', label: 'Medium', selected: false, available: true },
      { id: 'high', label: 'High', selected: true, available: true },
    ])
    assert.deepEqual(inspected.controls.models.map((model) => model.label), [
      'GPT-5.6 Sol',
      'GPT-5.5',
      'GPT-5.4',
      'GPT-5.3',
      'o3',
    ])

    const selected = await configureControls(chatgpt.page, 'chatgpt', {
      model: 'GPT-5.4',
      effort: 'Instant',
    })
    assert.equal(selected.status, 'configured')
    assert.equal(selected.model.applied, 'GPT-5.4')
    assert.equal(selected.effort.applied, 'Instant')
    assert.equal(await chatgpt.page.locator('#intelligence').innerText(), '5.4 Instant')

    const missingEffort = await configureControls(chatgpt.page, 'chatgpt', { effort: 'Pro' })
    assert.equal(missingEffort.status, 'blocked')
    assert.equal(missingEffort.stopReason, 'effort_control_unavailable')
    assert.equal(await chatgpt.page.locator('#intelligence').innerText(), '5.4 Instant')

    const partialModel = await configureControls(chatgpt.page, 'chatgpt', { model: 'GPT-5' })
    assert.equal(partialModel.status, 'blocked')
    assert.equal(partialModel.stopReason, 'model_control_unavailable')
    assert.deepEqual(chatgpt.pageErrors, [])
  } finally {
    await chatgpt.context.close()
    await browser.close()
  }
})

async function inspectAuth(page, provider) {
  return page.evaluate(({ provider }) => globalThis.__dispatchTokenlessMessage({
    type: 'tokenless.bridge.inspect_auth',
    request: { provider, requestId: `${provider}-auth-status` },
  }), { provider })
}

async function inspectControls(page, provider) {
  return page.evaluate(({ provider }) => globalThis.__dispatchTokenlessMessage({
    type: 'tokenless.bridge.inspect_controls',
    request: { provider, requestId: `${provider}-controls-inspect` },
  }), { provider })
}

async function configureControls(page, provider, controls) {
  return page.evaluate(({ provider, controls }) => globalThis.__dispatchTokenlessMessage({
    type: 'tokenless.bridge.configure_controls',
    request: { provider, requestId: `${provider}-controls-configure`, ...controls },
  }), { provider, controls })
}

async function openProviderFixture(browser, url, html) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  await context.addInitScript(() => {
    const listeners = []
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          onMessage: { addListener(listener) { listeners.push(listener) } },
        },
      },
    })
    Object.defineProperty(globalThis, '__dispatchTokenlessMessage', {
      configurable: true,
      value(message) {
        return new Promise((resolve, reject) => {
          const listener = listeners[0]
          if (!listener) return reject(new Error('Provider content listener is not installed.'))
          let responded = false
          const keepOpen = listener(message, {}, (response) => {
            responded = true
            resolve(response)
          })
          if (keepOpen !== true && !responded) reject(new Error('Provider content response channel closed.'))
        })
      },
    })
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const origin = new URL(url).origin
  await page.route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: html,
  }))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ path: providerContentPath })
  return { context, page, pageErrors }
}

function readFixture(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function claudeControlsFixture() {
  return `<!doctype html><html><body>
    <main>
      <button data-testid="user-menu-button" aria-label="Account settings, Free plan">Account settings</button>
      <button data-testid="model-selector-dropdown" aria-label="Model: Haiku 4.5" aria-haspopup="menu" aria-expanded="false">Haiku 4.5</button>
      <div data-testid="chat-input" contenteditable="true" role="textbox" aria-label="Write your prompt to Claude"></div>
    </main>
    <script>
      const trigger = document.querySelector('[data-testid="model-selector-dropdown"]')
      let model = 'Haiku 4.5'
      let effort = 'Medium'
      let extended = false
      let thinking = true
      const closeMenus = () => {
        document.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove())
        trigger.setAttribute('aria-expanded', 'false')
      }
      const updateTrigger = () => {
        const suffix = model === 'Sonnet 5' ? ' ' + effort : ''
        trigger.setAttribute('aria-label', 'Model: ' + model + suffix)
        trigger.textContent = model
      }
      const span = (text) => {
        const node = document.createElement('span')
        node.textContent = text
        node.style.display = 'block'
        return node
      }
      const addSwitch = (menu, label, selected, update) => {
        const item = document.createElement('div')
        item.setAttribute('role', 'menuitem')
        item.append(span(label))
        const control = document.createElement('button')
        control.setAttribute('role', 'switch')
        control.setAttribute('aria-label', label)
        control.setAttribute('aria-checked', String(selected()))
        control.addEventListener('click', () => {
          update()
          control.setAttribute('aria-checked', String(selected()))
        })
        item.append(control)
        menu.append(item)
      }
      const effortMenu = () => {
        document.querySelector('[role="menu"][aria-label="Effort"]')?.remove()
        const menu = document.createElement('div')
        menu.setAttribute('role', 'menu')
        menu.setAttribute('aria-label', 'Effort')
        for (const label of ['Low', 'Medium', 'High', 'Extra', 'Max']) {
          const item = document.createElement('button')
          item.setAttribute('role', 'menuitemradio')
          item.setAttribute('aria-checked', String(label === effort))
          item.append(span(label))
          if (label === 'Medium') item.append(span('Default'))
          item.addEventListener('click', () => { effort = label; closeMenus(); updateTrigger() })
          menu.append(item)
        }
        document.body.append(menu)
      }
      const modelMenu = () => {
        closeMenus()
        trigger.setAttribute('aria-expanded', 'true')
        const menu = document.createElement('div')
        menu.setAttribute('role', 'menu')
        menu.setAttribute('aria-label', 'Model selection')
        for (const label of ['Fable 5', 'Opus 4.8', 'Sonnet 5', 'Haiku 4.5']) {
          const item = document.createElement('button')
          item.setAttribute('role', 'menuitemradio')
          item.setAttribute('aria-checked', String(label === model))
          item.append(span(label))
          if (label === 'Fable 5' || label === 'Opus 4.8') {
            item.append(span('Pro'))
            item.append(span('Upgrade'))
          }
          item.addEventListener('click', () => { model = label; closeMenus(); updateTrigger() })
          menu.append(item)
        }
        if (model === 'Sonnet 5') {
          const submenu = document.createElement('button')
          submenu.setAttribute('role', 'menuitem')
          submenu.setAttribute('aria-haspopup', 'menu')
          submenu.append(span('Effort'))
          submenu.append(span(effort))
          submenu.addEventListener('click', effortMenu)
          menu.append(submenu)
          addSwitch(menu, 'Thinking', () => thinking, () => { thinking = !thinking })
        } else if (model === 'Haiku 4.5') {
          addSwitch(menu, 'Extended', () => extended, () => { extended = !extended })
        }
        document.body.append(menu)
      }
      trigger.addEventListener('click', modelMenu)
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus() })
      updateTrigger()
    </script>
  </body></html>`
}

function chatGptControlsFixture() {
  return `<!doctype html><html><body>
    <div data-testid="accounts-profile-button" role="button" aria-label="Account menu, Plus plan">Plus</div>
    <main>
      <div id="prompt-textarea" role="textbox" contenteditable="true" style="width:600px;height:40px"></div>
      <button id="intelligence" class="__composer-pill-fixture" aria-expanded="false" aria-haspopup="menu">High</button>
    </main>
    <script>
      const trigger = document.querySelector('#intelligence')
      let model = 'GPT-5.6 Sol'
      let effort = 'High'
      const closeMenus = () => {
        document.querySelectorAll('[role="menu"]').forEach((menu) => menu.remove())
        trigger.setAttribute('aria-expanded', 'false')
      }
      const updateTrigger = () => {
        trigger.textContent = model === 'GPT-5.6 Sol' ? effort : model.replace('GPT-', '') + ' ' + effort
      }
      const span = (text) => {
        const node = document.createElement('span')
        node.textContent = text
        node.style.display = 'block'
        return node
      }
      const modelMenu = () => {
        document.querySelector('[role="menu"][aria-label="Models"]')?.remove()
        const menu = document.createElement('div')
        menu.setAttribute('role', 'menu')
        menu.setAttribute('aria-label', 'Models')
        for (const label of ['GPT-5.6 Sol', 'GPT-5.5', 'GPT-5.4', 'GPT-5.3', 'o3']) {
          const item = document.createElement('button')
          item.setAttribute('role', 'menuitemradio')
          item.setAttribute('aria-checked', String(label === model))
          item.append(span(label))
          if (label === 'GPT-5.4') item.append(span('Leaving on July 23'))
          item.addEventListener('click', () => { model = label; closeMenus(); updateTrigger() })
          menu.append(item)
        }
        document.body.append(menu)
      }
      const intelligenceMenu = () => {
        closeMenus()
        trigger.setAttribute('aria-expanded', 'true')
        const menu = document.createElement('div')
        menu.setAttribute('role', 'menu')
        menu.setAttribute('aria-labelledby', trigger.id)
        for (const label of ['Instant', 'Medium', 'High']) {
          const item = document.createElement('button')
          item.setAttribute('role', 'menuitemradio')
          item.setAttribute('aria-checked', String(label === effort))
          item.append(span(label))
          if (label === 'Instant') item.append(span('5.5'))
          item.addEventListener('click', () => { effort = label; closeMenus(); updateTrigger() })
          menu.append(item)
        }
        const submenu = document.createElement('button')
        submenu.setAttribute('role', 'menuitem')
        submenu.setAttribute('aria-haspopup', 'menu')
        submenu.append(span(model))
        submenu.addEventListener('click', modelMenu)
        menu.append(submenu)
        document.body.append(menu)
      }
      trigger.addEventListener('click', intelligenceMenu)
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenus() })
      updateTrigger()
    </script>
  </body></html>`
}
