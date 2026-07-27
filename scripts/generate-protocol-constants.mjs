#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = path.join(root, 'protocol/registry.json')
const registrySchemaPath = path.join(root, 'protocol/registry.schema.json')
const tsOutputPath = path.join(root, 'packages/cli/src/generated/protocol-constants.ts')
const jsOutputPath = path.join(root, 'scripts/generated/protocol-constants.mjs')
const REGISTRY_PROTOCOL = 'tokenless.protocol-registry.v1'
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])
const check = process.argv.includes('--check')

const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'))
const registrySchema = JSON.parse(await fs.readFile(registrySchemaPath, 'utf8'))
validateRegistrySchema(registry, registrySchema)
validateRegistry(registry)
await validateArtifacts(registry)

const tsConstants = collectConstants(registry, 'typescript')
const jsConstants = collectConstants(registry, 'javascript')

const outputs = [
  [tsOutputPath, renderTypeScript(registry.generatedHeader, tsConstants)],
  [jsOutputPath, renderJavaScript(registry.generatedHeader, jsConstants)],
]

let stale = false
for (const [outputPath, content] of outputs) {
  if (check) {
    let existing = ''
    try {
      existing = await fs.readFile(outputPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (existing !== content) {
      stale = true
      console.error(`${path.relative(root, outputPath)} is stale; run npm run protocol:generate`)
    }
  } else {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, content)
  }
}

if (stale) process.exit(1)

function validateRegistrySchema(registry, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const validate = ajv.compile(schema)
  if (!validate(registry)) {
    throw new Error(`protocol registry schema validation failed: ${ajv.errorsText(validate.errors, { separator: '; ' })}`)
  }
}

function validateRegistry(value) {
  if (!isRecord(value)) throw new Error('protocol registry must be an object')
  if (value.registryProtocol !== REGISTRY_PROTOCOL) {
    throw new Error('protocol registry has an unsupported registryProtocol')
  }
  if (typeof value.generatedHeader !== 'string' || !value.generatedHeader.trim()) {
    throw new Error('protocol registry must include generatedHeader')
  }
  if (!Array.isArray(value.protocols) || value.protocols.length === 0) {
    throw new Error('protocol registry must include protocols')
  }

  validateCanonicalDaemonWireApi(value.protocols)

  const ids = new Set()
  const constants = {
    typescript: new Set(),
    javascript: new Set(),
  }
  for (const protocol of value.protocols) {
    if (!isRecord(protocol)) throw new Error('protocol entry must be an object')
    requireString(protocol, 'id')
    requireString(protocol, 'owner')
    requireString(protocol, 'status')
    requireString(protocol, 'category')
    requireStringArray(protocol, 'accepts')
    requireStringArray(protocol, 'emits')
    if (ids.has(protocol.id)) throw new Error(`duplicate protocol id ${protocol.id}`)
    if (protocol.id === REGISTRY_PROTOCOL) {
      throw new Error(`${REGISTRY_PROTOCOL} is the generator bootstrap protocol and must not be a registry entry`)
    }
    ids.add(protocol.id)
    if (!/^tokenless\.[a-z0-9.-]+\.v\d+$/.test(protocol.id)) {
      throw new Error(`protocol id is not versioned: ${protocol.id}`)
    }
    if (!isRecord(protocol.constants)) throw new Error(`${protocol.id} must include constants`)
    for (const language of Object.keys(constants)) {
      const constantName = protocol.constants[language]
      if (constantName === undefined) continue
      validateConstantName(language, constantName)
      if (constants[language].has(constantName)) throw new Error(`duplicate ${language} constant ${constantName}`)
      constants[language].add(constantName)
    }
    if (protocol.aliases !== undefined) {
      if (!isRecord(protocol.aliases)) throw new Error(`${protocol.id} aliases must be an object`)
      for (const [language, aliases] of Object.entries(protocol.aliases)) {
        if (!Object.hasOwn(constants, language)) continue
        if (!Array.isArray(aliases)) throw new Error(`${protocol.id} ${language} aliases must be an array`)
        for (const alias of aliases) {
          validateConstantName(language, alias)
          if (constants[language].has(alias)) throw new Error(`duplicate ${language} constant ${alias}`)
          constants[language].add(alias)
        }
      }
    }
    if (protocol.artifacts !== undefined) requireStringArray(protocol, 'artifacts')
    if (protocol.plannedArtifacts !== undefined) requireStringArray(protocol, 'plannedArtifacts')
    const artifacts = new Set(protocol.artifacts ?? [])
    for (const plannedArtifact of protocol.plannedArtifacts ?? []) {
      if (artifacts.has(plannedArtifact)) {
        throw new Error(`${protocol.id} cannot list ${plannedArtifact} as both implemented and planned`)
      }
    }
  }
}

function validateCanonicalDaemonWireApi(protocols) {
  const ids = protocols
    .filter((protocol) => protocol.category === 'wire-api' && protocol.status === 'active')
    .map((protocol) => protocol.id)
  if (ids.length !== 1 || ids[0] !== 'tokenless.daemon.v1') {
    throw new Error('tokenless.daemon.v1 must be the only active wire-api protocol')
  }
}

async function validateArtifacts(registry) {
  const artifactPaths = [...new Set(registry.protocols.flatMap((protocol) => protocol.artifacts ?? []))].sort()
  const schemaArtifacts = []
  const openApiArtifacts = []
  for (const artifactPath of artifactPaths) {
    if (!artifactPath.startsWith('protocol/')) {
      throw new Error(`implemented artifact must stay under protocol/: ${artifactPath}`)
    }
    const absolutePath = path.join(root, artifactPath)
    let content
    try {
      content = await fs.readFile(absolutePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`implemented artifact does not exist: ${artifactPath}`)
      }
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new Error(`implemented artifact is not valid JSON: ${artifactPath}: ${error.message}`)
    }
    if (artifactPath.endsWith('.schema.json')) {
      schemaArtifacts.push({ artifactPath, parsed })
    } else if (artifactPath.endsWith('.openapi.json')) {
      openApiArtifacts.push({ artifactPath, parsed })
    } else {
      throw new Error(`implemented artifact type is unsupported: ${artifactPath}`)
    }
  }

  validateJsonSchemaArtifacts(schemaArtifacts)
  for (const artifact of openApiArtifacts) await validateOpenApiArtifact(artifact)
}

