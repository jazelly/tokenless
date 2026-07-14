import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const adminUrl = new URL('../packages/cli/dist/src/direct/codex-account-admin.js', import.meta.url)
const executorUrl = new URL('../packages/cli/dist/src/direct/managed-codex-executor.js', import.meta.url)
const posixOnly = process.platform === 'win32' ? 'managed Codex inference is POSIX-only' : false

const REQUIRED_DISABLED_FEATURES = [
  'apps', 'auth_elicitation', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'code_mode', 'code_mode_host', 'code_mode_only', 'computer_use', 'deferred_executor', 'enable_fanout',
  'enable_mcp_apps', 'exec_permission_approvals', 'guardian_approval', 'hooks', 'image_generation',
  'imagegenext', 'in_app_browser', 'js_repl', 'js_repl_tools_only', 'memories', 'multi_agent',
  'multi_agent_v2', 'plugin_sharing', 'plugins', 'remote_plugin', 'request_permissions_tool',
  'respect_system_proxy', 'search_tool', 'shell_snapshot', 'shell_tool', 'skill_mcp_dependency_install',
  'standalone_web_search', 'tool_call_mcp_elicitation', 'tool_suggest', 'unified_exec',
  'workspace_dependencies',
]

test('managed projects stay on isolated profiles and subscription inference is globally single-flight', { skip: posixOnly }, async () => {
  const fixture = await createFixture()
  try {
    const executionA = await fixture.execution('Project-A', 'delay:180 A')
    const executionB = await fixture.execution('Project-B', 'delay:180 B')
    const [answerA, answerB] = await Promise.all([
      fixture.executor(executionA),
      fixture.executor(executionB),
    ])

    assert.equal(answerA, 'answer:account-a@example.test')
    assert.equal(answerB, 'answer:account-b@example.test')
    const trace = await fixture.trace()
    const actual = trace.filter((entry) => entry.kind === 'actual')
    assert.equal(actual.length, 2)
    assert.deepEqual(new Set(actual.map((entry) => entry.codexHome)), new Set([
      fixture.codexHomes.get('account-a'),
      fixture.codexHomes.get('account-b'),
    ]))
    assert.deepEqual(actual.map((entry) => entry.prompt).sort(), ['delay:180 A', 'delay:180 B'])
    assert.equal(trace.some((entry) => entry.kind === 'overlap'), false)
    for (const entry of actual) {
      assert.equal(entry.execServer, 'none')
      assert.equal(entry.fileCredentials, true)
      assert.equal(entry.ignoreUserConfig, true)
      assert.equal(entry.ignoreRules, true)
      assert.equal(entry.detachedFromWorkspace, true)
    }
    assert.equal((await fixture.resolve('Project-A')).account.accountId, 'account-a')
    assert.equal((await fixture.resolve('Project-B')).account.accountId, 'account-b')
  } finally {
    await fixture.close()
  }
})

test('disabled, changed binding, and structured identity mismatch fail before prompt dispatch', { skip: posixOnly }, async () => {
  const fixture = await createFixture()
  try {
    const disabled = await fixture.execution('Project-A', 'must-not-dispatch disabled')
    await fixture.store.disableAccount({ provider: 'chatgpt', accountId: 'account-a' })
    await assertPreDispatchUnavailable(fixture.executor(disabled))
    assert.equal((await fixture.actualPrompts()).length, 0)

    await fixture.store.enableAccount({ provider: 'chatgpt', accountId: 'account-a' })
    const changed = await fixture.execution('Project-A', 'must-not-dispatch changed')
    await fixture.store.pinProject({ projectId: 'Project-A', provider: 'chatgpt', accountId: 'account-b' })
    await assertPreDispatchUnavailable(fixture.executor(changed))
    assert.equal((await fixture.actualPrompts()).length, 0)

    await fixture.store.pinProject({ projectId: 'Project-A', provider: 'chatgpt', accountId: 'account-a' })
    const mismatch = await fixture.execution('Project-A', 'must-not-dispatch identity')
    await fs.writeFile(
      path.join(fixture.codexHomes.get('account-a'), 'auth.json'),
      `${JSON.stringify({ email: 'replacement@example.test' })}\n`,
      { mode: 0o600 },
    )
    await assertPreDispatchUnavailable(fixture.executor(mismatch))
    assert.equal((await fixture.actualPrompts()).length, 0)
    assert.equal((await fixture.resolve('Project-A')).account.accountId, 'account-a')

    await fs.writeFile(
      path.join(fixture.codexHomes.get('account-a'), 'auth.json'),
      `${JSON.stringify({ email: 'account-a@example.test' })}\n`,
      { mode: 0o600 },
    )
    await fs.writeFile(fixture.capabilityFailurePath, 'fail')
    await assert.rejects(
      fixture.executor(await fixture.execution('Project-A', 'must-not-dispatch capability')),
      (error) => error.code === 'managed_executor_failed' && error.deliveryUnknown === false,
    )
    assert.equal((await fixture.actualPrompts()).length, 0)
  } finally {
    await fixture.close()
  }
})

