import type { JsonRecord } from '../types.js'
import type { ViewContext } from '../view-context.js'

export function pageHeader(context: ViewContext, title: string, lede: string, tools = '') {
  return `<header class="page-head"><div><p class="eyebrow">Tokenless / ${context.esc(context.t('localConsole'))}</p><h1>${context.esc(title)}</h1><p class="lede">${context.esc(lede)}</p></div>${tools ? `<div class="toolbar">${tools}</div>` : ''}</header>`
}

export function emptyState(context: ViewContext, title: string, body: string) {
  return `<div class="empty"><strong>${context.esc(title)}</strong>${context.esc(body)}</div>`
}

export function metric(context: ViewContext, label: string, value: unknown, note: string) {
  return `<article class="panel metric"><span class="metric-label">${context.esc(label)}</span><div><div class="metric-value">${context.esc(value)}</div><div class="metric-note">${context.esc(note)}</div></div></article>`
}

export function jobRows(context: ViewContext, jobs: JsonRecord[], compact = false) {
  if (!jobs.length) return emptyState(context, context.t('noJobs'), context.t('noJobsBody'))
  return `<ul class="list">${jobs.map((job) => `<li class="list-row" data-job-row data-status="${context.esc(job.status)}" data-provider="${context.esc(job.provider)}" data-profile="${context.esc(job.profileId)}" data-search="${context.esc(`${job.jobId} ${job.taskId ?? ''} ${job.agent?.sessionId ?? ''}`.toLowerCase())}"><div class="row-title"><strong>${context.esc(job.taskId ?? job.action)}</strong><span>${context.esc(job.jobId)}</span></div><span class="status ${context.esc(job.status)}">${context.esc(job.status)}</span><span class="secondary">${context.esc(context.age(job.updatedAt))}</span>${compact ? `<button class="button" data-nav="jobs">${context.esc(context.t('details'))}</button>` : `<button class="button" data-action="job-detail" data-job="${context.esc(job.jobId)}">${context.esc(context.t('details'))}</button>`}</li>`).join('')}</ul>`
}
