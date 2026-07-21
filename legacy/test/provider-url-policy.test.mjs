import assert from 'node:assert/strict'
import test from 'node:test'

const extensionPolicyUrl = new URL(
  '../legacy/extension/dist/extension/shared/provider-navigation-policy.js',
  import.meta.url
)
const extensionProvidersUrl = new URL(
  '../legacy/extension/dist/extension/shared/provider-config.js',
  import.meta.url
)
const cliUrl = new URL('../packages/cli/dist/src/index.js', import.meta.url)

test('CLI and extension accept only strict queryless provider targets', async () => {
  const { providerWakeUrl } = await import(cliUrl)
  const { getProviderById } = await import(extensionProvidersUrl)
  const { safeProviderTargetUrl } = await import(extensionPolicyUrl)
  const accepted = {
    chatgpt: [
      'https://chatgpt.com/',
      'https://chat.openai.com/c/12345678',
      'https://chatgpt.com/g/g-p-12345678/project',
      'https://chatgpt.com/g/g-p-12345678/c/abcdefgh9',
    ],
    claude: [
      'https://claude.ai/new',
      'https://claude.ai/chat/123e4567-e89b-12d3-a456-426614174001',
      'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002',
    ],
    gemini: [
      'https://gemini.google.com/app',
      'https://gemini.google.com/app/4b9f2c7d1e6a',
    ],
    grok: [
      'https://grok.com/',
      'https://grok.com/c/123e4567-e89b-12d3-a456-426614174003',
    ],
  }

  for (const [providerId, targets] of Object.entries(accepted)) {
    const provider = getProviderById(providerId)
    assert.ok(provider)
    for (const target of targets) {
      assert.equal(providerWakeUrl(providerId, target), new URL(target).href, `${providerId}: ${target}`)
      assert.equal(safeProviderTargetUrl(provider, target), new URL(target).href, `${providerId}: ${target}`)
    }
  }
})

test('CLI and extension reject URL parser ambiguities and non-canonical authority', async () => {
  const { providerWakeUrl } = await import(cliUrl)
  const { getProviderById } = await import(extensionProvidersUrl)
  const { safeProviderTargetUrl } = await import(extensionPolicyUrl)
  const provider = getProviderById('chatgpt')
  assert.ok(provider)

  const rejected = [
    'http://chatgpt.com/c/12345678',
    'https://user@chatgpt.com/c/12345678',
    'https://user:password@chatgpt.com/c/12345678',
    'https://chatgpt.com:443/c/12345678',
    'https://chatgpt.com:444/c/12345678',
    'https://example.com/c/12345678',
    'https://chatgpt.com/c/12345678?',
    'https://chatgpt.com/c/12345678?model=auto',
    'https://chatgpt.com/c/12345678#',
    'https://chatgpt.com/c/12345678#composer',
    'https://chatgpt.com/c\\12345678',
    'https://chatgpt.com/c/%2fsettings',
    'https://chatgpt.com/c/%252fsettings',
    'https://chatgpt.com/c/%5Csettings',
    'https://chatgpt.com/c/%00settings',
    'https://chatgpt.com/c/%0Asettings',
    'https://chatgpt.com/c/%7fsettings',
    'https://chatgpt.com/c/%3fmodel=auto',
    'https://chatgpt.com/c/%23composer',
    'https://chatgpt.com/c/%not-an-escape',
    ' https://chatgpt.com/c/12345678',
    'https://chatgpt.com/c/12345678\n',
  ]

  for (const target of rejected) {
    assert.equal(safeProviderTargetUrl(provider, target), null, target)
    assert.throws(() => providerWakeUrl('chatgpt', target), /Provider target URL|Target URL/, target)
  }
  assert.equal(safeProviderTargetUrl(provider, { toString: () => 'https://chatgpt.com/' }), null)
  assert.equal(safeProviderTargetUrl(provider, null), null)
  assert.throws(
    () => providerWakeUrl('chatgpt', { toString: () => 'https://chatgpt.com/' }),
    /Provider target URL/
  )
  assert.throws(() => providerWakeUrl('chatgpt', null), /Provider target URL/)
})

