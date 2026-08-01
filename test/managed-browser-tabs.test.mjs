import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright-core'

import {
  PersistentContextManager,
} from '../packages/cli/dist/src/playwright/index.js'

test('managed browser preserves independent logical tabs in one profile', async () => {
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-managed-tabs-'))
  const manager = new PersistentContextManager({
    browser: {
      id: 'profile',
      executablePath: chromium.executablePath(),
    },
  })

  try {
    const profile = { id: 'default', directory: profileDirectory, lifecycle: 'ready' }
    await manager.runWithProfile(profile, 'headless', async (context) => {
      const chatgpt = await context.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
      await chatgpt.setContent('<title>ChatGPT chat A</title>')

      const claude = await context.acquirePage({ key: 'provider:claude:task:chat-b' })
      await claude.setContent('<title>Claude chat B</title>')

      assert.notEqual(claude, chatgpt)
      assert.equal(await chatgpt.title(), 'ChatGPT chat A')
      assert.equal(await claude.title(), 'Claude chat B')
      assert.equal(context.browserContext.pages().length, 2)

      const resumedChatgpt = await context.acquirePage({ key: 'provider:chatgpt:task:chat-a' })
      assert.equal(resumedChatgpt, chatgpt)
      assert.equal(await resumedChatgpt.title(), 'ChatGPT chat A')
      assert.equal(context.browserContext.pages().length, 2)

      const forcedReplacement = await context.acquirePage({
        key: 'provider:grok:task:chat-c',
        policy: 'replace',
      })
      assert.equal(forcedReplacement, claude)
      assert.equal(context.browserContext.pages().length, 2)

      const restoredClaude = await context.acquirePage({ key: 'provider:claude:task:chat-b' })
      assert.notEqual(restoredClaude, forcedReplacement)
      assert.equal(context.browserContext.pages().length, 3)
    })
  } finally {
    await manager.shutdown()
    fs.rmSync(profileDirectory, { recursive: true, force: true })
  }
})
