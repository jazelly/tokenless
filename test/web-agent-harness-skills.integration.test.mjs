import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const harnessModule = '../packages/web-agent-harness/dist/src/index.js'

test('built Harness package prepares the required System Prompt and preselected Skill files through the filesystem', async () => {
  const fixture = await createFixture()
  try {
    const { prepareHarnessSkillRun } = await import(harnessModule)
    const prepared = await prepareHarnessSkillRun({
      runId: 'initial-run',
      stagingRoot: fixture.stagingRoot,
      skillRoot: fixture.skillRoot,
      selectedSkills: [{ name: 'legal-writing', selectedBy: 'explicit_user' }],
      tools: [{
        name: 'mcp.drive.search',
        description: 'Search the configured Drive account.',
        source: 'mcp',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
    })

    assert.deepEqual(prepared.requiredProviderCapabilities, ['conversation.chat', 'file.upload'])
    assert.deepEqual(prepared.registry.skills.map((skill) => skill.name), [
      'document-review',
      'legacy-description',
      'legal-writing',
      'pdf-processing',
    ])
    assert.ok(prepared.registry.diagnostics.some((diagnostic) => (
      diagnostic.candidate === 'invalid-skill' && diagnostic.code === 'description_invalid'
    )))
    assert.equal(prepared.systemPrompt.kind, 'system_prompt')
    assert.equal(prepared.delivery.attachments.length, 1)
    assert.equal(prepared.delivery.attachments[0].skillName, 'legal-writing')
    assert.equal(prepared.delivery.omissions.length, 0)

    const systemPrompt = await fs.readFile(prepared.systemPrompt.sourcePath, 'utf8')
    assert.match(systemPrompt, /<available_skills>/)
    assert.match(systemPrompt, /<name>legal-writing<\/name>/)
    assert.match(systemPrompt, /Review contracts &amp; explain &lt;risk&gt;/)
    assert.match(systemPrompt, /"skillLoads"/)
    assert.match(systemPrompt, /mcp\.drive\.search/)
    assert.equal(systemPrompt.includes(fixture.skillRoot), false)
    assert.equal(systemPrompt.includes('reference-secret-marker'), false)

    const stagedSkill = await fs.readFile(prepared.delivery.attachments[0].sourcePath, 'utf8')
    assert.equal(stagedSkill, fixture.skills.get('legal-writing'))
    assert.match(prepared.promptManifest, /<system_prompt>tokenless-harness-system--/)
    assert.match(prepared.promptManifest, /<name>legal-writing<\/name>/)
  } finally {
    await fixture.cleanup()
  }
})

test('built Harness package parses a complete Skill list and stages successful later additions together', async () => {
  const fixture = await createFixture()
  try {
    const {
      parseHarnessModelResponse,
      prepareHarnessSkillRun,
      prepareHarnessSkillTurn,
    } = await import(harnessModule)
    await prepareHarnessSkillRun({
      runId: 'batched-run',
      stagingRoot: fixture.stagingRoot,
      skillRoot: fixture.skillRoot,
    })

    const response = await parseHarnessModelResponse({
      runId: 'batched-run',
      stagingRoot: fixture.stagingRoot,
      turn: 1,
      nonce: 'nonce-turn-one',
      responseText: framed({
        protocol: 'tokenless.web-agent/v1',
        kind: 'action_batch',
        runId: 'batched-run',
        turn: 1,
        nonce: 'nonce-turn-one',
        skillLoads: ['legal-writing', 'pdf-processing', 'missing-skill'],
        calls: [],
        needs: [
          {
            id: 'need-audience',
            kind: 'user_input',
            prompt: 'Who is the audience?',
            inputSchema: { type: 'string' },
          },
          {
            id: 'need-language',
            kind: 'user_input',
            prompt: 'Which output language?',
            inputSchema: { type: 'string' },
          },
        ],
      }),
    })
    assert.equal(response.kind, 'action_batch')
    assert.deepEqual(response.skillLoads, ['legal-writing', 'pdf-processing', 'missing-skill'])
    assert.equal(response.needs.length, 2)

    const firstTurn = await prepareHarnessSkillTurn({
      runId: 'batched-run',
      stagingRoot: fixture.stagingRoot,
      turn: 1,
      skillLoads: response.skillLoads,
    })
    assert.deepEqual(firstTurn.delivery.attachments.map((attachment) => attachment.skillName), [
      'legal-writing',
      'pdf-processing',
    ])
    assert.deepEqual(firstTurn.delivery.omissions.map(({ name, code }) => ({ name, code })), [{
      name: 'missing-skill',
      code: 'unknown_skill',
    }])
    assert.equal(firstTurn.promptManifest.includes('missing-skill'), false)

    const secondTurn = await prepareHarnessSkillTurn({
      runId: 'batched-run',
      stagingRoot: fixture.stagingRoot,
      turn: 2,
      selectedSkills: [{ name: 'document-review', selectedBy: 'caller_agent' }],
    })
    assert.deepEqual(secondTurn.delivery.attachments.map((attachment) => attachment.skillName), ['document-review'])

    const thirdTurn = await prepareHarnessSkillTurn({
      runId: 'batched-run',
      stagingRoot: fixture.stagingRoot,
      turn: 3,
      skillLoads: ['legal-writing'],
    })
    assert.equal(thirdTurn.delivery.attachments.length, 0)
    assert.equal(thirdTurn.delivery.omissions[0].code, 'already_loaded')
  } finally {
    await fixture.cleanup()
  }
})

test('built Harness package rejects malformed or uncorrelated visible model envelopes before dispatch', async () => {
  const fixture = await createFixture()
  try {
    const {
      HarnessSkillError,
      parseHarnessModelResponse,
      prepareHarnessSkillRun,
    } = await import(harnessModule)
    await prepareHarnessSkillRun({
      runId: 'validation-run',
      stagingRoot: fixture.stagingRoot,
      skillRoot: fixture.skillRoot,
      tools: [{
        name: 'mcp.drive.search',
        description: 'Search Drive.',
        source: 'mcp',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1 } },
          required: ['query'],
          additionalProperties: false,
        },
      }],
      finalOutput: {
        kind: 'json_schema',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
      },
    })

    await assert.rejects(
      parseHarnessModelResponse({
        runId: 'validation-run',
        stagingRoot: fixture.stagingRoot,
        turn: 1,
        nonce: 'nonce-validation',
        responseText: '<TOKENLESS_HARNESS_RESPONSE>{"protocol":"tokenless.web-agent/v1","protocol":"overridden","kind":"final","runId":"validation-run","turn":1,"nonce":"nonce-validation","output":"done","artifacts":[]}</TOKENLESS_HARNESS_RESPONSE>',
      }),
      (error) => error instanceof HarnessSkillError && error.code === 'harness_response_json_invalid',
    )

    await assert.rejects(
      parseHarnessModelResponse({
        runId: 'validation-run',
        stagingRoot: fixture.stagingRoot,
        turn: 1,
        nonce: 'nonce-validation',
        responseText: framed({
          protocol: 'tokenless.web-agent/v1',
          kind: 'final',
          runId: 'validation-run',
          turn: 1,
          nonce: 'stale-nonce',
          output: 'done',
          artifacts: [],
        }),
      }),
      (error) => error instanceof HarnessSkillError && error.code === 'harness_response_correlation_invalid',
    )

    await assert.rejects(
      parseHarnessModelResponse({
        runId: 'validation-run',
        stagingRoot: fixture.stagingRoot,
        turn: 1,
        nonce: 'nonce-validation',
        responseText: framed({
          protocol: 'tokenless.web-agent/v1',
          kind: 'action_batch',
          runId: 'validation-run',
          turn: 1,
          nonce: 'nonce-validation',
          skillLoads: [],
          calls: [{ id: 'call-search', tool: 'mcp.drive.search', arguments: { query: 42 } }],
          needs: [],
        }),
      }),
      (error) => error instanceof HarnessSkillError && error.code === 'harness_json_schema_validation_failed',
    )

    await assert.rejects(
      parseHarnessModelResponse({
        runId: 'validation-run',
        stagingRoot: fixture.stagingRoot,
        turn: 1,
        nonce: 'nonce-validation',
        responseText: framed({
          protocol: 'tokenless.web-agent/v1',
          kind: 'final',
          runId: 'validation-run',
          turn: 1,
          nonce: 'nonce-validation',
          output: '{"answer":42}',
          artifacts: [],
        }),
      }),
      (error) => error instanceof HarnessSkillError && error.code === 'harness_json_schema_validation_failed',
    )

    await assert.rejects(
      parseHarnessModelResponse({
        runId: 'validation-run',
        stagingRoot: fixture.stagingRoot,
        turn: 1,
        nonce: 'nonce-validation',
        responseText: framed({
          protocol: 'tokenless.web-agent/v1',
          kind: 'action_batch',
          runId: 'validation-run',
          turn: 1,
          nonce: 'nonce-validation',
          skillLoads: [],
          calls: [],
          needs: [{
            id: 'need-invalid-schema',
            kind: 'user_input',
            prompt: 'What should be used?',
            inputSchema: { type: 'not-a-json-schema-type' },
          }],
        }),
      }),
      (error) => error instanceof HarnessSkillError && error.code === 'harness_json_schema_invalid',
    )

    const final = await parseHarnessModelResponse({
      runId: 'validation-run',
      stagingRoot: fixture.stagingRoot,
      turn: 1,
      nonce: 'nonce-validation',
      responseText: framed({
        protocol: 'tokenless.web-agent/v1',
        kind: 'final',
        runId: 'validation-run',
        turn: 1,
        nonce: 'nonce-validation',
        output: '{"answer":"done"}',
        artifacts: [],
      }),
    })
    assert.equal(final.kind, 'final')
  } finally {
    await fixture.cleanup()
  }
})

