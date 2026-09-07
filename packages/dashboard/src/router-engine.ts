import {
  createSparkX25MlxAiEngine,
  HARNESS_ROUTE_INSTRUCTION as semanticInstruction,
  HARNESS_TITLE_INSTRUCTION as titleInstruction,
  HARNESS_TITLE_RESPONSE_SCHEMA,
  harnessRouteResponseSchema,
  readHarnessRoute,
  readHarnessTitle,
  type HarnessFrontDoorProviderCandidate,
  type HarnessFrontDoorRoute,
  SPARK_X25_4B_MLX_ENGINE_ID,
  SPARK_X25_4B_MLX_HEALTH_ENDPOINT,
  SPARK_X25_4B_MLX_MODEL,
  type HarnessAiEngine,
} from 'tokenless-internal-shared/harness-sidecar'
import type { HarnessSidecarJsonValue } from 'tokenless-internal-shared/harness-sidecar'

export type RouterEngineId = 'chrome-prompt-api' | typeof SPARK_X25_4B_MLX_ENGINE_ID

export const CHROME_PROMPT_API_MIN_MAJOR = 148
export { ROUTER_TASK_TYPE_PATTERN } from 'tokenless-internal-shared/harness-sidecar'

export type RouterBrowserBinding = {
  browserId: string
  family: string
  version: string | null
}

export type RouterEngineObservation = {
  supported: boolean
  code: 'supported' | 'unsupported-browser-mode' | 'unsupported-browser' | 'unsupported-version' | 'api-missing'
  browserId: string
  browserFamily: string
  browserVersion: string | null
  minimumChromeMajor: number
}

export type RouterEngineCallbacks = {
  onObservation: (observation: RouterEngineObservation) => void
  onAvailability: (availability: string) => void
  onDownloadProgress: (progress: number | null) => void
}

export type RouterProviderCandidate = HarnessFrontDoorProviderCandidate
export type RouterResult = HarnessFrontDoorRoute

type LanguageModelSession = {
  prompt: (input: string, options: { responseConstraint: Record<string, unknown> }) => Promise<string>
  destroy?: () => void
}

type LanguageModelApi = {
  availability: () => Promise<string>
  create: (options: {
    monitor: (monitor: {
      addEventListener: (type: 'downloadprogress', listener: (event: { loaded: number }) => void) => void
    }) => void
  }) => Promise<LanguageModelSession>
}

export class RouterEngineError extends Error {
  constructor(
    readonly code: 'unsupported-engine' | 'unsupported-browser-mode' | 'unsupported-browser' | 'unsupported-version' | 'api-missing' | 'unavailable' | 'invalid-result',
    readonly observation: RouterEngineObservation | null = null,
  ) {
    super(code)
  }
}

type RouterEngine = {
  inspect: (browserBinding: RouterBrowserBinding) => Promise<RouterEngineObservation>
  availability: (browserBinding: RouterBrowserBinding) => Promise<{ observation: RouterEngineObservation; status: string }>
  route: (
    task: string,
    providers: RouterProviderCandidate[],
    browserBinding: RouterBrowserBinding,
    callbacks: RouterEngineCallbacks,
  ) => Promise<RouterResult>
  title: (task: string, browserBinding: RouterBrowserBinding) => Promise<string>
}

/** Browser-side adapter for the Harness sidecar seam. */
export function createGeminiNanoAiEngine(): HarnessAiEngine {
  return {
    id: 'gemini-nano',
    async complete(input) {
      const observation = await inspectChromePromptApi()
      requireSupportedObservation(observation)
      const api = languageModelApi()
      if (!api) throw new RouterEngineError('api-missing', observation)
      if (await api.availability() === 'unavailable') throw new RouterEngineError('unavailable', observation)

      const session = await api.create({ monitor() {} })
      try {
        const response = await session.prompt(`${input.instruction}\n${JSON.stringify(input.input)}`, {
          responseConstraint: input.responseSchema as Record<string, unknown>,
        })
        try {
          return JSON.parse(response) as HarnessSidecarJsonValue
        } catch {
          throw new RouterEngineError('invalid-result')
        }
      } finally {
        session.destroy?.()
      }
    },
  }
}