function validateJsonSchemaArtifacts(schemaArtifacts) {
  const ajv = newAjv()
  for (const { artifactPath, parsed } of schemaArtifacts) {
    if (parsed.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      throw new Error(`${artifactPath} must declare draft 2020-12`)
    }
    if (typeof parsed.$id !== 'string' || !parsed.$id.startsWith('https://tokenless.dev/protocol/')) {
      throw new Error(`${artifactPath} must declare a tokenless.dev protocol $id`)
    }
    ajv.addSchema(parsed)
  }
  for (const { artifactPath, parsed } of schemaArtifacts) {
    try {
      ajv.compile(parsed)
    } catch (error) {
      throw new Error(`${artifactPath} is not a valid JSON Schema: ${error.message}`)
    }
  }
  validateJsonSchemaFixtures(ajv)
}

function validateJsonSchemaFixtures(ajv) {
  const jobV2 = ajv.getSchema('https://tokenless.dev/protocol/schemas/playwright-job.v2.schema.json')
  if (!jobV2) throw new Error('playwright-job.v2 fixture schema is not registered')
  const multibyteOverLimitJob = {
    protocol: 'tokenless.playwright.job.v2',
    provider: 'chatgpt',
    target: { kind: 'provider_home', url: 'https://chatgpt.com/' },
    taskId: '你'.repeat(86),
    browserVisibility: 'auto',
    actions: [
      {
        protocol: 'tokenless.playwright.visible-action.v2',
        requestId: 'fixture-1',
        provider: 'chatgpt',
        action: 'auth.status',
        payload: {},
      },
    ],
  }
  if (jobV2(multibyteOverLimitJob)) {
    throw new Error('playwright-job.v2 fixture must reject taskId values over 256 UTF-8 bytes')
  }
  const targetInvariantCases = [
    ['provider host mismatch', { provider: 'claude', target: { kind: 'provider_home', url: 'https://chatgpt.com/' } }],
    ['target credentials', { provider: 'chatgpt', target: { kind: 'provider_home', url: 'https://user@chatgpt.com/' } }],
    ['target query', { provider: 'chatgpt', target: { kind: 'provider_home', url: 'https://chatgpt.com/?q=1' } }],
    ['target fragment', { provider: 'chatgpt', target: { kind: 'provider_home', url: 'https://chatgpt.com/#frag' } }],
  ]
  for (const [name, override] of targetInvariantCases) {
    const invalidJob = {
      ...multibyteOverLimitJob,
      taskId: null,
      ...override,
    }
    if (jobV2(invalidJob)) {
      throw new Error(`playwright-job.v2 fixture must reject ${name}`)
    }
  }

  const actionV2 = ajv.getSchema('https://tokenless.dev/protocol/schemas/visible-action.v2.schema.json')
  if (!actionV2) throw new Error('visible-action.v2 fixture schema is not registered')
  const controlCharacterLabel = {
    protocol: 'tokenless.playwright.visible-action.v2',
    requestId: 'fixture-2',
    provider: 'chatgpt',
    action: 'model.select',
    payload: { label: 'bad\u0007label' },
  }
  if (actionV2(controlCharacterLabel)) {
    throw new Error('visible-action.v2 fixture must reject C0/DEL characters in selection labels')
  }

  const jobV3 = ajv.getSchema('https://tokenless.dev/protocol/schemas/playwright-job.v3.schema.json')
  if (!jobV3) throw new Error('playwright-job.v3 fixture schema is not registered')
  const validGenericJob = {
    protocol: 'tokenless.playwright.job.v3',
    provider: 'future-ai',
    target: { kind: 'provider_home', url: 'https://future.example/path' },
    taskId: null,
    browserVisibility: 'auto',
    actions: [
      {
        protocol: 'tokenless.playwright.visible-action.v3',
        requestId: 'fixture-3',
        provider: 'future-ai',
        action: 'auth.status',
        payload: {},
      },
    ],
  }
  if (!jobV3(validGenericJob)) {
    throw new Error(`playwright-job.v3 fixture must accept generic provider syntax and safe HTTPS targets: ${JSON.stringify(jobV3.errors)}`)
  }
  const genericSafetyCases = [
    ['bad provider syntax', { provider: 'Future_AI' }],
    ['target credentials', { target: { kind: 'provider_home', url: 'https://user@future.example/' } }],
    ['target query', { target: { kind: 'provider_home', url: 'https://future.example/?q=1' } }],
    ['target fragment', { target: { kind: 'provider_home', url: 'https://future.example/#frag' } }],
    ['ip-like target', { target: { kind: 'provider_home', url: 'https://127.0.0.1/' } }],
    ['v2 action in v3 job', {
      actions: [
        {
          protocol: 'tokenless.playwright.visible-action.v2',
          requestId: 'fixture-4',
          provider: 'future-ai',
          action: 'auth.status',
          payload: {},
        },
      ],
    }],
  ]
  for (const [name, override] of genericSafetyCases) {
    if (jobV3({ ...validGenericJob, ...override })) {
      throw new Error(`playwright-job.v3 fixture must reject ${name}`)
    }
  }

  const actionV3 = ajv.getSchema('https://tokenless.dev/protocol/schemas/visible-action.v3.schema.json')
  if (!actionV3) throw new Error('visible-action.v3 fixture schema is not registered')
  const validGenericAction = {
    protocol: 'tokenless.playwright.visible-action.v3',
    requestId: 'fixture-5',
    provider: 'future-ai',
    action: 'auth.status',
    payload: {},
  }
  if (!actionV3(validGenericAction)) {
    throw new Error(`visible-action.v3 fixture must accept generic provider syntax: ${JSON.stringify(actionV3.errors)}`)
  }
  if (actionV3({ ...validGenericAction, provider: 'Future_AI' })) {
    throw new Error('visible-action.v3 fixture must reject invalid provider syntax')
  }
}

