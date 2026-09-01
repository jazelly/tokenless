#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const openApiPath = path.join(root, 'packages/contracts/tokenless.openapi.json')
const fixturePath = path.join(root, 'packages/contracts/fixtures/openapi-success-responses.json')
const openApiArtifactPath = 'packages/contracts/tokenless.openapi.json'
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

const document = await readJson(openApiPath)
await validateOpenApiDocument(openApiArtifactPath, document)
console.log(`api:check validated ${openApiArtifactPath}`)

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`${path.relative(root, filePath)} is not valid JSON: ${error.message}`)
  }
}

function validateOpenApiDocument(artifactPath, parsed) {
  if (!isRecord(parsed)) throw new Error(`${artifactPath} must be an object`)
  if (parsed.openapi !== '3.1.0') throw new Error(`${artifactPath} must be OpenAPI 3.1.0`)
  if (!isRecord(parsed.info) || typeof parsed.info.title !== 'string' || parsed.info.version !== '1.2.0') {
    throw new Error(`${artifactPath} must include info.title and API version 1.2.0`)
  }
  if (!isRecord(parsed.paths)) throw new Error(`${artifactPath} must include paths`)

  const operationIds = new Set()
  for (const [route, pathItem] of Object.entries(parsed.paths)) {
    if (!isRecord(pathItem)) throw new Error(`${artifactPath} ${route} path item must be an object`)
    const operations = Object.entries(pathItem).filter(([method]) => HTTP_METHODS.has(method))
    if (operations.length === 0) throw new Error(`${artifactPath} ${route} must define an operation`)
    for (const [method, operation] of operations) {
      if (!isRecord(operation) || typeof operation.operationId !== 'string' || !operation.operationId) {
        throw new Error(`${artifactPath} ${method.toUpperCase()} ${route} must define operationId`)
      }
      if (operationIds.has(operation.operationId)) {
        throw new Error(`${artifactPath} operationId must be unique: ${operation.operationId}`)
      }
      operationIds.add(operation.operationId)
      if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
        throw new Error(`${artifactPath} ${method.toUpperCase()} ${route} must define responses`)
      }
    }
  }

  for (const name of ['controlBearer', 'dashboardSession', 'csrf', 'featureBenchBearer']) {
    if (!isRecord(parsed.components?.securitySchemes?.[name])) {
      throw new Error(`${artifactPath} must define ${name} security scheme`)
    }
  }
  if (JSON.stringify(parsed.security) !== JSON.stringify([{ controlBearer: [] }])) {
    throw new Error(`${artifactPath} must require bearer auth by default`)
  }
  const readyOperation = getSingleOperation(parsed.paths['/ready'], '/ready')
  if (JSON.stringify(readyOperation.security) !== '[]') {
    throw new Error(`${artifactPath} /ready must explicitly opt out of bearer auth`)
  }
  const controlSecurity = JSON.stringify([{ controlBearer: [] }])
  const dashboardMutationSecurity = JSON.stringify([{ dashboardSession: [], csrf: [] }])
  const featureBenchSecurity = JSON.stringify([{ featureBenchBearer: [] }])
  for (const [route, pathItem] of Object.entries(parsed.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue
      if (route === '/ready') continue
      if (route.startsWith('/dashboard-api/v1/')) {
        const expected = method === 'get' ? '[]' : dashboardMutationSecurity
        if (JSON.stringify(operation.security) !== expected) {
          throw new Error(`${artifactPath} ${method.toUpperCase()} ${route} has invalid Dashboard security`)
        }
        continue
      }
      if (route === '/v1/private/featurebench/turn' || route === '/v1/private/featurebench/turn/complete') {
        if (JSON.stringify(operation.security) !== featureBenchSecurity) {
          throw new Error(`${artifactPath} ${method.toUpperCase()} ${route} must use its issued channel bearer token`)
        }
        continue
      }
      if (operation.security !== undefined && JSON.stringify(operation.security) !== controlSecurity) {
        throw new Error(`${artifactPath} ${method.toUpperCase()} ${route} must use daemon bearer auth`)
      }
    }
  }

  const legacyMachinePrefixes = ['/jobs', '/control', '/provider-mappings', '/provider-conversations', '/provider-capacity', '/replay']
  for (const route of Object.keys(parsed.paths)) {
    if (legacyMachinePrefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`))) {
      throw new Error(`${artifactPath} legacy bearer machine route must be under /v1/private: ${route}`)
    }
  }

  validateOpenApiReferences(artifactPath, parsed)
  compileOpenApiComponentSchemas(artifactPath, parsed)
  validateDaemonApiDoesNotExposeProtocolIdentity(artifactPath, parsed)
  return validateOpenApiFixtures(artifactPath, parsed)
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

function validateDaemonApiDoesNotExposeProtocolIdentity(artifactPath, document) {
  const schemas = document.components?.schemas
  for (const schemaName of ['ReadyResponse', 'DaemonErrorResponse', 'BrowserRuntimeStatus']) {
    const serialized = JSON.stringify(schemas?.[schemaName])
    if (serialized.includes('"protocol"')) {
      throw new Error(`${artifactPath} ${schemaName} must not expose a daemon API identity field`)
    }
  }
}

async function validateOpenApiFixtures(artifactPath, document) {
  const fixture = await readJson(fixturePath)
  if (fixture.openapi !== artifactPath) {
    throw new Error(`api fixture ${path.relative(root, fixturePath)} targets ${fixture.openapi}, expected ${artifactPath}`)
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
  for (const keyword of ['x-tokenless-maxUtf8Bytes', 'x-tokenless-internal-maxUtf8Bytes']) {
    ajv.addKeyword({
      keyword,
      type: 'string',
      schemaType: 'number',
      validate(limit, value) {
        return Buffer.byteLength(value, 'utf8') <= limit
      },
    })
  }
  addFormats(ajv)
  return ajv
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