test('post-dispatch nonzero, timeout, abort, and helper loss are delivery-unknown and never replay', { skip: posixOnly }, async () => {
  const fixture = await createFixture({ inferenceTimeoutMs: 700 })
  try {
    const initialBinding = (await fixture.resolve('Project-A')).binding

    await assertPostDispatchFailure(fixture.executor(await fixture.execution('Project-A', 'nonzero')))
    assert.equal((await fixture.actualPrompts()).filter((prompt) => prompt === 'nonzero').length, 1)

    await assert.rejects(
      fixture.executor(await fixture.execution('Project-A', 'hang-timeout')),
      (error) => error.code === 'managed_executor_timeout' && error.deliveryUnknown === true,
    )
    assert.equal((await fixture.actualPrompts()).filter((prompt) => prompt === 'hang-timeout').length, 1)

    const controller = new AbortController()
    const abortExecution = await fixture.execution('Project-A', 'hang-abort', controller.signal)
    const aborting = fixture.executor(abortExecution)
    await waitFor(async () => (await fixture.actualPrompts()).includes('hang-abort'))
    controller.abort()
    await assert.rejects(
      aborting,
      (error) => error.code === 'managed_executor_aborted' && error.deliveryUnknown === true,
    )
    assert.equal((await fixture.actualPrompts()).filter((prompt) => prompt === 'hang-abort').length, 1)

    await assertPostDispatchFailure(fixture.executor(await fixture.execution('Project-A', 'crash-helper')))
    assert.equal((await fixture.actualPrompts()).filter((prompt) => prompt === 'crash-helper').length, 1)

    const finalBinding = (await fixture.resolve('Project-A')).binding
    assert.equal(finalBinding.accountInternalId, initialBinding.accountInternalId)
    assert.equal(finalBinding.generation, initialBinding.generation)
  } finally {
    await fixture.close()
  }
})

