import { escapeHtml, formatAge, formatTime } from './formatting.js'
import { capabilityFamilyLabel, capabilityText, translate, type MessageKey } from './localization.js'
import type { DashboardState, JsonRecord } from './types.js'

export class ViewContext {
  constructor(readonly state: DashboardState) {}

  get language() { return this.state.language }
  get offline() { return this.state.offline }
  get section() { return this.state.section }
  get selectedProfile() { return this.state.selectedProfile }
  get snapshot() { return this.state.snapshot }

  t(key: MessageKey) { return translate(this.language, key) }
  esc(value: unknown) { return escapeHtml(value) }
  time(value: unknown) { return formatTime(value, this.language) }
  age(value: unknown) { return formatAge(value, this.language, this.t('neverChecked')) }
  capabilityText(capability: JsonRecord) { return capabilityText(this.language, capability) }
  capabilityFamilyLabel(family: string) { return capabilityFamilyLabel(this.language, family) }

  diagnosticMessage(item: JsonRecord) {
    if (this.language !== 'zh-CN') return item.message
    if (item.id === 'configuration') return item.state === 'ok' ? this.t('configPersisted') : this.t('setupIncomplete')
    if (item.id === 'browser-runtime') return item.state === 'ok' ? this.t('browserReady') : this.t('browserUnavailable')
    if (item.id === 'profiles') return this.snapshot.profiles.length === 0
      ? this.t('noManagedProfiles')
      : `${this.snapshot.profiles.length} ${this.t('profilesRegistered')}`
    if (item.id === 'scheduler') return `${this.snapshot.runtime.activeJobCount} ${this.t('activeBrowserJobs')}`
    return this.t('requestFailed')
  }
}
