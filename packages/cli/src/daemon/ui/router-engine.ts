import type { JsonRecord } from './types.js'

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

export type RouterModel = {
  id: string
  label: string
  suitableTasks: string
}

export type RouterResult = {
  modelId: string
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  reason: string
}

type LanguageModelSession = {
  prompt: (input: string, options: { responseConstraint: JsonRecord }) => Promise<string>
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

export function createRouterEngine(engine: RouterEngineId) {
  if (engine !== 'chrome-prompt-api') throw new RouterEngineError('unsupported-engine')

  return {
    async inspect(browserBinding: RouterBrowserBinding): Promise<RouterEngineObservation> {
      return await inspectChromePromptApi(browserBinding)
    },

    async availability(browserBinding: RouterBrowserBinding) {
      const observation = await inspectChromePromptApi(browserBinding)
      requireSupportedObservation(observation)
      const api = languageModelApi()
      if (!api) throw new RouterEngineError('api-missing', observation)
      return { observation, status: await api.availability() }
    },

    async route(
      task: string,
      models: RouterModel[],
      browserBinding: RouterBrowserBinding,
      callbacks: {
        onObservation: (observation: RouterEngineObservation) => void
        onAvailability: (availability: string) => void
        onDownloadProgress: (progress: number | null) => void
      },
    ): Promise<RouterResult> {
      const observation = await inspectChromePromptApi(browserBinding)
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
          modelConfiguration: models,
        })}`, {
          responseConstraint: {
            type: 'object',
            properties: {
              modelId: { type: 'string', enum: models.map((model) => model.id) },
              taskType: { type: 'string' },
              complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
              reason: { type: 'string' },
            },
            required: ['modelId', 'taskType', 'complexity', 'reason'],
            additionalProperties: false,
          },
        })
        const parsed = JSON.parse(response) as Partial<RouterResult>
        if (
          !models.some((model) => model.id === parsed.modelId) ||
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
  }
}

async function inspectChromePromptApi(browserBinding: RouterBrowserBinding): Promise<RouterEngineObservation> {
  const base = {
    browserId: browserBinding.browserId,
    browserFamily: browserBinding.family,
    browserVersion: browserBinding.version,
    minimumChromeMajor: CHROME_PROMPT_API_MIN_MAJOR,
  }
  if (browserBinding.family !== 'system' || browserBinding.browserId !== 'chrome') {
    return { ...base, supported: false, code: 'unsupported-browser-mode' }
  }

  const identity = await googleChromeIdentity()
  const browserVersion = identity.version ?? browserBinding.version
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

async function googleChromeIdentity() {
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
  return { isGoogleChrome: Boolean(chrome), version: observed?.version ?? null }
}

function versionMajor(version: string | null) {
  if (!version) return null
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isSafeInteger(major) ? major : null
}

function languageModelApi() {
  return (window as Window & { LanguageModel?: LanguageModelApi }).LanguageModel
}

const semanticInstruction = 'Analyze the task. Choose the candidate model whose suitableTasks best matches it. Return the task type, complexity, and a concise reason.'
