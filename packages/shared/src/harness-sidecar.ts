export const HARNESS_SIDECAR_PROTOCOL = 'tokenless.harness-sidecar/v1' as const

export type HarnessSidecarJsonPrimitive = string | number | boolean | null
export type HarnessSidecarJsonValue =
  | HarnessSidecarJsonPrimitive
  | HarnessSidecarJsonValue[]
  | { [key: string]: HarnessSidecarJsonValue }

export type HarnessSidecarBrowserBinding = {
  browserId: string
  family: string
  version: string | null
}

export type HarnessAiCompletionInput = {
  instruction: string
  input: HarnessSidecarJsonValue
  responseSchema: HarnessSidecarJsonValue
  browserBinding?: HarnessSidecarBrowserBinding | undefined
}

/** One browser, local, or remote implementation used by Harness sidecars. */
export type HarnessAiEngine = {
  id: string
  complete(input: HarnessAiCompletionInput): Promise<HarnessSidecarJsonValue>
}

export type HarnessFrontDoorProviderCandidate = {
  providerId: string
  label: string
  suitableTasks: string
  model: string | null
}

export type HarnessFrontDoorInput = {
  taskPrompt: string
  providers: readonly HarnessFrontDoorProviderCandidate[]
  browserBinding?: HarnessSidecarBrowserBinding | undefined
}

export type HarnessFrontDoorRoute = {
  providerId: string
  model: string | null
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  reason: string
}

export type HarnessFrontDoorResult = {
  protocol: typeof HARNESS_SIDECAR_PROTOCOL
  kind: 'front_door'
  engine: string
  title: string
  route: HarnessFrontDoorRoute
}

export type HarnessFrontDoorSidecar = {
  prepare(input: HarnessFrontDoorInput): Promise<HarnessFrontDoorResult>
}

export type HarnessExitDoorInput = {
  taskPrompt: string
  output: string
  artifacts: readonly string[]
  browserBinding?: HarnessSidecarBrowserBinding | undefined
}

export type HarnessExitDoorResult = {
  protocol: typeof HARNESS_SIDECAR_PROTOCOL
  kind: 'exit_door'
  engine: string
  summary: string
  labels: readonly string[]
}

export type HarnessExitDoorSidecar = {
  finalize(input: HarnessExitDoorInput): Promise<HarnessExitDoorResult>
}