async function validateOpenApiArtifact({ artifactPath, parsed }) {
  if (!isRecord(parsed)) throw new Error(`${artifactPath} must be an object`)
  if (parsed.openapi !== '3.1.0') throw new Error(`${artifactPath} must be OpenAPI 3.1.0`)
  if (!isRecord(parsed.info) || typeof parsed.info.title !== 'string' || typeof parsed.info.version !== 'string') {
    throw new Error(`${artifactPath} must include info.title and info.version`)
  }
  if (!isRecord(parsed.paths)) throw new Error(`${artifactPath} must include paths`)
  const expectedPaths = [
    '/ready',
    '/jobs',
    '/jobs/{job_id}',
    '/jobs/{job_id}/claim',
    '/jobs/{job_id}/complete',
    '/jobs/{job_id}/resume',
    '/control/browser-runtime/status',
    '/control/browser-runtime/quiesce',
    '/control/jobs/claim-next',
    '/control/jobs/{job_id}/checkpoint',
    '/control/jobs/{job_id}/park',
    '/control/jobs/{job_id}/running',
    '/control/jobs/{job_id}/waiting-for-user',
    '/control/jobs/{job_id}/renew',
    '/control/jobs/{job_id}/cancel',
    '/control/shutdown',
  ]
  const actualPaths = Object.keys(parsed.paths).sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort())) {
    throw new Error(`${artifactPath} paths do not match daemon router: ${actualPaths.join(', ')}`)
  }
  if (!isRecord(parsed.components?.securitySchemes?.controlBearer)) {
    throw new Error(`${artifactPath} must define controlBearer security scheme`)
  }
  for (const publicPath of ['/ready']) {
    const operation = getSingleOperation(parsed.paths[publicPath], publicPath)
    if (JSON.stringify(operation.security) !== '[]') {
      throw new Error(`${artifactPath} ${publicPath} must explicitly opt out of bearer auth`)
    }
  }
  for (const protectedPath of expectedPaths.filter((entry) => entry !== '/ready')) {
    const pathItem = parsed.paths[protectedPath]
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue
      if (protectedPath === '/control/shutdown') {
        if (JSON.stringify(operation.security) !== JSON.stringify([{ controlBearer: [] }])) {
          throw new Error(`${artifactPath} ${method.toUpperCase()} ${protectedPath} must declare bearer auth`)
        }
      } else if (operation.security !== undefined) {
        throw new Error(`${artifactPath} ${method.toUpperCase()} ${protectedPath} must inherit root bearer auth`)
      }
    }
  }
  validateOpenApiReferences(artifactPath, parsed)
  compileOpenApiComponentSchemas(artifactPath, parsed)
  await validateOpenApiFixtures(artifactPath, parsed)
}

