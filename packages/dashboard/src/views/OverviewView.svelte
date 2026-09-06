<script lang="ts">
  import { Activity, CircleHelp, RefreshCw } from '@lucide/svelte'
  import TokenUnit from '../components/TokenUnit.svelte'
  import MetricCard from '../components/MetricCard.svelte'
  import { capabilityFamilyLabel, capabilityText, type MessageKey } from '../i18n/index.js'
  import { formatNumber } from '../formatting.js'
  import type {
    DashboardActions,
    DashboardAnalytics,
    DashboardAnalyticsCapabilityMatrixCell,
    DashboardAnalyticsRange,
    DashboardSnapshot,
    Language,
  } from '../types.js'

  let { snapshot, selectedProfile, language, t, actions }: {
    snapshot: DashboardSnapshot
    selectedProfile: string
    language: Language
    t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
    actions: DashboardActions
  } = $props()

  const ranges: Array<{ id: DashboardAnalyticsRange; key: MessageKey }> = [
    { id: '7d', key: 'range7d' },
    { id: '30d', key: 'range30d' },
    { id: '90d', key: 'range90d' },
    { id: '1y', key: 'range1y' },
    { id: 'all', key: 'rangeAll' },
  ]
  const families = [
    'conversation',
    'input',
    'retrieval_reasoning',
    'media_generation',
    'artifact_generation',
    'workspace_knowledge',
    'evidence_lifecycle',
  ]
  const lineChart = { left: 52, right: 716, top: 18, bottom: 206 }

  let range = $state<DashboardAnalyticsRange>('30d')
  let analytics = $state<DashboardAnalytics | null>(null)
  let loading = $state(true)
  let loadError = $state('')
  let requestSequence = 0
  let activityKey = $derived(`${snapshot.jobs[0]?.updatedAt ?? ''}:${snapshot.outputSavings.summary.lastMeasuredAt ?? ''}`)
  let topProvider = $derived(analytics?.providers[0] ?? null)
  let matrixMaximum = $derived(Math.max(1, ...(analytics?.capabilityMatrix.map((entry) => entry.finishedJobs) ?? [0])))
  let outcomeMaximum = $derived(Math.max(1, ...(analytics?.daily.map((entry) => entry.finishedJobs) ?? [0])))
  let capabilityDailyMaximum = $derived(Math.max(1, ...(analytics?.daily.map((entry) => Object.values(entry.capabilityFamilies).reduce((sum, value) => sum + value, 0)) ?? [0])))
  let lineMaximum = $derived(Math.max(1, ...(analytics?.daily.map((entry) => entry.cumulativeEstimatedOutputTokens) ?? [0])))
  $effect(() => {
    const profile = selectedProfile
    const currentRange = range
    const currentActivity = activityKey
    void loadAnalytics(profile, currentRange, currentActivity)
  })

  async function loadAnalytics(profile: string, selectedRange: DashboardAnalyticsRange, _activity: string) {
    const sequence = ++requestSequence
    loading = true
    loadError = ''
    try {
      const result = await actions.getAnalytics(profile, selectedRange)
      if (sequence !== requestSequence) return
      analytics = result
    } catch (error) {
      if (sequence !== requestSequence) return
      loadError = error instanceof Error ? error.message : t('analyticsUnavailable')
    } finally {
      if (sequence === requestSequence) loading = false
    }
  }

  function providerName(providerId: string) {
    return snapshot.providers.find((provider) => provider.id === providerId)?.label ?? providerId
  }

  function capabilityName(capabilityId: string) {
    const capability = snapshot.capabilities.find((entry) => entry.id === capabilityId)
    return capability ? capabilityText(language, capability).title : capabilityId
  }

  function formatPercent(value: number | null) {
    if (value === null) return '—'
    return new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(value)
  }

  function formatDay(day: string) {
    return new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${day}T00:00:00.000Z`))
  }

  function formatCoverage(value: string | null) {
    return value ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value)) : '—'
  }

  function lineX(index: number) {
    const count = analytics?.daily.length ?? 0
    return count <= 1 ? lineChart.left : lineChart.left + (index / (count - 1)) * (lineChart.right - lineChart.left)
  }

  function lineY(value: number) {
    return lineChart.bottom - (value / lineMaximum) * (lineChart.bottom - lineChart.top)
  }

  function linePath() {
    return analytics?.daily.map((point, index) => `${index === 0 ? 'M' : 'L'} ${lineX(index).toFixed(1)} ${lineY(point.cumulativeEstimatedOutputTokens).toFixed(1)}`).join(' ') ?? ''
  }

  function areaPath() {
    if (!analytics?.daily.length) return ''
    return `${linePath()} L ${lineX(analytics.daily.length - 1).toFixed(1)} ${lineChart.bottom} L ${lineX(0).toFixed(1)} ${lineChart.bottom} Z`
  }

  function matrixCell(provider: string, family: string): DashboardAnalyticsCapabilityMatrixCell | undefined {
    return analytics?.capabilityMatrix.find((entry) => entry.provider === provider && entry.family === family)
  }

  function supportsFamily(provider: string, family: string) {
    return snapshot.capabilities.some((capability) => capability.family === family && capability.providers.some((route) => route.provider === provider))
  }

  function capabilityTitle(provider: string, family: string) {
    const cell = matrixCell(provider, family)
    if (cell?.finishedJobs) return `${providerName(provider)} · ${capabilityFamilyLabel(language, family)} · ${formatNumber(cell.finishedJobs, language)} ${t('routedRequirements')}. ${t('matrixCellOutcomes', { succeeded: cell.succeededJobs, failed: cell.failedJobs, canceled: cell.canceledJobs })}`
    return `${providerName(provider)} · ${capabilityFamilyLabel(language, family)} · ${t(supportsFamily(provider, family) ? 'supportedUnused' : 'unsupportedCapability')}`
  }

  function heatLevel(count: number) {
    return Math.max(1, Math.min(5, Math.ceil(count / matrixMaximum * 5)))
  }

  function familyColor(family: string) {
    return `family-${Math.max(0, families.indexOf(family))}`
  }
</script>

{#snippet chartTitle(title: string, help: string)}
  <div class="analytics-chart-title">
    <h2>{title}</h2>
    <button class="icon-button subtle help-trigger hover-tooltip tooltip-below tooltip-right" type="button" aria-label={help}>
      <CircleHelp size={14} aria-hidden="true" />
      <span class="hover-tooltip-content" role="tooltip" aria-hidden="true">{help}</span>
    </button>
  </div>
{/snippet}

<section class="page analytics-page" data-testid="overview-view">
  <header class="analytics-header">
    <h1>{t('analyticsTitle')}</h1>
    <div class="analytics-range" aria-label={t('selectedRange')}>
      {#each ranges as option}
        <button type="button" class:active={range === option.id} aria-pressed={range === option.id} data-testid={`analytics-range-${option.id}`} onclick={() => range = option.id}>{t(option.key)}</button>
      {/each}
    </div>
  </header>

  {#if loading && !analytics}
    <div class="analytics-state" data-testid="analytics-loading"><Activity size={22} />{t('analyticsLoading')}</div>
  {:else if loadError && !analytics}
    <div class="analytics-state error" role="alert"><strong>{t('analyticsUnavailable')}</strong><span>{loadError}</span><button class="button" type="button" onclick={() => loadAnalytics(selectedProfile, range, activityKey)}><RefreshCw size={15} />{t('retryAnalytics')}</button></div>
  {:else if analytics}
    <div class="analytics-two-column">
      <figure class="analytics-panel chart-panel" data-testid="analytics-cumulative-chart">
        <header class="analytics-panel-header">{@render chartTitle(t('cumulativeSavings'), `${t('cumulativeSavingsHelp')} ${t('measurementCoverage')}: ${formatCoverage(analytics.measurementCoverage.firstMeasuredAt)}–${formatCoverage(analytics.measurementCoverage.lastMeasuredAt)}. ${t('utcDays')}`)}<span class="token-quantity"><strong>{analytics.daily.length ? formatNumber(analytics.daily.at(-1)?.cumulativeEstimatedOutputTokens ?? 0, language) : '—'}</strong><TokenUnit {language} size={20} /></span></header>
        <p class="analytics-unit-note">{t('estimatedTokenUnit')}</p>
        {#if analytics.daily.some((entry) => entry.cumulativeEstimatedOutputTokens > 0)}
          <svg class="analytics-line-chart" viewBox="0 0 740 238" role="img" aria-label={t('cumulativeSavings')}>
            <defs><linearGradient id="analytics-line-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--chart-primary)" stop-opacity=".28"/><stop offset="1" stop-color="var(--chart-primary)" stop-opacity="0"/></linearGradient></defs>
            {#each [0, .25, .5, .75, 1] as tick}
              <line x1={lineChart.left} x2={lineChart.right} y1={lineChart.bottom - tick * (lineChart.bottom - lineChart.top)} y2={lineChart.bottom - tick * (lineChart.bottom - lineChart.top)} class="chart-grid-line" />
              <text x="45" y={lineChart.bottom - tick * (lineChart.bottom - lineChart.top) + 4} text-anchor="end">{formatNumber(Math.round(lineMaximum * tick), language)}</text>
            {/each}
            <path d={areaPath()} class="chart-area" /><path d={linePath()} class="chart-line" />
            {#each analytics.daily as point, index}
              {#if analytics.daily.length <= 45 || index === 0 || index === analytics.daily.length - 1 || index % Math.ceil(analytics.daily.length / 24) === 0}
                <circle cx={lineX(index)} cy={lineY(point.cumulativeEstimatedOutputTokens)} r="3.2"><title>{formatDay(point.day)} · +{formatNumber(point.estimatedOutputTokens, language)} tokens · {formatNumber(point.cumulativeEstimatedOutputTokens, language)} tokens</title></circle>
              {/if}
            {/each}
            <text x={lineChart.left} y="230">{formatDay(analytics.range.fromDay)}</text><text x={lineChart.right} y="230" text-anchor="end">{formatDay(analytics.range.toDay)}</text>
          </svg>
        {:else}<div class="analytics-empty chart-empty">{t('noMeasuredSavings')}</div>{/if}
        <figcaption><span><strong class="token-quantity">+{formatNumber(analytics.totals.estimatedOutputTokens, language)}<TokenUnit {language} /></strong> {t('addedInRange')}</span></figcaption>
      </figure>

      <figure class="analytics-panel chart-panel" data-testid="analytics-outcomes-chart">
        <header class="analytics-panel-header">{@render chartTitle(t('dailyOutcomes'), t('dailyOutcomesHelp'))}</header>
        <p class="analytics-unit-note">{t('jobsCountUnit')}</p>
        <div class="stacked-day-chart" style={`grid-template-columns:repeat(${analytics.daily.length}, minmax(2px, 1fr))`}>
          {#each analytics.daily as point}
            <div class="stacked-day-column" title={`${formatDay(point.day)} · ${point.succeededJobs} ${t('succeeded')} · ${point.failedJobs} ${t('failed')} · ${point.canceledJobs} ${t('canceled')}`}><span class="outcome-succeeded" style={`height:${point.succeededJobs / outcomeMaximum * 100}%`}></span><span class="outcome-failed" style={`height:${point.failedJobs / outcomeMaximum * 100}%`}></span><span class="outcome-canceled" style={`height:${point.canceledJobs / outcomeMaximum * 100}%`}></span></div>
          {/each}
        </div>
        <div class="chart-date-axis"><span>{formatDay(analytics.range.fromDay)}</span><span>{formatDay(analytics.range.toDay)}</span></div>
        <figcaption class="chart-legend"><span><i class="outcome-succeeded"></i>{t('succeeded')} · {formatNumber(analytics.totals.succeededJobs, language)}</span><span><i class="outcome-failed"></i>{t('failed')} · {formatNumber(analytics.totals.failedJobs, language)}</span><span><i class="outcome-canceled"></i>{t('canceled')} · {formatNumber(analytics.totals.canceledJobs, language)}</span></figcaption>
      </figure>
    </div>

    <div class="analytics-kpis" data-testid="analytics-kpis">
      <MetricCard icon="provider" label={t('mostUsedProvider')} value={topProvider ? providerName(topProvider.provider) : '—'} detail={topProvider ? `${formatPercent(topProvider.share)} · ${formatNumber(topProvider.finishedJobs, language)} ${t('completedJobs')}` : t('noUsageYet')} />
      <MetricCard label={t('completedJobs')} value={formatNumber(analytics.totals.finishedJobs, language)} detail={`${t('selectedRange')} · ${formatDay(analytics.range.fromDay)}–${formatDay(analytics.range.toDay)}`} />
      <MetricCard icon="success" label={t('successRate')} value={formatPercent(analytics.totals.successRate)} detail={`${formatNumber(analytics.totals.succeededJobs, language)} ${t('succeeded')} · ${formatNumber(analytics.totals.failedJobs, language)} ${t('failed')}`} />
      <MetricCard icon="capability" label={t('capabilityBreadth')} value={`${formatNumber(analytics.totals.capabilitiesUsed, language)}/${formatNumber(analytics.totals.catalogCapabilities, language)}`} detail={t('capabilityBreadthValue', { used: formatNumber(analytics.totals.capabilitiesUsed, language), total: formatNumber(analytics.totals.catalogCapabilities, language) })} />
    </div>

    <section class="analytics-panel capability-matrix-panel" data-testid="capability-usage-matrix">
      <header class="analytics-panel-header">{@render chartTitle(t('capabilityUsageMatrix'), t('capabilityUsageMatrixHelp'))}</header>
      <p class="analytics-unit-note">{t('capabilityCountUnit')}</p>
      <div class="capability-matrix-scroll"><div class="capability-matrix" style={`--family-count:${families.length}`}>
        <div class="capability-matrix-corner">{t('provider')}</div>
        {#each families as family}<div class="capability-matrix-family">{capabilityFamilyLabel(language, family)}</div>{/each}
        {#each analytics.providers as provider}
          <div class="capability-matrix-provider">{providerName(provider.provider)}</div>
          {#each families as family}
            {@const cell = matrixCell(provider.provider, family)}
            {@const supported = supportsFamily(provider.provider, family)}
            {@const level = heatLevel(cell?.finishedJobs ?? 0)}
            <div class:used={Boolean(cell?.finishedJobs)} class:supported class:absent={!cell?.finishedJobs && !supported} class="capability-matrix-cell" style={`--cell-fill:var(--heat-${level});--cell-ink:var(--stone-${level >= 4 ? 0 : 950})`} title={capabilityTitle(provider.provider, family)} role="img" aria-label={capabilityTitle(provider.provider, family)}><span class="capability-matrix-value">{cell?.finishedJobs ? formatNumber(cell.finishedJobs, language) : supported ? '0' : '—'}</span></div>
          {/each}
        {:else}<div class="analytics-empty capability-matrix-empty">{t('noCapabilityUsage')}</div>{/each}
      </div></div>
      <div class="matrix-legend"><span><i class="matrix-key used" aria-hidden="true"></i>{t('matrixUsedLegend')}</span><span><i class="matrix-key" aria-hidden="true"></i>{t('matrixZeroLegend')}</span><span><i class="matrix-key absent" aria-hidden="true">—</i>{t('matrixAbsentLegend')}</span></div>
    </section>

    <div class="analytics-two-column analytics-bottom-grid">
      <figure class="analytics-panel chart-panel" data-testid="capability-mix-chart">
        <header class="analytics-panel-header">{@render chartTitle(t('capabilityMix'), t('capabilityMixHelp'))}</header>
        <p class="analytics-unit-note">{t('capabilityCountUnit')}</p>
        {#if analytics.capabilityFamilies.length}
          <div class="stacked-day-chart capability-day-chart" style={`grid-template-columns:repeat(${analytics.daily.length}, minmax(2px, 1fr))`}>
            {#each analytics.daily as point}
              {@const total = Object.values(point.capabilityFamilies).reduce((sum, value) => sum + value, 0)}
              <div class="stacked-day-column" title={`${formatDay(point.day)} · ${formatNumber(total, language)} ${t('routedRequirements')}`}>{#each families as family}<span class={familyColor(family)} style={`height:${(point.capabilityFamilies[family] ?? 0) / capabilityDailyMaximum * 100}%`}></span>{/each}</div>
            {/each}
          </div>
          <div class="chart-date-axis"><span>{formatDay(analytics.range.fromDay)}</span><span>{formatDay(analytics.range.toDay)}</span></div>
          <figcaption class="capability-family-legend">{#each analytics.capabilityFamilies as family}<span><i class={familyColor(family.family)}></i>{capabilityFamilyLabel(language, family.family)} · {formatNumber(family.finishedJobs, language)}</span>{/each}</figcaption>
        {:else}<div class="analytics-empty chart-empty">{t('noCapabilityUsage')}</div>{/if}
      </figure>

      <div class="analytics-panel analytics-breakdowns">
        <section data-testid="top-capabilities">
          <header>{@render chartTitle(t('topCapabilities'), t('topCapabilitiesHelp'))}</header>
          <div class="top-capability-list">
            {#each analytics.capabilities.slice(0, 6) as capability}
              <div><span><strong>{capabilityName(capability.capabilityId)}</strong><small>{capabilityFamilyLabel(language, capability.family)}</small></span><span class="top-capability-bar"><i style={`width:${analytics.capabilities[0]?.finishedJobs ? capability.finishedJobs / analytics.capabilities[0].finishedJobs * 100 : 0}%`}></i></span><strong>{formatNumber(capability.finishedJobs, language)}</strong></div>
            {:else}<div class="analytics-empty">{t('noCapabilityUsage')}</div>{/each}
          </div>
        </section>
        <section data-testid="execution-mode-mix">
          <header><h2>{t('executionMix')}</h2></header>
          <div class="execution-mode-bar">{#each analytics.executionModes as mode}<span class:browser={mode.mode === 'browser'} class:direct={mode.mode === 'direct'} class:unknown={mode.mode === 'unknown'} style={`width:${mode.share * 100}%`} title={`${mode.mode} · ${formatPercent(mode.share)}`}></span>{/each}</div>
          <div class="execution-mode-legend">{#each analytics.executionModes as mode}<span><i class:browser={mode.mode === 'browser'} class:direct={mode.mode === 'direct'} class:unknown={mode.mode === 'unknown'}></i>{mode.mode === 'browser' ? t('browserMode') : mode.mode === 'direct' ? t('directMode') : t('unknownMode')} · {formatNumber(mode.finishedJobs, language)} · {formatPercent(mode.share)}</span>{/each}</div>
        </section>
      </div>
    </div>
  {/if}
</section>
