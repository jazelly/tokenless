export const OUTPUT_SAVINGS_MEASUREMENT_SCHEMA = 'tokenless.output-savings-measurement.v1' as const

export type OutputSavingsMeasurement = {
  schema: typeof OUTPUT_SAVINGS_MEASUREMENT_SCHEMA
  state: 'measured'
  basis: 'visible_assistant_text'
  estimator: 'o200k_base'
  estimatorRevision: string
  estimatedOutputTokens: number
  visibleCharacters: number
  sourceTextSha256: string
  measuredAt: string
}

export type OutputSavingsUnavailable = {
  schema: typeof OUTPUT_SAVINGS_MEASUREMENT_SCHEMA
  state: 'unavailable'
  basis: 'visible_assistant_text'
  estimator: 'o200k_base'
  estimatorRevision: string
  reason: 'runtime_not_ready' | 'text_too_large' | 'measurement_failed' | 'measurement_canceled'
}

export type OutputSavingsResult = OutputSavingsMeasurement | OutputSavingsUnavailable

export type MeasureVisibleOutput = (text: string) => Promise<OutputSavingsResult>