function getSingleOperation(pathItem, pathName) {
  if (!isRecord(pathItem)) throw new Error(`${pathName} path item must be an object`)
  const operations = Object.entries(pathItem).filter(([method]) => HTTP_METHODS.has(method))
  if (operations.length !== 1) throw new Error(`${pathName} must define exactly one operation`)
  return operations[0][1]
}

function validateOpenApiReferences(artifactPath, document) {
  const visit = (value, trail) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${trail}/${index}`))
      return
    }
    if (!isRecord(value)) return
    if (typeof value.$ref === 'string') resolveJsonPointer(document, value.$ref, artifactPath, trail)
    for (const [key, child] of Object.entries(value)) visit(child, `${trail}/${escapeJsonPointer(key)}`)
  }
  visit(document, '')
}

function compileOpenApiComponentSchemas(artifactPath, document) {
  const schemas = document.components?.schemas
  if (!isRecord(schemas)) throw new Error(`${artifactPath} must define components.schemas`)
  const ajv = newAjv()
  const defs = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, rewriteOpenApiSchemaRefs(schema)]))
  for (const [name, schema] of Object.entries(defs)) {
    try {
      ajv.compile({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: defs,
        $ref: `#/$defs/${escapeJsonPointer(name)}`,
      })
    } catch (error) {
      throw new Error(`${artifactPath} component schema ${name} is invalid: ${error.message}`)
    }
  }
}

