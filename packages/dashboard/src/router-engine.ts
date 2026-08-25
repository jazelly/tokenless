import type {
  HarnessAiEngine,
  HarnessSidecarJsonValue,
} from 'tokenless-internal-shared/harness-sidecar'

export type RouterEngineId = 'chrome-prompt-api'

export const CHROME_PROMPT_API_MIN_MAJOR = 148

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

export type RouterProviderCandidate = {
  providerId: string
  label: string
  suitableTasks: string
  model: string | null
}

export type RouterResult = {
  providerId: string
  model: string | null
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  reason: string
}

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

export function createRouterEngine(engine: RouterEngineId) {
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
      callbacks: {
        onObservation: (observation: RouterEngineObservation) => void
        onAvailability: (availability: string) => void
        onDownloadProgress: (progress: number | null) => void
      },
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
          responseConstraint: {
            type: 'object',
            properties: {
              providerId: { type: 'string', enum: providers.map((provider) => provider.providerId) },
              model: { enum: [...new Set(providers.map((provider) => provider.model))] },
              taskType: { type: 'string' },
              complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
              reason: { type: 'string' },
            },
            required: ['providerId', 'model', 'taskType', 'complexity', 'reason'],
            additionalProperties: false,
          },
        })
        const parsed = JSON.parse(response) as Partial<RouterResult>
        const selectedProvider = providers.find((provider) => provider.providerId === parsed.providerId)
        if (
          !selectedProvider ||
          parsed.model !== selectedProvider.model ||
          typeof parsed.taskType !== 'string' ||
          !['low', 'medium', 'high'].includes(String(parsed.complexity)) ||
          typeof parsed.reason !== 'string'
        ) {
          throw new RouterEngineError('invalid-result')
        }
        return parsed as RouterResult
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
          responseConstraint: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        })
        const parsed = JSON.parse(response) as { title?: unknown }
        const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
        if (!title || title.length > 80) throw new RouterEngineError('invalid-result')
        return title
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

const semanticInstruction = 'Analyze the task. Choose the enabled AI provider whose suitableTasks best matches it. Return that provider ID, its configured model, the task type, complexity, and a concise reason.'
const titleInstruction = 'Write a direct, descriptive title for this conversation. Use the conversation language. Return only JSON. Keep the title under eight words in English or twenty characters in Chinese.'
