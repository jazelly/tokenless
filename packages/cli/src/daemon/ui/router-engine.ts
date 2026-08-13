import type { JsonRecord } from './types.js'

export type RouterEngineId = 'chrome-prompt-api'

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
  constructor(readonly code: 'unsupported' | 'unavailable' | 'invalid-result') {
    super(code)
  }
}

export function createRouterEngine(engine: RouterEngineId) {
  if (engine !== 'chrome-prompt-api') throw new RouterEngineError('unsupported')

  return {
    async availability() {
      const api = languageModelApi()
      return api ? await api.availability() : 'unsupported'
    },

    async route(
      task: string,
      models: RouterModel[],
      callbacks: {
        onAvailability: (availability: string) => void
        onDownloadProgress: (progress: number | null) => void
      },
    ): Promise<RouterResult> {
      const api = languageModelApi()
      if (!api) throw new RouterEngineError('unsupported')

      const initialAvailability = await api.availability()
      callbacks.onAvailability(initialAvailability)
      if (initialAvailability === 'unavailable') throw new RouterEngineError('unavailable')
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

function languageModelApi() {
  return (window as Window & { LanguageModel?: LanguageModelApi }).LanguageModel
}

const semanticInstruction = 'Analyze the task. Choose the candidate model whose suitableTasks best matches it. Return the task type, complexity, and a concise reason.'
