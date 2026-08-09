import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliEntry = path.join(repositoryRoot, 'packages/cli/dist/src/tokenless.mjs')

test('built prompt context distinguishes inline files from separately supplied visible attachments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-prompt-attachments-'))
  const runtime = await import('../packages/cli/dist/src/index.js')
  const playwright = await import('../packages/cli/dist/src/playwright/index.js')
  const attachmentNames = ['private-plan.md', 'private-data.csv', 'private-notes.txt']

  try {
    const inlinePath = path.join(root, 'inline.txt')
    await fs.writeFile(inlinePath, 'Inline evidence.\n')
    for (const name of attachmentNames) {
      await fs.writeFile(path.join(root, name), `Physical evidence from ${name}.\n`)
    }

    const help = runPrompt(['prompt', '--help'], root)
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stderr, /--attach-file <path>/)

    const noFilesResult = runPrompt([
      'prompt',
      '--prompt', 'Summarize the evidence.',
      '--project-root', root,
    ], root)
    assert.equal(noFilesResult.status, 0, noFilesResult.stderr)
    const noFilesPrompt = noFilesResult.stdout.trimEnd()
    assert.match(noFilesPrompt, /## Relevant Files\nNo relevant files were attached\.$/)

    const physicalResult = runPrompt([
      'prompt',
      '--prompt', 'Summarize the evidence.',
      '--project-root', root,
      ...attachmentNames.flatMap((name) => ['--attach-file', path.join(root, name)]),
    ], root)
    assert.equal(physicalResult.status, 0, physicalResult.stderr)
    const physicalPrompt = physicalResult.stdout.trimEnd()
    assert.match(
      physicalPrompt,
      /## Relevant Files\nRelevant documents will be supplied separately as visible attachments\.$/,
    )
    assert.doesNotMatch(physicalPrompt, /No relevant files were attached\./)
    for (const name of attachmentNames) assert.doesNotMatch(physicalPrompt, new RegExp(name))

    const localizedPhysicalPrompt = await runtime.buildTokenlessPrompt({
      userPrompt: '总结证据。',
      projectRoot: root,
      hasVisibleAttachments: true,
      responseLanguage: 'zh-CN',
    })
    assert.match(localizedPhysicalPrompt, /## Relevant Files\n相关文档将另行作为可见附件提供。$/)

    const inlineResult = runPrompt([
      'prompt',
      '--prompt', 'Summarize the evidence.',
      '--project-root', root,
      '--file', 'inline.txt',
      '--attach-file', path.join(root, attachmentNames[0]),
    ], root)
    assert.equal(inlineResult.status, 0, inlineResult.stderr)
    const inlinePrompt = inlineResult.stdout.trimEnd()
    assert.match(inlinePrompt, /### inline\.txt\n```\nInline evidence\.\n```$/)
    assert.doesNotMatch(inlinePrompt, /visible attachments|No relevant files were attached\./)

    const attachments = await runtime.stageVisibleAttachments({
      homeDir: root,
      files: attachmentNames.map((name) => ({
        sourcePath: path.join(root, name),
        type: name.endsWith('.csv') ? 'text/csv' : 'text/plain',
      })),
    })
    const request = playwright.createManagedPlaywrightJobRequest({
      provider: 'chatgpt',
      taskId: 'visible-attachment-prompt',
      actions: [
        playwright.createVisibleActionRequest({
          requestId: 'visible-attachment-prompt:files',
          provider: 'chatgpt',
          action: playwright.VISIBLE_ACTIONS.FILE_UPLOAD,
          payload: { attachments },
        }),
        playwright.createVisibleActionRequest({
          requestId: 'visible-attachment-prompt:prompt',
          provider: 'chatgpt',
          action: playwright.VISIBLE_ACTIONS.PROMPT_INPUT,
          payload: { text: physicalPrompt },
        }),
      ],
    })

    assert.equal(request.context.references.length, 3)
    assert.deepEqual(
      request.context.references.map((reference) => reference.attachmentId),
      attachments.map((attachment) => attachment.attachmentId),
    )
    assert.deepEqual(request.context.delivery.promptActions, [{
      requestId: 'visible-attachment-prompt:prompt',
      sha256: createHash('sha256').update(physicalPrompt, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(physicalPrompt, 'utf8'),
    }])
    assert.notEqual(
      request.context.delivery.promptActions[0].sha256,
      createHash('sha256').update(noFilesPrompt, 'utf8').digest('hex'),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function runPrompt(args, homeDir) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKENLESS_HOME: homeDir,
    },
  })
}