/** Return the selected local model adapter for the shared Harness sidecar seam. */
export function createRouterAiEngine(engine: RouterEngineId): HarnessAiEngine {
  if (engine === 'chrome-prompt-api') return createGeminiNanoAiEngine()
  if (engine === SPARK_X25_4B_MLX_ENGINE_ID) return createSparkX25MlxAiEngine()
  throw new RouterEngineError('unsupported-engine')
}

export function createRouterEngine(engine: RouterEngineId): RouterEngine {
  if (engine === SPARK_X25_4B_MLX_ENGINE_ID) return createSparkRouterEngine()
  if (engine !== 'chrome-prompt-api') throw new RouterEngineError('unsupported-engine')

  return {
    async inspect(_browserBinding: RouterBrowserBinding): Promise<RouterEngineObservation> {
      return await inspectChromePromptApi()
    },

    async availability(_browserBinding: RouterBrowserBinding) {
      const observation = await inspectChromePromptApi()
      requireSupportedObservation(observation)
      const api = languageModelApi()
      if (!api) throw new RouterEngineError('api-missing', observation)
      return { observation, status: await api.availability() }
    },

    async route(
      task: string,
      providers: RouterProviderCandidate[],
      _browserBinding: RouterBrowserBinding,
      callbacks: RouterEngineCallbacks,
    ): Promise<RouterResult> {
      const observation = await inspectChromePromptApi()
      callbacks.onObservation(observation)
      requireSupportedObservation(observation)
      const api = languageModelApi()
      if (!api) throw new RouterEngineError('api-missing', observation)

      const initialAvailability = await api.availability()
      callbacks.onAvailability(initialAvailability)
      if (initialAvailability === 'unavailable') throw new RouterEngineError('unavailable', observation)
      if (initialAvailability === 'downloadable' || initialAvailability === 'downloading') {
        callbacks.onAvailability('downloading')
        callbacks.onDownloadProgress(0)
      }

      const session = await api.create({
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', (event) => {
            callbacks.onAvailability('downloading')
            callbacks.onDownloadProgress(Math.round(Math.min(1, Math.max(0, event.loaded)) * 100))
          })
        },
      })
      try {
        callbacks.onAvailability('available')
        callbacks.onDownloadProgress(null)
        const response = await session.prompt(`${semanticInstruction}\n${JSON.stringify({
          task,
          providerConfiguration: providers,
        })}`, {
          responseConstraint: harnessRouteResponseSchema(providers),
        })
        return readRouterResult(JSON.parse(response) as HarnessSidecarJsonValue, providers)
      } catch (error) {
        if (error instanceof RouterEngineError) throw error
        if (error instanceof SyntaxError) throw new RouterEngineError('invalid-result')
        throw error
      } finally {
        session.destroy?.()
      }
    },

    async title(task: string, _browserBinding: RouterBrowserBinding): Promise<string> {
      const observation = await inspectChromePromptApi()
      requireSupportedObservation(observation)
      const api = languageModelApi()
      if (!api) throw new RouterEngineError('api-missing', observation)
      if (await api.availability() === 'unavailable') throw new RouterEngineError('unavailable', observation)
      const session = await api.create({ monitor() {} })
      try {
        const response = await session.prompt(`${titleInstruction}\n${JSON.stringify({ conversation: task.slice(0, 4_000) })}`, {
          responseConstraint: HARNESS_TITLE_RESPONSE_SCHEMA,
        })
        return readRouterTitle(JSON.parse(response) as HarnessSidecarJsonValue)
      } catch (error) {
        if (error instanceof RouterEngineError) throw error
        if (error instanceof SyntaxError) throw new RouterEngineError('invalid-result')
        throw error
      } finally {
        session.destroy?.()
      }
    },
  }
}

