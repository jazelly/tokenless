export const FEATUREBENCH_PROTOCOL = 'tokenless.featurebench-channel.v1' as const
export const FEATUREBENCH_AGENT_PROTOCOL = 'tokenless.featurebench-agent.v1' as const
export const FEATUREBENCH_BENCHMARK_COMMIT = '445dcbaec0b2e136061b0acb54e753c0a9f1888e' as const
export const FEATUREBENCH_DATASET = 'LiberCoders/FeatureBench' as const
export const FEATUREBENCH_DATASET_REVISION = 'e99d6efdfe511ea832c1b5735c536129561ec96a' as const
export const FEATUREBENCH_FULL_TASKS = 200 as const
export const FEATUREBENCH_FAST_TASKS = 100 as const
export const FEATUREBENCH_SCAFFOLD = 'tokenless' as const

export const FEATUREBENCH_WIRING_TASKS = Object.freeze([
  'pypa__packaging.013f3b03.test_metadata.e00b5801.lv1',
  'python__mypy.8e2ce962.testconstraints.db380fe7.lv1',
  'fastapi__fastapi.02e108d1.test_compat.71e8518f.lv1',
  'pytest-dev__pytest.68016f0e.test_local.40fb2f1f.lv1',
  'mesonbuild__meson.f5d81d07.cargotests.8e49c2d0.lv1',
  'fastapi__fastapi.02e108d1.test_compat.71e8518f.lv2',
] as const)

export type FeatureBenchExecutionMode = 'browser' | 'direct'

export type FeatureBenchChannelFile = {
  protocol: typeof FEATUREBENCH_PROTOCOL
  channelId: string
  token: string
  endpoint: string
  instanceId: string
  benchmarkCommit: typeof FEATUREBENCH_BENCHMARK_COMMIT
  datasetRevision: typeof FEATUREBENCH_DATASET_REVISION
  provider: string
  model: string
  executionMode: FeatureBenchExecutionMode
  maxTurns: number
  providerTurnTimeoutMs: number
  expiresAt: string
}
