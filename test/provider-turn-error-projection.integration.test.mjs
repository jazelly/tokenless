import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import test from 'node:test'
import { JobStore } from '../packages/cli/dist/server/src/jobs/store.js'
import { writeTokenlessConfig } from '../packages/cli/dist/server/src/persistence/config.js'
import { PrivateProviderTurnV0Adapter } from '../packages/cli/dist/server/src/http/private/provider-turn/v0.js'

test('provider-turn projection preserves capacity error codes instead of collapsing to provider_unavailable', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-turn-error-'))
  const profileSlug = 'test-profile'
  
  await writeTokenlessConfig({
    homeDir,
    profiles: {
      [profileSlug]: {
        enabledProviders: ['chatgpt'],
        providerModes: { chatgpt: ['browser'] },
      },
    },
  })
  
  await fs.mkdir(path.join(homeDir, 'profiles', profileSlug), { recursive: true })
  await fs.writeFile(
    path.join(homeDir, 'profiles', profileSlug, 'profile.json'),
    JSON.stringify({
      slug: profileSlug,
      name: 'Test Profile',
      runtime: { kind: 'chromium-cdp', browser: 'chrome', executablePath: '/usr/bin/google-chrome' },
      lastObservedAuth: {},
    })
  )
  
  const store = await JobStore.open(homeDir)
  const adapter = new PrivateProviderTurnV0Adapter(store)

  try {
    const binding = await adapter.bind({ provider: 'chatgpt', profileId: profileSlug })
    const attachmentRef = `attachment:${randomBytes(16).toString('hex')}`
    
    const staged = store.createWebAiStagedAttachment({
      attachment_ref: attachmentRef,
      binding_ref: binding.providerBindingRef,
      bundle_id: `tlp_${randomUUID()}`,
      attachment_id: randomUUID(),
      media_type: 'text/markdown',
      byte_length: 100,
      sha256: 'a'.repeat(64),
    })
    
    const turn = store.createWebAiTurn({
      turn_ref: `turn:${randomBytes(16).toString('hex')}`,
      binding_ref: binding.providerBindingRef,
      conversation_ref: `conversation:${randomBytes(16).toString('hex')}`,
      attachment_refs: [attachmentRef],
      request_ref: `request:${randomBytes(16).toString('hex')}`,
      job: {
        provider: 'chatgpt',
        request_json: {},
        profile_id: profileSlug,
        job_id: staged.bundle_id,
      },
    })

    const running = store.takeNextJob({ job_id_prefix: turn.job_id }, profileSlug)
    assert.ok(running)
    
    const capacityError = {
      code: 'provider_capacity_unavailable',
      message: 'Free ChatGPT profile capacity rule chatgpt.files.free.daily exceeded for file.upload',
      retryAfterSeconds: 86400,
    }
    store.completeJob(turn.job_id, { error_json: capacityError })

    const state = await adapter.read(turn.turn_ref)
    
    assert.equal(state.lifecycle, 'failed')
    assert.equal(state.error.code, 'provider_capacity_unavailable')
    assert.ok(state.error.message.includes('capacity'))
    assert.notEqual(state.error.code, 'provider_unavailable')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('provider-turn projection maps rate-limited error correctly', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-turn-error-'))
  const profileSlug = 'test-profile'
  
  await writeTokenlessConfig({
    homeDir,
    profiles: {
      [profileSlug]: {
        enabledProviders: ['chatgpt'],
        providerModes: { chatgpt: ['browser'] },
      },
    },
  })
  
  await fs.mkdir(path.join(homeDir, 'profiles', profileSlug), { recursive: true })
  await fs.writeFile(
    path.join(homeDir, 'profiles', profileSlug, 'profile.json'),
    JSON.stringify({
      slug: profileSlug,
      name: 'Test Profile',
      runtime: { kind: 'chromium-cdp', browser: 'chrome', executablePath: '/usr/bin/google-chrome' },
      lastObservedAuth: {},
    })
  )
  
  const store = await JobStore.open(homeDir)
  const adapter = new PrivateProviderTurnV0Adapter(store)

  try {
    const binding = await adapter.bind({ provider: 'chatgpt', profileId: profileSlug })
    const attachmentRef = `attachment:${randomBytes(16).toString('hex')}`
    
    const staged = store.createWebAiStagedAttachment({
      attachment_ref: attachmentRef,
      binding_ref: binding.providerBindingRef,
      bundle_id: `tlp_${randomUUID()}`,
      attachment_id: randomUUID(),
      media_type: 'text/markdown',
      byte_length: 100,
      sha256: 'a'.repeat(64),
    })
    
    const turn = store.createWebAiTurn({
      turn_ref: `turn:${randomBytes(16).toString('hex')}`,
      binding_ref: binding.providerBindingRef,
      conversation_ref: `conversation:${randomBytes(16).toString('hex')}`,
      attachment_refs: [attachmentRef],
      request_ref: `request:${randomBytes(16).toString('hex')}`,
      job: {
        provider: 'chatgpt',
        request_json: {},
        profile_id: profileSlug,
        job_id: staged.bundle_id,
      },
    })

    const running = store.takeNextJob({ job_id_prefix: turn.job_id }, profileSlug)
    assert.ok(running)
    
    const rateLimitError = {
      code: 'provider_rate_limited',
      message: 'Too many requests. Please try again later.',
    }
    store.completeJob(turn.job_id, { error_json: rateLimitError })

    const state = await adapter.read(turn.turn_ref)
    
    assert.equal(state.lifecycle, 'failed')
    assert.equal(state.error.code, 'provider_rate_limited')
    assert.ok(state.error.message.toLowerCase().includes('rate') || state.error.message.toLowerCase().includes('request'))
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('provider-turn projection maps credits-exhausted error correctly', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-turn-error-'))
  const profileSlug = 'test-profile'
  
  await writeTokenlessConfig({
    homeDir,
    profiles: {
      [profileSlug]: {
        enabledProviders: ['chatgpt'],
        providerModes: { chatgpt: ['browser'] },
      },
    },
  })
  
  await fs.mkdir(path.join(homeDir, 'profiles', profileSlug), { recursive: true })
  await fs.writeFile(
    path.join(homeDir, 'profiles', profileSlug, 'profile.json'),
    JSON.stringify({
      slug: profileSlug,
      name: 'Test Profile',
      runtime: { kind: 'chromium-cdp', browser: 'chrome', executablePath: '/usr/bin/google-chrome' },
      lastObservedAuth: {},
    })
  )
  
  const store = await JobStore.open(homeDir)
  const adapter = new PrivateProviderTurnV0Adapter(store)

  try {
    const binding = await adapter.bind({ provider: 'chatgpt', profileId: profileSlug })
    const attachmentRef = `attachment:${randomBytes(16).toString('hex')}`
    
    const staged = store.createWebAiStagedAttachment({
      attachment_ref: attachmentRef,
      binding_ref: binding.providerBindingRef,
      bundle_id: `tlp_${randomUUID()}`,
      attachment_id: randomUUID(),
      media_type: 'text/markdown',
      byte_length: 100,
      sha256: 'a'.repeat(64),
    })
    
    const turn = store.createWebAiTurn({
      turn_ref: `turn:${randomBytes(16).toString('hex')}`,
      binding_ref: binding.providerBindingRef,
      conversation_ref: `conversation:${randomBytes(16).toString('hex')}`,
      attachment_refs: [attachmentRef],
      request_ref: `request:${randomBytes(16).toString('hex')}`,
      job: {
        provider: 'chatgpt',
        request_json: {},
        profile_id: profileSlug,
        job_id: staged.bundle_id,
      },
    })

    const running = store.takeNextJob({ job_id_prefix: turn.job_id }, profileSlug)
    assert.ok(running)
    
    const creditsError = {
      code: 'provider_credits_exhausted',
      message: 'Insufficient credits for this operation.',
    }
    store.completeJob(turn.job_id, { error_json: creditsError })

    const state = await adapter.read(turn.turn_ref)
    
    assert.equal(state.lifecycle, 'failed')
    assert.equal(state.error.code, 'provider_credits_exhausted')
    assert.ok(state.error.message.includes('credit'))
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})

test('provider-turn projection falls back to provider_unavailable for unknown provider errors', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-turn-error-'))
  const profileSlug = 'test-profile'
  
  await writeTokenlessConfig({
    homeDir,
    profiles: {
      [profileSlug]: {
        enabledProviders: ['chatgpt'],
        providerModes: { chatgpt: ['browser'] },
      },
    },
  })
  
  await fs.mkdir(path.join(homeDir, 'profiles', profileSlug), { recursive: true })
  await fs.writeFile(
    path.join(homeDir, 'profiles', profileSlug, 'profile.json'),
    JSON.stringify({
      slug: profileSlug,
      name: 'Test Profile',
      runtime: { kind: 'chromium-cdp', browser: 'chrome', executablePath: '/usr/bin/google-chrome' },
      lastObservedAuth: {},
    })
  )
  
  const store = await JobStore.open(homeDir)
  const adapter = new PrivateProviderTurnV0Adapter(store)

  try {
    const binding = await adapter.bind({ provider: 'chatgpt', profileId: profileSlug })
    const attachmentRef = `attachment:${randomBytes(16).toString('hex')}`
    
    const staged = store.createWebAiStagedAttachment({
      attachment_ref: attachmentRef,
      binding_ref: binding.providerBindingRef,
      bundle_id: `tlp_${randomUUID()}`,
      attachment_id: randomUUID(),
      media_type: 'text/markdown',
      byte_length: 100,
      sha256: 'a'.repeat(64),
    })
    
    const turn = store.createWebAiTurn({
      turn_ref: `turn:${randomBytes(16).toString('hex')}`,
      binding_ref: binding.providerBindingRef,
      conversation_ref: `conversation:${randomBytes(16).toString('hex')}`,
      attachment_refs: [attachmentRef],
      request_ref: `request:${randomBytes(16).toString('hex')}`,
      job: {
        provider: 'chatgpt',
        request_json: {},
        profile_id: profileSlug,
        job_id: staged.bundle_id,
      },
    })

    const running = store.takeNextJob({ job_id_prefix: turn.job_id }, profileSlug)
    assert.ok(running)
    
    const unknownProviderError = {
      code: 'provider_unknown_error',
      message: 'Something went wrong with the provider.',
    }
    store.completeJob(turn.job_id, { error_json: unknownProviderError })

    const state = await adapter.read(turn.turn_ref)
    
    assert.equal(state.lifecycle, 'failed')
    assert.equal(state.error.code, 'provider_unavailable')
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})
