import type { JsonRecord } from '../types.js'
import type { ViewContext } from '../view-context.js'
import { pageHeader } from './shared.js'

const browsers = ['auto', 'chrome', 'brave', 'edge', 'arc', 'chromium', 'chrome-for-testing', 'managed-chromium', 'cloak']

export function renderSystem(context: ViewContext) {
  const config = context.snapshot.config
  const copyButton = `<button class="button" data-action="copy-diagnostics">${context.esc(context.t('copyDiagnostics'))}</button>`
  return `<section class="page">${pageHeader(context, context.t('settingsDiagnostics'), context.t('systemLede'), copyButton)}
    <section class="panel pad"><form id="config-form" class="form-grid"><div class="field"><label for="language">${context.esc(context.t('language'))}</label><select id="language" name="language"><option value="en" ${config.language === 'en' ? 'selected' : ''}>English</option><option value="zh-CN" ${config.language === 'zh-CN' ? 'selected' : ''}>简体中文</option></select></div><div class="field"><label for="browser">${context.esc(context.t('browserSelection'))}</label><select id="browser" name="browser">${browsers.map((value) => `<option ${config.browser === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="field"><label for="visibility">${context.esc(context.t('defaultVisibility'))}</label><select id="visibility" name="browserVisibility">${['auto', 'headed', 'headless'].map((value) => `<option ${config.browserVisibility === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="field"><span>${context.esc(context.t('savedAt'))}</span><strong>${context.esc(context.time(config.updatedAt))}</strong></div><div class="form-actions"><button class="button" type="button" data-action="quiesce-runtime">${context.esc(context.t('quiesce'))}</button><button class="button primary" type="submit">${context.esc(context.t('save'))}</button></div></form></section>
    <section class="section"><div class="section-title"><h2>${context.esc(context.t('diagnostics'))}</h2><p>${context.esc(context.time(context.snapshot.generatedAt))}</p></div><div class="panel"><ul class="list">${context.snapshot.diagnostics.map((item: JsonRecord) => `<li class="list-row"><div class="row-title"><strong>${context.esc(item.id)}</strong><span>${context.esc(context.diagnosticMessage(item))}</span></div><span class="status ${item.state === 'ok' ? 'ok' : item.state === 'error' ? 'error' : 'warn'}">${context.esc(item.state)}</span><span></span><span></span></li>`).join('')}</ul></div></section>
  </section>`
}