async function createFixture(options = {}) {
  const homeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-managed-inference-')))
  await fs.chmod(homeDir, 0o700)
  const tracePath = path.join(homeDir, 'trace.jsonl')
  const activePath = path.join(homeDir, 'active-inference')
  const capabilityFailurePath = path.join(homeDir, 'fail-capability')
  const executable = path.join(homeDir, 'fake-codex')
  await fs.writeFile(tracePath, '')
  await fs.writeFile(
    executable,
    fakeCodexSource({ tracePath, activePath, capabilityFailurePath, homeDir }),
    { mode: 0o755 },
  )

  const {
    addManagedCodexAccount,
    createManagedAccountPoolStore,
    loginManagedCodexAccount,
  } = await import(adminUrl.href)
  const store = createManagedAccountPoolStore({ homeDir, lockTimeoutMs: 5_000 })
  const codexHomes = new Map()
  for (const [accountId, email] of [
    ['account-a', 'account-a@example.test'],
    ['account-b', 'account-b@example.test'],
  ]) {
    const pending = await addManagedCodexAccount({ accountId }, { homeDir, codexExecutable: executable })
    const codexHome = path.join(homeDir, 'direct', 'provider-profiles', 'chatgpt', pending.internalId, 'codex')
    await fs.writeFile(path.join(codexHome, 'auth.json'), `${JSON.stringify({ email })}\n`, { mode: 0o600 })
    await loginManagedCodexAccount(accountId, { homeDir, codexExecutable: executable })
    codexHomes.set(accountId, codexHome)
  }
  await store.pinProject({ projectId: 'Project-A', provider: 'chatgpt', accountId: 'account-a' })
  await store.pinProject({ projectId: 'Project-B', provider: 'chatgpt', accountId: 'account-b' })

  const { createManagedCodexProjectExecutor } = await import(executorUrl.href)
  const executor = createManagedCodexProjectExecutor({
    codexExecutable: executable,
    lockTimeoutMs: 5_000,
    accountReadTimeoutMs: 2_000,
    inferenceTimeoutMs: options.inferenceTimeoutMs ?? 5_000,
  })
  const resolve = (projectId) => store.resolve({ projectId, provider: 'chatgpt' })
  return {
    homeDir,
    store,
    executor,
    codexHomes,
    capabilityFailurePath,
    resolve,
    async execution(projectId, input, signal = new AbortController().signal) {
      const resolution = await resolve(projectId)
      return {
        homeDir,
        projectId,
        initialBinding: resolution.binding,
        initialAccount: resolution.account,
        request: Object.freeze({ input, stream: false, store: false }),
        signal,
      }
    },
    async trace() {
      const text = await fs.readFile(tracePath, 'utf8')
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
    async actualPrompts() {
      return (await this.trace()).filter((entry) => entry.kind === 'actual').map((entry) => entry.prompt)
    },
    close: () => fs.rm(homeDir, { recursive: true, force: true }),
  }
}

function fakeCodexSource({ tracePath, activePath, capabilityFailurePath, homeDir }) {
  return `#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'
const argv=process.argv.slice(2)
const tracePath=${JSON.stringify(tracePath)}
const activePath=${JSON.stringify(activePath)}
const capabilityFailurePath=${JSON.stringify(capabilityFailurePath)}
const managedRoot=${JSON.stringify(homeDir)}
const trace=(entry)=>fs.appendFileSync(tracePath,JSON.stringify(entry)+'\\n')
if(argv[0]==='app-server'){
  const rl=readline.createInterface({input:process.stdin})
  rl.on('line',(line)=>{
    const message=JSON.parse(line)
    if(message.id===0) process.stdout.write(JSON.stringify({id:0,result:{userAgent:'fake'}})+'\\n')
    if(message.method==='account/read'){
      const authPath=path.join(process.env.CODEX_HOME,'auth.json')
      const account=fs.existsSync(authPath)?{type:'chatgpt',email:JSON.parse(fs.readFileSync(authPath,'utf8')).email,planType:'plus'}:null
      trace({kind:'account-read',codexHome:process.env.CODEX_HOME})
      process.stdout.write(JSON.stringify({id:1,result:{account,requiresOpenaiAuth:true}})+'\\n')
    }
  })
} else if(argv[0]==='exec'&&argv[1]==='--help'){
  if(fs.existsSync(capabilityFailurePath)) process.exitCode=9
  else process.stdout.write('--config --disable --strict-config --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --color never --json --output-last-message --model\\n')
} else if(argv[0]==='features'&&argv[1]==='list'){
  process.stdout.write(${JSON.stringify(REQUIRED_DISABLED_FEATURES.map((feature) => `${feature} stable true`).join('\n') + '\n')})
} else if(argv[0]==='sandbox'&&argv[1]==='--help'){
  process.stdout.write('--config --permission-profile --cd\\n')
} else if(argv[0]==='sandbox'){
  process.stderr.write('Permission denied by sandbox\\n')
  process.exitCode=1
} else if(argv[0]==='exec'&&argv.some((value)=>value.includes('model_provider="tokenless_probe"'))){
  const config=argv.find((value)=>value.includes('model_providers.tokenless_probe='))
  const baseUrl=/base_url="([^"]+)"/.exec(config)[1]
  const target=new URL(baseUrl+'/responses')
  await new Promise((resolve,reject)=>{
    const request=http.request(target,{method:'POST',headers:{authorization:'Bearer '+process.env.TOKENLESS_PROBE_API_KEY,'content-type':'application/json'}},(response)=>{
      response.resume();response.once('end',resolve)
    })
    request.once('error',reject)
    request.end(JSON.stringify({tools:[{type:'function',name:'update_plan'}]}))
  })
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0,total_tokens:0}})+'\\n')
} else if(argv[0]==='exec'){
  let prompt=''
  for await(const chunk of process.stdin) prompt+=chunk.toString('utf8')
  const outputPath=argv[argv.indexOf('--output-last-message')+1]
  const auth=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'utf8'))
  let overlap=false
  try{fs.mkdirSync(activePath)}catch{overlap=true;trace({kind:'overlap',prompt})}
  trace({
    kind:'actual',prompt,codexHome:process.env.CODEX_HOME,execServer:process.env.CODEX_EXEC_SERVER_URL,
    fileCredentials:argv.includes('cli_auth_credentials_store="file"'),
    ignoreUserConfig:argv.includes('--ignore-user-config'),ignoreRules:argv.includes('--ignore-rules'),
    detachedFromWorkspace:path.basename(process.cwd())==='workspace'&&!process.cwd().startsWith(managedRoot),
  })
  const cleanup=()=>{if(!overlap)try{fs.rmdirSync(activePath)}catch{}}
  process.on('exit',cleanup)
  if(prompt==='nonzero'){process.exitCode=7}
  else if(prompt==='crash-helper'){
    process.kill(process.ppid,'SIGKILL')
    await new Promise((resolve)=>setTimeout(resolve,120))
  } else if(prompt.startsWith('hang-')){
    await new Promise((resolve)=>setInterval(resolve,60_000))
  } else {
    const delay=Number(/^delay:(\\d+)/.exec(prompt)?.[1]??0)
    if(delay>0) await new Promise((resolve)=>setTimeout(resolve,delay))
    fs.writeFileSync(outputPath,'answer:'+auth.email)
    process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2,total_tokens:5}})+'\\n')
  }
}
`
}

async function assertPreDispatchUnavailable(operation) {
  await assert.rejects(
    operation,
    (error) => error.code === 'managed_executor_unavailable' && error.deliveryUnknown === false,
  )
}

async function assertPostDispatchFailure(operation) {
  await assert.rejects(
    operation,
    (error) => error.code === 'managed_executor_failed' && error.deliveryUnknown === true,
  )
}

async function waitFor(operation, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await operation()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for managed inference fixture state.')
}
