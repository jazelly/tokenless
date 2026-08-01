import { translate } from './localization.js'
import { renderCapabilities } from './pages/capabilities.js'
import { renderJobs } from './pages/jobs.js'
import { renderOverview } from './pages/overview.js'
import { renderProfiles } from './pages/profiles.js'
import { renderProviders } from './pages/providers.js'
import { renderSystem } from './pages/system.js'
import type { DashboardState, Language, Section } from './types.js'
import { ViewContext } from './view-context.js'

const navigation: Section[] = ['overview', 'profiles', 'providers', 'capabilities', 'jobs', 'system']

export function renderDashboard(state: DashboardState) {
  const context = new ViewContext(state)
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand"><img src="/ui/mark.png" alt=""><div><strong>Tokenless</strong><span>${context.esc(context.t('localConsole'))}</span></div></div>
      <nav class="nav" aria-label="${context.esc(context.t('primaryNavigation'))}">${navigation.map((item) => `<button data-nav="${item}" ${state.section === item ? 'aria-current="page"' : ''}><span>${context.esc(context.t(item))}</span></button>`).join('')}</nav>
      <label class="sidebar-language"><span>${context.esc(context.t('language'))}</span><select data-language-switch aria-label="${context.esc(context.t('language'))}"><option value="en" ${state.language === 'en' ? 'selected' : ''}>EN</option><option value="zh-CN" ${state.language === 'zh-CN' ? 'selected' : ''}>中文</option></select></label>
      <div class="sidebar-foot"><strong>${context.esc(state.snapshot.daemon.version)}</strong>${context.esc(state.snapshot.daemon.origin)}</div>
    </aside>
    <main class="workspace" id="main" tabindex="-1">
      ${state.offline ? `<div class="notice error"><div><strong>${context.esc(context.t('offline'))}</strong><br>${context.esc(context.t('offlineBody'))}</div></div>` : ''}
      ${renderSection(context)}
    </main>
  </div><div id="toast-region" aria-live="assertive"></div>`
}

export function renderFatal(language: Language, error: unknown) {
  const context = new ViewContext({
    language,
    offline: true,
    section: 'overview',
    selectedProfile: '',
    snapshot: {},
  })
  const expired = Boolean((error as { sessionExpired?: boolean })?.sessionExpired)
  const detail = expired
    ? translate(language, 'reopen')
    : error instanceof Error
      ? error.message
      : translate(language, 'offlineBody')
  return `<main class="boot-state"><img src="/ui/mark.png" alt=""><p>${context.esc(expired ? translate(language, 'sessionExpired') : translate(language, 'offline'))}</p><span>${context.esc(detail)}</span></main>`
}

function renderSection(context: ViewContext) {
  switch (context.section) {
    case 'profiles': return renderProfiles(context)
    case 'providers': return renderProviders(context)
    case 'capabilities': return renderCapabilities(context)
    case 'jobs': return renderJobs(context)
    case 'system': return renderSystem(context)
    default: return renderOverview(context)
  }
}