test('built Harness package softly omits unsafe and over-limit Skill files', async () => {
  const fixture = await createFixture()
  try {
    const { prepareHarnessSkillRun } = await import(harnessModule)
    const external = path.join(fixture.root, 'external.md')
    await fs.writeFile(external, skill('linked-skill', 'Unsafe linked Skill.', 'Do not load.'))
    await fs.mkdir(path.join(fixture.skillRoot, 'linked-skill'))
    await fs.symlink(external, path.join(fixture.skillRoot, 'linked-skill', 'SKILL.md'))

    const prepared = await prepareHarnessSkillRun({
      runId: 'soft-run',
      stagingRoot: fixture.stagingRoot,
      skillRoot: fixture.skillRoot,
      selectedSkills: [
        { name: 'linked-skill', selectedBy: 'explicit_user' },
        { name: 'pdf-processing', selectedBy: 'explicit_user' },
      ],
      limits: { maxSkillFileBytes: 140 },
    })
    assert.equal(prepared.delivery.attachments.length, 0)
    assert.ok(prepared.registry.diagnostics.some((diagnostic) => (
      diagnostic.candidate === 'linked-skill' && diagnostic.code === 'skill_file_unsafe'
    )))
    assert.ok(prepared.registry.diagnostics.some((diagnostic) => (
      diagnostic.candidate === 'pdf-processing' && diagnostic.code === 'skill_file_too_large'
    )))
    assert.deepEqual(prepared.delivery.omissions.map((omission) => omission.code), [
      'unknown_skill',
      'unknown_skill',
    ])
  } finally {
    await fixture.cleanup()
  }
})

