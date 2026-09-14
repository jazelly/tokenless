import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'

if (process.env.TOKENLESS_LIVE_AGNES_GATE !== '1') {
  throw new Error('Set TOKENLESS_LIVE_AGNES_GATE=1 to submit real Agnes Chat messages and attachments.')
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = await resolveTestConfig()
const env = { ...process.env }
for (const name of Object.keys(env)) {
  if (name === 'CODEX_THREAD_ID' || name.startsWith('TOKENLESS_AGENT_')) delete env[name]
}

test('Agnes built CLI closes Chat, Markdown/image input, and durable continuation', { timeout: 600_000 }, async () => {
  const id = randomUUID().replaceAll('-', '')
  const taskId = `agnes-acceptance-${id}`
  const chatProof = `AGNES_CHAT_${id}`
  const documentProof = `AGNES_DOCUMENT_${id}`
  const file = path.join(root, 'test-results', 'live-provider-inputs', `agnes-${id}.md`)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `# Agnes Markdown input\n\nProof value: ${documentProof}\n`, { mode: 0o600 })
  const jobs = []

  function run(args, expected) {
    const payload = JSON.parse(execFileSync(process.execPath, [
      path.join(root, 'packages/cli/dist/src/tokenless.mjs'), 'run',
      '--home', target.homeDir, '--profile', target.profile.slug,
      '--provider', 'agnes', '--execution-mode', 'browser',
      '--task-id', taskId, '--page-ref', 'p1', '--timeout-ms', '180000', '--json', ...args,
    ], { cwd: root, env, encoding: 'utf8', timeout: 210_000, stdio: ['ignore', 'pipe', 'pipe'] }))
    assert.equal(payload.ok, true)
    assert.equal(payload.status, 'succeeded')
    const responses = payload.result.result.responses
    assert.ok(responses.some((response) => response.action === 'prompt.submit' && response.result.submissionProof === 'visible-submission-transition'))
    const answer = responses.findLast((response) => response.action === 'response.read')
    if (expected instanceof RegExp) assert.match(answer.result.text.trim(), expected)
    else assert.equal(answer.result.text.trim(), expected)
    jobs.push(payload.jobId)
    return responses
  }

  run(['--prompt', `Reply with exactly ${chatProof}. Do not use tools or apps.`], chatProof)
  const uploaded = run(['--attach-file', file, '--prompt', 'Read the attached document. Reply with exactly its Proof value. Do not use tools or apps.'], documentProof)
  assert.equal(uploaded.find((response) => response.action === 'file.upload').result.acceptance, 'accepted')
  run(['--workspace-mode', 'conversation', '--project-name', taskId, '--capability', 'conversation.continue', '--prompt', 'Return the exact marker from your first answer in this conversation, not the document proof. Reply with only that marker.'], chatProof)
  run(['--attach-file', path.join(root, 'assets/tokenless-mark.png'), '--prompt', 'What is the dominant color of the icon in the attached image? Reply with only the color name in English. Do not use tools or apps.'], /^black[.!]?$/i)
  const sourced = run(['--capability', 'response.citations', '--prompt', 'Use web search to find the official Agnes AI API Token Plan FAQ. Summarize only its Free API RPM and include a clickable official GitHub FAQ link. Do not confuse API and consumer Web credits.'], /(?:20|30)/)
  assert.ok(sourced.findLast((response) => response.action === 'response.read').result.citations.some((citation) => citation.href === 'https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/docs/TOKEN_PLAN_FAQ.md'))

  const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const mapping = database.prepare('SELECT canonical_url FROM provider_task_conversations WHERE provider = ? AND profile_id = ? AND task_id = ?').get('agnes', target.profile.slug, taskId)
    assert.match(mapping?.canonical_url ?? '', /^https:\/\/app\.agnes-ai\.com\/\?conversationId=\d{1,30}$/)
    const facts = jobs.map((jobId) => database.prepare('SELECT status, provider_submitted_at FROM jobs WHERE job_id = ?').get(jobId))
    assert.ok(facts.every((fact) => fact.status === 'succeeded' && fact.provider_submitted_at !== null))
  } finally {
    database.close()
  }
  console.log(JSON.stringify({ cases: ['agnes-chat-roundtrip', 'agnes-document-roundtrip', 'agnes-image-roundtrip', 'agnes-citation-roundtrip'], profileId: target.profile.slug, jobs, submissions: jobs.length, markdownTransport: 'unchanged_bytes_with_txt_name', durableConversation: true }))
})
