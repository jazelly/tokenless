<script lang="ts">
  import PageHeader from '../components/PageHeader.svelte'
  import type { DashboardRateLimitRule } from 'tokenless-internal-shared/dashboard'
  import type { DashboardSnapshot, Language } from '../types.js'
  import type { MessageKey } from '../i18n/index.js'

  let { snapshot, language, t }: { snapshot: DashboardSnapshot; language: Language; t: (key: MessageKey) => string } = $props()
  let provider = $state('')
  let requestType = $state('')
  let enforcement = $state('')
  const words = {
    en: {
      intro: 'Provider rules by request type, plan, and model. This catalog covers all profiles.',
      note: 'Source records retain their original dates; they have not been rechecked here. Unknown does not mean unlimited or supported. Message submission, image generation, and file upload may use different or shared pools.',
      allTypes: 'All request types', allStates: 'All rule states', request: 'Request type', applies: 'Plan / model', window: 'Window', allowance: 'Allowance', state: 'Execution', evidence: 'Source / details', rules: 'rules',
      message: 'Messages', image: 'Image generation', file: 'File upload', shared: 'Interaction / multiple actions',
      preflight: 'Conditional preflight', non_numeric: 'No numeric cap', pending: 'Not enforced yet', unknown: 'Unknown',
      internal: 'Internal policy', source: 'Catalog source', scope: 'Scope', modes: 'Modes', actions: 'Counted actions', all: 'All',
      perProfile: 'Provider + profile', pendingScope: 'Scope to confirm', browser: 'Browser execution',
      seconds: 'sec', minutes: 'min', hours: 'hr', days: 'days', rolling: 'Rolling', requestWindow: 'Per request', managed: 'Provider managed',
      dynamic: 'Dynamic', relative: 'Relative allowance', guardrailed_unlimited: 'Unlimited with guardrails', consumption_based: 'Usage based', qualitative: 'Qualitative only',
      usage: 'usage units', messageUnit: 'messages', fileUnit: 'files', searchUnit: 'searches',
      details: 'Details', review: 'Catalog reviewed', nextReview: 'Review due', received: 'Source retrieved',
      internalNote: 'Both windows apply together. These values are recorded for the next implementation; request counting and profile scope still need confirmation.',
      executionNote: 'Conditional preflight applies only when the plan, model, action, and browser mode match. It may reduce the catalog allowance for headroom and pacing; it is not an atomic submission cap.',
      usageNote: 'Live usage and reset times are not connected to this table yet.',
    },
    'zh-CN': {
      intro: '按请求类型、套餐和模型查看各家 provider 的限流规则。本表覆盖所有 profile。',
      note: '来源保留原始日期，本次未重新核实。未知不代表无限额度或支持该能力。消息提交、图片生成和文件上传可能使用独立或共享额度。',
      allTypes: '全部请求类型', allStates: '全部规则状态', request: '请求类型', applies: '套餐 / 模型', window: '时间窗口', allowance: '额度', state: '执行状态', evidence: '来源 / 详情', rules: '条规则',
      message: '消息提交', image: '图片生成', file: '文件上传', shared: '交互 / 多类操作',
      preflight: '条件匹配时预检', non_numeric: '无数值上限拦截', pending: '尚未执行', unknown: '未知',
      internal: '内部规则', source: '目录来源', scope: '计数范围', modes: '模式', actions: '计数操作', all: '全部',
      perProfile: 'Provider + profile', pendingScope: '计数范围待确认', browser: '浏览器执行',
      seconds: '秒', minutes: '分钟', hours: '小时', days: '天', rolling: '滚动', requestWindow: '单次请求', managed: 'Provider 管理',
      dynamic: '动态额度', relative: '相对额度', guardrailed_unlimited: '无限额度，受保护规则约束', consumption_based: '按用量计算', qualitative: '仅有定性说明',
      usage: '用量单位', messageUnit: '条消息', fileUnit: '个文件', searchUnit: '次搜索',
      details: '详情', review: '目录核查日期', nextReview: '待复核日期', received: '来源获取日期',
      internalNote: '两个窗口同时生效。这些数值已记录，等待接入执行；请求计数口径和 profile 范围仍待确认。',
      executionNote: '额度预检仅在套餐、模型、操作及浏览器模式匹配时适用，可能按余量和节奏下调目录额度；尚不是提交前的原子硬上限。',
      usageNote: '本表暂未接入实时用量和恢复时间。',
    },
  }
  const copy = $derived(words[language])
  const catalog = $derived(snapshot.rateLimits)
  const providers = $derived([...new Map(catalog.rules.map((row) => [row.provider, row.providerLabel])).entries()].sort((a, b) => a[1].localeCompare(b[1])))
  const rows = $derived(catalog.rules.filter((row) => (!provider || row.provider === provider) && (!requestType || row.requestType === requestType || (requestType === 'message' && row.actions.includes('prompt.submit')) || (requestType === 'file' && row.actions.includes('file.upload'))) && (!enforcement || row.enforcement === enforcement)))
  function windowLabel(row: DashboardRateLimitRule) {
    if (row.windowKind === 'request') return copy.requestWindow
    if (row.windowSeconds === null) return row.windowKind === 'none' ? copy.managed : copy.unknown
    const seconds = row.windowSeconds
    const duration = seconds % 86400 === 0 ? `${seconds / 86400} ${copy.days}` : seconds % 3600 === 0 ? `${seconds / 3600} ${copy.hours}` : seconds % 60 === 0 ? `${seconds / 60} ${copy.minutes}` : `${seconds} ${copy.seconds}`
    return `${duration} · ${row.windowKind === 'rolling' ? copy.rolling : copy.managed}`
  }
  function allowanceLabel(row: DashboardRateLimitRule) {
    if (row.count !== null) {
      const unit = row.unit === 'message' ? copy.messageUnit : row.unit === 'file' ? copy.fileUnit : row.unit === 'search' ? copy.searchUnit : copy.usage
      return `${row.count} ${unit}`
    }
    if (row.allowanceKind === 'relative' || row.allowanceKind === 'relative_range') return copy.relative
    if (row.allowanceKind === 'dynamic') return copy.dynamic
    if (row.allowanceKind === 'guardrailed_unlimited') return copy.guardrailed_unlimited
    if (row.allowanceKind === 'consumption_based') return copy.consumption_based
    if (row.allowanceKind === 'qualitative') return copy.qualitative
    return copy.unknown
  }
  function list(values: string[]) { return values.length === 0 ? copy.unknown : values.includes('*') ? copy.all : values.join(', ') }