async function validateOpenApiFixtures(artifactPath, document) {
  const fixturePath = path.join(root, 'protocol/fixtures/openapi-success-responses.json')
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'))
  if (fixture.openapi !== artifactPath) {
    throw new Error(`protocol fixture ${path.relative(root, fixturePath)} targets ${fixture.openapi}, expected ${artifactPath}`)
  }
  if (!Array.isArray(fixture.cases)) throw new Error('openapi success response fixture must include cases')
  const schemas = document.components?.schemas
  if (!isRecord(schemas)) throw new Error(`${artifactPath} must define components.schemas`)
  const defs = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, rewriteOpenApiSchemaRefs(schema)]))
  const ajv = newAjv()
  for (const testCase of fixture.cases) {
    if (!isRecord(testCase) || typeof testCase.name !== 'string' || typeof testCase.schema !== 'string') {
      throw new Error('openapi success response fixture case is malformed')
    }
    const schema = rewriteOpenApiSchemaRefs(resolveJsonPointer(document, testCase.schema, artifactPath, `fixture ${testCase.name}`))
    const validate = ajv.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/Fixture',
      $defs: {
        ...defs,
        Fixture: schema,
      },
    })
    const valid = validate(testCase.data)
    if (valid !== testCase.valid) {
      throw new Error(`openapi fixture ${testCase.name} expected valid=${testCase.valid}; errors=${JSON.stringify(validate.errors)}`)
    }
  }
}

function rewriteOpenApiSchemaRefs(value) {
  if (Array.isArray(value)) return value.map(rewriteOpenApiSchemaRefs)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/components/schemas/')) {
      return [key, `#/$defs/${child.slice('#/components/schemas/'.length)}`]
    }
    return [key, rewriteOpenApiSchemaRefs(child)]
  }))
}

function resolveJsonPointer(document, ref, artifactPath, trail) {
  if (!ref.startsWith('#/')) {
    throw new Error(`${artifactPath} external OpenAPI $ref is not supported at ${trail}: ${ref}`)
  }
  let current = document
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(current) && !Array.isArray(current)) {
      throw new Error(`${artifactPath} unresolved $ref at ${trail}: ${ref}`)
    }
    current = current[part]
    if (current === undefined) throw new Error(`${artifactPath} unresolved $ref at ${trail}: ${ref}`)
  }
  return current
}

function escapeJsonPointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function newAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  ajv.addKeyword({
    keyword: 'x-tokenless-maxUtf8Bytes',
    type: 'string',
    schemaType: 'number',
    validate(limit, value) {
      return Buffer.byteLength(value, 'utf8') <= limit
    },
  })
  addFormats(ajv)
  return ajv
}

function collectConstants(value, language) {
  const entries = []
  for (const protocol of value.protocols) {
    const constantName = protocol.constants?.[language]
    if (constantName) entries.push({ name: constantName, value: protocol.id, aliasOf: null })
    for (const alias of protocol.aliases?.[language] ?? []) {
      entries.push({ name: alias, value: protocol.id, aliasOf: constantName })
    }
  }
  return entries.sort((left, right) => {
    if (Boolean(left.aliasOf) !== Boolean(right.aliasOf)) return left.aliasOf ? 1 : -1
    return left.name.localeCompare(right.name)
  })
}

function renderTypeScript(header, constants) {
  const lines = [
    `// ${header}`,
    '',
  ]
  for (const constant of constants) {
    if (constant.aliasOf) {
      lines.push(`export const ${constant.name} = ${constant.aliasOf}`)
    } else {
      lines.push(`export const ${constant.name} = ${JSON.stringify(constant.value)} as const`)
    }
  }
  return `${lines.join('\n')}\n`
}

function renderJavaScript(header, constants) {
  const lines = [
    `// ${header}`,
    '',
  ]
  for (const constant of constants) {
    if (constant.aliasOf) {
      lines.push(`export const ${constant.name} = ${constant.aliasOf}`)
    } else {
      lines.push(`export const ${constant.name} = ${JSON.stringify(constant.value)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function validateConstantName(language, value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`${language} constant name is invalid: ${String(value)}`)
  }
}

function requireString(record, key) {
  if (typeof record[key] !== 'string' || !record[key].trim()) {
    throw new Error(`protocol entry must include ${key}`)
  }
}

function requireStringArray(record, key) {
  if (!Array.isArray(record[key]) || record[key].some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`protocol entry ${record.id ?? '(unknown)'} must include string array ${key}`)
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
