export type G4fServiceHealth = {
  protocol: 'tokenless.g4f-service.v1'
  status: 'ready'
  g4fVersion: string
  pinnedG4fVersion: string
  pinnedG4fCommit: string
  workerCount: 1
  paAutoDownload: false
  requestLogging: false
  serviceRevision: number
}

export type G4fAuthLifetime = 'ephemeral' | 'user-persisted'

export type G4fAuthSource =
  | { type: 'empty' }
  | { type: 'har' }
  | { type: 'cookie-file' }
  | { type: 'browser-cookie3'; path: string; browser: 'chrome' | 'chromium' | 'brave' | 'edge' | 'firefox' | 'opera' | 'opera_gx' | 'vivaldi' }
  | { type: 'manual'; apiKey?: string; cookies?: Record<string, Record<string, string>>; headers?: Record<string, Record<string, string>> }
  | { type: 'cookie-database'; path: string; browser: 'chrome' | 'chromium' | 'brave' | 'edge' | 'firefox' | 'opera' | 'opera_gx' | 'vivaldi' }
  | { type: 'cdp'; host: '127.0.0.1' | 'localhost' | '::1'; port: number }

export type G4fAuthContextInput = {
  contextId: string
  provider: string
  profile: string
  lifetime: G4fAuthLifetime
  source: G4fAuthSource
}

export type G4fProxyRequest = {
  path: string
  method?: string
  headers?: HeadersInit
  body?: BodyInit | null
  authContextId?: string | undefined
  signal?: AbortSignal | undefined
}

export type G4fServiceProcess = {
  origin: string
  health: G4fServiceHealth
  client: import('./client.js').G4fServiceClient
  close(): Promise<void>
}