test('canonical provider targets expose stable conversation and project scopes', async () => {
  const { getProviderById } = await import(extensionProvidersUrl)
  const {
    canonicalProviderTarget,
    canonicalProviderUrl,
    isProviderConversationUrl,
  } = await import(extensionPolicyUrl)
  const chatgpt = getProviderById('chatgpt')
  const claude = getProviderById('claude')
  assert.ok(chatgpt)
  assert.ok(claude)

  const encodedConversation = canonicalProviderTarget(
    chatgpt,
    'https://chatgpt.com/%63/12345678/'
  )
  assert.deepEqual(
    {
      href: encodedConversation?.href,
      pathname: encodedConversation?.pathname,
      scope: encodedConversation?.scope,
    },
    {
      href: 'https://chatgpt.com/c/12345678',
      pathname: '/c/12345678',
      scope: {
        kind: 'conversation',
        key: 'chatgpt:conversation:12345678',
        id: '12345678',
      },
    }
  )

  const chatGptProject = canonicalProviderTarget(
    chatgpt,
    'https://chatgpt.com/g/g-p-12345678/project'
  )
  const chatGptProjectConversation = canonicalProviderTarget(
    chatgpt,
    'https://chatgpt.com/g/g-p-12345678/c/abcdefgh9'
  )
  assert.equal(chatGptProject?.scope.kind, 'project')
  assert.equal(chatGptProjectConversation?.scope.kind, 'project')
  assert.equal(chatGptProject?.scope.key, chatGptProjectConversation?.scope.key)

  const claudeProject = canonicalProviderTarget(
    claude,
    'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002'
  )
  const claudeProjectChat = canonicalProviderTarget(
    claude,
    'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002/chat/abcdefg9'
  )
  assert.equal(claudeProject?.scope.kind, 'project')
  assert.equal(claudeProject?.scope.key, claudeProjectChat?.scope.key)

  for (const target of [
    'https://chatgpt.com/g/g-p-12345678',
    'https://chatgpt.com/g/g-p-12345678/project/files',
    'https://chatgpt.com/g/g-p-12345678/c',
    'https://chatgpt.com/g/g-p-12345678/c/short',
    'https://chatgpt.com/g/g-p-12345678/c/abcdefgh9/files',
    'https://chatgpt.com/g/g-p-12345678/files',
  ]) {
    const unknownProjectRoute = canonicalProviderTarget(chatgpt, target)
    assert.equal(unknownProjectRoute?.scope.kind, 'path', target)
    assert.notEqual(unknownProjectRoute?.scope.key, chatGptProject?.scope.key, target)
  }

  for (const target of [
    'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002/files',
    'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002/chat',
    'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002/chat/short',
    'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002/chat/abcdefg9/files',
  ]) {
    const unknownProjectRoute = canonicalProviderTarget(claude, target)
    assert.equal(unknownProjectRoute?.scope.kind, 'path', target)
    assert.notEqual(unknownProjectRoute?.scope.key, claudeProject?.scope.key, target)
  }

  assert.equal(
    canonicalProviderTarget(chatgpt, 'https://chatgpt.com/c/12345678?model=auto'),
    null
  )
  assert.equal(
    canonicalProviderTarget(claude, 'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002#files'),
    null
  )
  const liveConversationWithPrivateLocationState =
    'https://chatgpt.com/c/12345678?draft=hello%20world#composer'
  assert.equal(isProviderConversationUrl(chatgpt, liveConversationWithPrivateLocationState), true)
  assert.equal(
    canonicalProviderUrl(liveConversationWithPrivateLocationState),
    'https://chatgpt.com/c/12345678'
  )
})

test('provider transitions keep ChatGPT and Claude conversations inside the requested project', async () => {
  const { getProviderById } = await import(extensionProvidersUrl)
  const {
    areProviderTransitionSourcesEquivalent,
    isApprovedProviderTransition,
    isProviderConversationUrl,
    providerTransitionSource,
  } = await import(extensionPolicyUrl)
  const chatgpt = getProviderById('chatgpt')
  const claude = getProviderById('claude')
  assert.ok(chatgpt)
  assert.ok(claude)

  const chatGptProject = 'https://chatgpt.com/g/g-p-12345678/project'
  const chatGptProjectChat = 'https://chatgpt.com/g/g-p-12345678/c/abcdefgh9'
  const anotherChatGptProjectChat = 'https://chatgpt.com/g/g-p-87654321/c/abcdefgh9'
  assert.deepEqual(providerTransitionSource(chatgpt, chatGptProject), {
    kind: 'project',
    customGptId: undefined,
    projectId: 'g-p-12345678',
  })
  assert.equal(isProviderConversationUrl(chatgpt, chatGptProjectChat), true)
  assert.equal(isApprovedProviderTransition(chatgpt, chatGptProject, chatGptProjectChat), true)
  assert.equal(isApprovedProviderTransition(chatgpt, chatGptProject, anotherChatGptProjectChat), false)
  assert.equal(isApprovedProviderTransition(chatgpt, chatGptProject, 'https://chatgpt.com/c/abcdefgh9'), false)
  assert.equal(areProviderTransitionSourcesEquivalent(chatgpt, chatGptProject, chatGptProject), true)

  const claudeProject = 'https://claude.ai/project/123e4567-e89b-12d3-a456-426614174002'
  const claudeProjectChat = `${claudeProject}/chat/abcdefg9`
  const anotherClaudeProjectChat = 'https://claude.ai/project/223e4567-e89b-12d3-a456-426614174002/chat/abcdefg9'
  assert.deepEqual(providerTransitionSource(claude, claudeProject), {
    kind: 'project',
    customGptId: undefined,
    projectId: '123e4567-e89b-12d3-a456-426614174002',
  })
  assert.equal(isProviderConversationUrl(claude, claudeProjectChat), true)
  assert.equal(isApprovedProviderTransition(claude, claudeProject, claudeProjectChat), true)
  assert.equal(isApprovedProviderTransition(claude, claudeProject, anotherClaudeProjectChat), false)
  assert.equal(isApprovedProviderTransition(claude, claudeProject, 'https://claude.ai/chat/abcdefg9'), false)
})