function createSparkRouterEngine(): RouterEngine {
  return {
    async inspect(_browserBinding) {
      return sparkObservation()
    },

    async availability(_browserBinding) {
      const observation = sparkObservation()
      await requireSparkAvailability(observation)
      return { observation, status: 'available' }
    },

    async route(task, providers, browserBinding, callbacks) {
      const observation = sparkObservation()
      callbacks.onObservation(observation)
      callbacks.onAvailability('checking')
      await requireSparkAvailability(observation)
      callbacks.onAvailability('available')
      callbacks.onDownloadProgress(null)
      const value = await createSparkX25MlxAiEngine().complete({
        instruction: semanticInstruction,
        input: { task, providerConfiguration: providers },
        responseSchema: harnessRouteResponseSchema(providers),
        browserBinding,
      })
      return readRouterResult(value, providers)
    },

    async title(task, _browserBinding) {
      const observation = sparkObservation()
      await requireSparkAvailability(observation)
      const value = await createSparkX25MlxAiEngine().complete({
        instruction: titleInstruction,
        input: { conversation: task.slice(0, 4_000) },
        responseSchema: HARNESS_TITLE_RESPONSE_SCHEMA,
      })
      return readRouterTitle(value)
    },
  }
}

function sparkObservation(): RouterEngineObservation {
  return {
    supported: true,
    code: 'supported',
    browserId: SPARK_X25_4B_MLX_ENGINE_ID,
    browserFamily: 'local-mlx-server',
    browserVersion: SPARK_X25_4B_MLX_MODEL,
    minimumChromeMajor: 0,
  }
}

async function requireSparkAvailability(observation: RouterEngineObservation) {
  try {
    const response = await fetch(SPARK_X25_4B_MLX_HEALTH_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch {
    throw new RouterEngineError('unavailable', observation)
  }
}

function readRouterResult(value: HarnessSidecarJsonValue, providers: RouterProviderCandidate[]): RouterResult {
  try {
    return readHarnessRoute(value, providers)
  } catch {
    throw new RouterEngineError('invalid-result')
  }
}

function readRouterTitle(value: HarnessSidecarJsonValue): string {
  try {
    return readHarnessTitle(value)
  } catch {
    throw new RouterEngineError('invalid-result')
  }
}

async function inspectChromePromptApi(): Promise<RouterEngineObservation> {
  const identity = await chromeFamilyIdentity()
  const base = {
    browserId: identity.browserId,
    browserFamily: 'renderer',
    browserVersion: identity.version,
    minimumChromeMajor: CHROME_PROMPT_API_MIN_MAJOR,
  }
  const browserVersion = identity.version
  if (!identity.isGoogleChrome) {
    return { ...base, browserVersion, supported: false, code: 'unsupported-browser' }
  }
  const browserMajor = versionMajor(browserVersion)
  if (browserMajor === null || browserMajor < CHROME_PROMPT_API_MIN_MAJOR) {
    return { ...base, browserVersion, supported: false, code: 'unsupported-version' }
  }
  if (!languageModelApi()) {
    return { ...base, browserVersion, supported: false, code: 'api-missing' }
  }
  return { ...base, browserVersion, supported: true, code: 'supported' }
}

function requireSupportedObservation(observation: RouterEngineObservation) {
  if (observation.code === 'supported') return
  throw new RouterEngineError(observation.code, observation)
}

async function chromeFamilyIdentity() {
  const userAgentData = (navigator as Navigator & {
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>
      getHighEntropyValues?: (hints: string[]) => Promise<{
        fullVersionList?: Array<{ brand: string; version: string }>
      }>
    }
  }).userAgentData
  let versions = userAgentData?.brands ?? []
  if (userAgentData?.getHighEntropyValues) {
    try {
      const values = await userAgentData.getHighEntropyValues(['fullVersionList'])
      if (values.fullVersionList?.length) versions = values.fullVersionList
    } catch {
      // The low-entropy brand list still provides the browser major version.
    }
  }
  const chrome = versions.find((brand) => brand.brand === 'Google Chrome')
  const observed = chrome ?? versions.find((brand) => !/not.?a.?brand/i.test(brand.brand))
  return {
    browserId: chrome ? 'chrome' : observed?.brand ?? 'unknown',
    isGoogleChrome: Boolean(chrome),
    version: observed?.version ?? null,
  }
}

function versionMajor(version: string | null) {
  if (!version) return null
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isSafeInteger(major) ? major : null
}

function languageModelApi() {
  return (window as Window & { LanguageModel?: LanguageModelApi }).LanguageModel
}
