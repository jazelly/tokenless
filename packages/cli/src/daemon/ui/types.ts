export type JsonRecord = Record<string, any>

export type Language = 'en' | 'zh-CN'

export type Section = 'overview' | 'profiles' | 'providers' | 'capabilities' | 'routing' | 'jobs' | 'system'

export type DashboardState = {
  language: Language
  offline: boolean
  section: Section
  selectedProfile: string
  snapshot: JsonRecord
}

export type SnapshotResult = {
  changed: boolean
  snapshot?: JsonRecord
}