</script>

<div class="page">
<PageHeader title={t('rateLimits')} description={copy.intro} />
<section class="rate-limits" data-testid="rate-limits">
  <div class="rate-filters">
    <label>{t('provider')}<select bind:value={provider} data-testid="rate-provider"><option value="">{t('allProviders')}</option>{#each providers as [id, label]}<option value={id}>{label}</option>{/each}</select></label>
    <label>{copy.request}<select bind:value={requestType} data-testid="rate-type"><option value="">{copy.allTypes}</option>{#each ['message', 'image', 'file', 'shared'] as type}<option value={type}>{copy[type as 'message' | 'image' | 'file' | 'shared']}</option>{/each}</select></label>
    <label>{copy.state}<select bind:value={enforcement} data-testid="rate-state"><option value="">{copy.allStates}</option>{#each ['pending', 'preflight', 'non_numeric', 'unknown'] as state}<option value={state}>{copy[state as 'pending' | 'preflight' | 'non_numeric' | 'unknown']}</option>{/each}</select></label>
    <span class="rate-count" aria-live="polite">{rows.length} / {catalog.rules.length} {copy.rules}</span>
  </div>
  <p class="rate-note">{copy.note}</p>
  <div class="rate-scroll">
    <table>
      <caption class="sr-only">{t('rateLimits')}</caption>
      <thead><tr><th>{t('provider')}</th><th>{copy.request}</th><th>{copy.applies}</th><th>{copy.window}</th><th>{copy.allowance}</th><th>{copy.state}</th><th>{copy.evidence}</th></tr></thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr data-rule-id={row.id} class:internal={row.enforcement === 'pending'}>
            <th scope="row">{row.providerLabel}</th>
            <td>{copy[row.requestType]}</td>
            <td class="rate-applies"><span>{list(row.plans)}</span><small>{list(row.models)}</small></td>
            <td>{windowLabel(row)}</td>
            <td><strong>{allowanceLabel(row)}</strong></td>
            <td><span class="rate-state" class:pending={row.enforcement === 'pending'}>{copy[row.enforcement]}</span></td>
            <td>
              <details><summary>{row.enforcement === 'pending' ? copy.internal : row.sources.length ? copy.source : copy.details}</summary>
                <div class="rate-details">
                  <code>{row.id}</code>
                  <p>{copy.scope}: {row.scope === 'provider_profile' ? copy.perProfile : row.scope === 'pending' ? copy.pendingScope : copy.unknown}</p>
                  <p>{copy.actions}: {row.actions.join(', ') || copy.unknown}</p>
                  <p>{copy.modes}: {row.enforcement === 'unknown' ? copy.unknown : copy.browser}{row.modes.length ? ` · ${row.modes.join(', ')}` : ''}</p>
                  {#if row.enforcement === 'pending'}<p>{copy.internalNote}</p>{:else if row.enforcement === 'preflight'}<p>{copy.executionNote}</p>{/if}
                  {#if row.allowanceDetails && row.count === null && row.allowanceKind !== 'unknown'}<pre>{JSON.stringify(row.allowanceDetails, null, 2)}</pre>{/if}
                  {#each row.sources as source}<p><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><small>{copy.received}: {source.retrievedAt}</small></p>{/each}
                </div>
              </details>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}<p class="empty-state">{t('noResults')}</p>{/if}
  </div>
  <footer><span>{copy.review}: {catalog.reviewedAt} · {copy.nextReview}: {catalog.reviewAfter}</span><span>{copy.usageNote}</span></footer>
</section>
</div>

<style>
  .rate-limits { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: hidden; }
  .rate-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 16px; padding: 20px; }
  label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
  select { min-width: 170px; max-width: 260px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 6px; color: var(--ink); background: var(--surface); }
  .rate-count { margin-left: auto; padding-bottom: 10px; color: var(--muted); font-size: 12px; }
  .rate-note { padding: 0 20px 18px; max-width: 1000px; color: var(--muted); font-size: 12px; line-height: 1.6; }
  .rate-scroll { overflow-x: auto; }
  table { width: 100%; min-width: 980px; border-collapse: collapse; text-align: left; font-size: 12px; }
  th, td { padding: 14px 16px; border-top: 1px solid var(--line); vertical-align: top; line-height: 1.6; }
  thead { color: var(--muted); background: var(--surface-muted); }
  th { font-weight: 600; }
  tbody th { min-width: 130px; }
  .rate-applies { max-width: 245px; overflow-wrap: anywhere; }
  small { display: block; margin-top: 4px; font-size: 11px; }
  .rate-state { display: inline-block; color: var(--muted); white-space: nowrap; }
  .rate-state.pending { color: #8a570a; }
  tr.internal { background: #fffaf0; }
  summary { cursor: pointer; white-space: nowrap; }
  .rate-details { min-width: 210px; max-width: 310px; padding-top: 10px; overflow-wrap: anywhere; }
  .rate-details p { margin: 8px 0; }
  code, pre { font-size: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  a { text-decoration: underline; }
  footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; padding: 16px 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
</style>