function framed(value) {
  return `<TOKENLESS_HARNESS_RESPONSE>\n${JSON.stringify(value)}\n</TOKENLESS_HARNESS_RESPONSE>`
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-harness-skills-'))
  const skillRoot = path.join(root, 'skills')
  const stagingRoot = path.join(root, 'staging')
  await fs.mkdir(skillRoot)
  const skills = new Map([
    ['legal-writing', skill(
      'legal-writing',
      'Review contracts & explain <risk>.',
      '# Legal Writing\n\nReview the complete document before suggesting revisions.',
    )],
    ['pdf-processing', skill(
      'pdf-processing',
      'Extract and analyze PDF documents.',
      `# PDF Processing\n\n${'Read the PDF carefully. '.repeat(12)}`,
    )],
    ['document-review', [
      '---',
      'name: document-review',
      'description: >-',
      '  Review documents and return',
      '  a consolidated issue list.',
      '---',
      '# Document Review',
      '',
      'Return all known issues together.',
      '',
    ].join('\n')],
    ['invalid-skill', ['---', 'name: invalid-skill', 'description: ""', '---', '# Invalid', ''].join('\n')],
    ['legacy-description', [
      '---',
      'name: legacy-description',
      'description: Use this Skill when: the user needs compatibility.',
      '---',
      '# Legacy Description',
      '',
      'This common invalid YAML form is accepted for compatibility.',
      '',
    ].join('\n')],
  ])
  for (const [name, content] of skills) {
    const directory = path.join(skillRoot, name)
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'SKILL.md'), content)
    if (name === 'legal-writing') {
      const references = path.join(directory, 'references')
      await fs.mkdir(references)
      await fs.writeFile(path.join(references, 'SECRET.md'), 'reference-secret-marker')
      await fs.chmod(references, 0o000)
    }
  }
  return {
    root,
    skillRoot,
    stagingRoot,
    skills,
    async cleanup() {
      await fs.chmod(path.join(skillRoot, 'legal-writing', 'references'), 0o700).catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function skill(name, description, body) {
  return ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, '---', body, ''].join('\n')
}
