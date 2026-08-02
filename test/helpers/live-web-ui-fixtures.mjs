import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCHEMA = 'tokenless.live-web-ui-fixtures.v1'

export function loadLiveWebUiFixtures({ fixtureFile, selection }) {
  const resolvedFile = path.resolve(fixtureFile)
  let document
  try {
    document = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read live Web UI fixture file '${resolvedFile}'. Copy test/fixtures/live-web-ui.example.json to test/fixtures/local/web-ui.json first.`, { cause: error })
  }

  requireRecord(document, 'fixture document')
  requireKnownFields(document, ['schema', 'homes', 'profiles', 'providers', 'startups', 'cases', 'suites'], 'fixture document')
  if (document.schema !== SCHEMA) throw new Error(`Fixture schema must be '${SCHEMA}'.`)

  const homes = requireFixtureMap(document.homes, 'homes')
  const profiles = requireFixtureMap(document.profiles, 'profiles')
  const providers = requireFixtureMap(document.providers, 'providers')
  const startups = requireFixtureMap(document.startups, 'startups')
  const cases = requireFixtureMap(document.cases, 'cases')
  const suites = requireFixtureMap(document.suites, 'suites')
  const selectedCaseIds = resolveSelection(selection, cases, suites)

  return {
    fixtureFile: resolvedFile,
    selection,
    cases: selectedCaseIds.map((caseId) => resolveCase({
      caseId,
      value: cases[caseId],
      homes,
      profiles,
      providers,
      startups,
    })),
  }
}

function resolveSelection(selection, cases, suites) {
  if (Object.hasOwn(cases, selection)) return [selection]
  const suite = suites[selection]
  if (!Array.isArray(suite) || suite.length === 0) {
    throw new Error(`Fixture selection '${selection}' must name one case or one non-empty suite.`)
  }
  const seen = new Set()
  return suite.map((caseId, index) => {
    const id = requireIdentifier(caseId, `suites.${selection}[${index}]`)
    if (!Object.hasOwn(cases, id)) throw new Error(`Suite '${selection}' references unknown case '${id}'.`)
    if (seen.has(id)) throw new Error(`Suite '${selection}' repeats case '${id}'.`)
    seen.add(id)
    return id
  })
}

function resolveCase({ caseId, value, homes, profiles, providers, startups }) {
  requireRecord(value, `cases.${caseId}`)
  requireKnownFields(value, ['profile', 'provider', 'startup'], `cases.${caseId}`)
  const profileId = requireIdentifier(value.profile, `cases.${caseId}.profile`)
  const providerId = requireIdentifier(value.provider, `cases.${caseId}.provider`)
  const startupId = requireIdentifier(value.startup, `cases.${caseId}.startup`)

  const profile = requireNamedFixture(profiles, profileId, 'profiles')
  requireKnownFields(profile, ['home', 'slug'], `profiles.${profileId}`)
  const homeId = requireIdentifier(profile.home, `profiles.${profileId}.home`)
  const home = requireNamedFixture(homes, homeId, 'homes')
  requireKnownFields(home, ['path'], `homes.${homeId}`)
  const homeDir = expandHome(requireString(home.path, `homes.${homeId}.path`))
  const profileSlug = requireSlug(profile.slug, `profiles.${profileId}.slug`)

  const provider = requireNamedFixture(providers, providerId, 'providers')
  requireKnownFields(provider, ['id'], `providers.${providerId}`)
  const providerName = requireSlug(provider.id, `providers.${providerId}.id`)

  const startup = requireNamedFixture(startups, startupId, 'startups')
  requireKnownFields(startup, ['context', 'reload', 'viewport'], `startups.${startupId}`)
  const context = startup.context ?? 'fresh'
  if (context !== 'fresh' && context !== 'shared') {
    throw new Error(`startups.${startupId}.context must be 'fresh' or 'shared'.`)
  }
  if (startup.reload !== undefined && typeof startup.reload !== 'boolean') {
    throw new Error(`startups.${startupId}.reload must be a boolean.`)
  }
  const viewport = resolveViewport(startup.viewport, startupId)

  return Object.freeze({
    id: caseId,
    targetId: `${homeId}:${profileId}:${providerId}`,
    homeDir: path.resolve(homeDir),
    profile: profileSlug,
    provider: providerName,
    startup: Object.freeze({
      id: startupId,
      context,
      reload: startup.reload === true,
      viewport,
    }),
  })
}

function resolveViewport(value, startupId) {
  requireRecord(value, `startups.${startupId}.viewport`)
  requireKnownFields(value, ['width', 'height'], `startups.${startupId}.viewport`)
  const width = requireInteger(value.width, `startups.${startupId}.viewport.width`, 320, 3840)
  const height = requireInteger(value.height, `startups.${startupId}.viewport.height`, 480, 2160)
  return Object.freeze({ width, height })
}

function requireFixtureMap(value, label) {
  requireRecord(value, label)
  if (Object.keys(value).length === 0) throw new Error(`${label} must contain at least one fixture.`)
  for (const id of Object.keys(value)) requireIdentifier(id, `${label} key`)
  return value
}

function requireNamedFixture(fixtures, id, label) {
  const value = fixtures[id]
  if (value === undefined) throw new Error(`Unknown ${label} fixture '${id}'.`)
  requireRecord(value, `${label}.${id}`)
  return value
}

function requireKnownFields(value, fields, label) {
  const allowed = new Set(fields)
  const unknown = Object.keys(value).filter((field) => !allowed.has(field))
  if (unknown.length > 0) throw new Error(`${label} contains unsupported field(s): ${unknown.join(', ')}.`)
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value.trim()
}

function requireIdentifier(value, label) {
  const result = requireString(value, label)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(result)) throw new Error(`${label} must use lowercase letters, numbers, and hyphens.`)
  return result
}

function requireSlug(value, label) {
  return requireIdentifier(value, label)
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`)
  }
  return value
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}
