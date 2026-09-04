<script lang="ts">
  import { Activity, RefreshCw, Sparkles } from '@lucide/svelte'
  import MetricCard from '../components/MetricCard.svelte'
  import { capabilityFamilyLabel, capabilityText, type MessageKey } from '../i18n/index.js'
  import { formatNumber } from '../formatting.js'
  import type {
    DashboardActions,
    DashboardAnalytics,
    DashboardAnalyticsCapabilityMatrixCell,
    DashboardAnalyticsProvider,
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
  let providerMetric = $state<'jobs' | 'tokens' | 'success'>('jobs')
  let selectedProvider = $state('')
  let activityKey = $derived(`${snapshot.jobs[0]?.updatedAt ?? ''}:${snapshot.outputSavings.summary.lastMeasuredAt ?? ''}`)
  let providerRows = $derived.by(() => {
    const rows = [...(analytics?.providers ?? [])]
    return rows.sort((left, right) => providerMetricValue(right) - providerMetricValue(left) || left.provider.localeCompare(right.provider))
  })
  let providerMaximum = $derived(Math.max(1, ...providerRows.map(providerMetricValue)))
  let topProvider = $derived(analytics?.providers[0] ?? null)
  let topCapability = $derived(analytics?.capabilities[0] ?? null)
  let matrixMaximum = $derived(Math.max(1, ...(analytics?.capabilityMatrix.map((entry) => entry.finishedJobs) ?? [0])))
  let outcomeMaximum = $derived(Math.max(1, ...(analytics?.daily.map((entry) => entry.finishedJobs) ?? [0])))
  let capabilityDailyMaximum = $derived(Math.max(1, ...(analytics?.daily.map((entry) => Object.values(entry.capabilityFamilies).reduce((sum, value) => sum + value, 0)) ?? [0])))
  let lineMaximum = $derived(Math.max(1, ...(analytics?.daily.map((entry) => entry.cumulativeEstimatedOutputTokens) ?? [0])))
  let insightItems = $derived.by(() => {
    if (!analytics) return []
    const result: string[] = []
    if (topProvider) result.push(t('insightMostUsed', {
      provider: providerName(topProvider.provider),
      share: formatPercent(topProvider.share),
    }))
    if (topCapability) result.push(t('insightCapability', { capability: capabilityName(topCapability.capabilityId) }))
    const topTwoShare = analytics.providers.slice(0, 2).reduce((sum, provider) => sum + provider.share, 0)
    if (analytics.providers.length > 1) result.push(t('insightConcentration', { share: formatPercent(topTwoShare) }))
    const unused = Math.max(0, analytics.totals.catalogCapabilities - analytics.totals.capabilitiesUsed)
    if (unused > 0) result.push(t('insightUnused', { count: formatNumber(unused, language) }))
    const failureHotspot = [...analytics.capabilityMatrix].sort((left, right) => right.failedJobs - left.failedJobs)[0]
    if (failureHotspot?.failedJobs) result.push(t('insightFailure', {
      provider: providerName(failureHotspot.provider),
      family: capabilityFamilyLabel(language, failureHotspot.family),
      count: formatNumber(failureHotspot.failedJobs, language),
    }))
    return result
  })

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
      if (selectedProvider && !result.providers.some((provider) => provider.provider === selectedProvider)) selectedProvider = ''
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

  function providerMetricValue(provider: DashboardAnalyticsProvider) {
    if (providerMetric === 'tokens') return provider.estimatedOutputTokens
    if (providerMetric === 'success') return provider.successRate ?? 0
    return provider.finishedJobs
  }

  function providerMetricLabel(provider: DashboardAnalyticsProvider) {
    if (providerMetric === 'tokens') return formatNumber(provider.estimatedOutputTokens, language)
    if (providerMetric === 'success') return provider.successRate === null ? '—' : formatPercent(provider.successRate)
    return formatNumber(provider.finishedJobs, language)
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
    if (cell) return `${providerName(provider)} · ${capabilityFamilyLabel(language, family)} · ${formatNumber(cell.finishedJobs, language)} ${t('routedRequirements')}`
    return `${providerName(provider)} · ${capabilityFamilyLabel(language, family)} · ${t(supportsFamily(provider, family) ? 'supportedUnused' : 'unsupportedCapability')}`
  }

  function familyColor(family: string) {
    return `family-${Math.max(0, families.indexOf(family))}`
  }
</script>

<section class="page analytics-page" data-testid="overview-view">
  <header class="analytics-header">
    <div>
      <p class="eyebrow">{t('localDashboard')}</p>
      <h1>{t('analyticsTitle')}</h1>
      <p class="page-description">{t('analyticsLede')}</p>
    </div>
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
    <div class="analytics-kpis" data-testid="analytics-kpis">
      <MetricCard icon="provider" label={t('mostUsedProvider')} value={topProvider ? providerName(topProvider.provider) : '—'} detail={topProvider ? `${formatPercent(topProvider.share)} · ${formatNumber(topProvider.finishedJobs, language)} ${t('completedJobs')}` : t('noUsageYet')} />
      <MetricCard label={t('completedJobs')} value={formatNumber(analytics.totals.finishedJobs, language)} detail={`${t('selectedRange')} · ${formatDay(analytics.range.fromDay)}–${formatDay(analytics.range.toDay)}`} />
      <MetricCard icon="success" label={t('successRate')} value={formatPercent(analytics.totals.successRate)} detail={`${formatNumber(analytics.totals.succeededJobs, language)} ${t('succeeded')} · ${formatNumber(analytics.totals.failedJobs, language)} ${t('failed')}`} />
      <MetricCard icon="capability" label={t('capabilityBreadth')} value={`${formatNumber(analytics.totals.capabilitiesUsed, language)}/${formatNumber(analytics.totals.catalogCapabilities, language)}`} detail={t('capabilityBreadthValue', { used: formatNumber(analytics.totals.capabilitiesUsed, language), total: formatNumber(analytics.totals.catalogCapabilities, language) })} />
    </div>

    <section class="analytics-insights" data-testid="analytics-insights">
      <header><Sparkles size={16} /><strong>{t('insights')}</strong></header>
      <div>{#each insightItems as insight}<p>{insight}</p>{:else}<p>{t('noUsageYet')}</p>{/each}</div>
    </section>

    <section class="analytics-panel provider-panorama" data-testid="provider-panorama">
      <header class="analytics-panel-header">
        <div><h2>{t('providerPanorama')}</h2><p>{t('providerPanoramaHelp')}</p></div>
        <div class="analytics-segmented" aria-label={t('providerPanorama')}>
          <button class:active={providerMetric === 'jobs'} aria-pressed={providerMetric === 'jobs'} onclick={() => providerMetric = 'jobs'}>{t('byJobs')}</button>
          <button class:active={providerMetric === 'tokens'} aria-pressed={providerMetric === 'tokens'} onclick={() => providerMetric = 'tokens'}>{t('byTokens')}</button>
          <button class:active={providerMetric === 'success'} aria-pressed={providerMetric === 'success'} onclick={() => providerMetric = 'success'}>{t('bySuccess')}</button>
        </div>
      </header>
      <div class="provider-panorama-head" aria-hidden="true"><span>{t('provider')}</span><span>{t('jobShare')}</span><span>{t('successRate')}</span><span>{t('capabilities')}</span><span>{t('executionMode')}</span><span>{t('lastUsed')}</span></div>
      <div class="provider-panorama-list">
        {#each providerRows as provider (provider.provider)}
          <button type="button" class:selected={selectedProvider === provider.provider} aria-pressed={selectedProvider === provider.provider} data-testid={`provider-panorama-${provider.provider}`} onclick={() => selectedProvider = selectedProvider === provider.provider ? '' : provider.provider}>
            <span class="provider-panorama-name"><span class="provider-glyph">{providerName(provider.provider).slice(0, 1)}</span><strong>{providerName(provider.provider)}</strong></span>
            <span class="provider-panorama-bar"><span style={`width:${Math.max(providerMetricValue(provider) / providerMaximum * 100, providerMetricValue(provider) > 0 ? 2 : 0)}%`}></span><strong>{providerMetricLabel(provider)}</strong></span>
            <span>{formatPercent(provider.successRate)}</span>
            <span>{formatNumber(provider.capabilitiesUsed, language)}</span>
            <span class="provider-mode-mini" title={`${t('browserMode')} ${provider.browserJobs}; ${t('directMode')} ${provider.directJobs}`}><i style={`width:${provider.finishedJobs ? provider.browserJobs / provider.finishedJobs * 100 : 0}%`}></i><i class="direct" style={`width:${provider.finishedJobs ? provider.directJobs / provider.finishedJobs * 100 : 0}%`}></i></span>
            <span>{provider.lastUsedDay ? formatDay(provider.lastUsedDay) : '—'}</span>
          </button>
        {:else}<div class="analytics-empty">{t('noProviderUsage')}</div>{/each}
      </div>
    </section>

    <div class="analytics-two-column">
      <figure class="analytics-panel chart-panel" data-testid="analytics-cumulative-chart">
        <header class="analytics-panel-header"><div><h2>{t('cumulativeSavings')}</h2><p>{t('cumulativeSavingsHelp')}</p></div><strong>{analytics.daily.length ? formatNumber(analytics.daily.at(-1)?.cumulativeEstimatedOutputTokens ?? 0, language) : '—'}</strong></header>
        {#if analytics.daily.some((entry) => entry.cumulativeEstimatedOutputTokens > 0)}
          <svg class="analytics-line-chart" viewBox="0 0 740 238" role="img" aria-label={t('cumulativeSavings')}>
            <defs><linearGradient id="analytics-line-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--chart-blue)" stop-opacity=".28"/><stop offset="1" stop-color="var(--chart-blue)" stop-opacity="0"/></linearGradient></defs>
            {#each [0, .25, .5, .75, 1] as tick}
              <line x1={lineChart.left} x2={lineChart.right} y1={lineChart.bottom - tick * (lineChart.bottom - lineChart.top)} y2={lineChart.bottom - tick * (lineChart.bottom - lineChart.top)} class="chart-grid-line" />
              <text x="45" y={lineChart.bottom - tick * (lineChart.bottom - lineChart.top) + 4} text-anchor="end">{formatNumber(Math.round(lineMaximum * tick), language)}</text>
            {/each}
            <path d={areaPath()} class="chart-area" /><path d={linePath()} class="chart-line" />
            {#each analytics.daily as point, index}
              {#if analytics.daily.length <= 45 || index === 0 || index === analytics.daily.length - 1 || index % Math.ceil(analytics.daily.length / 24) === 0}
                <circle cx={lineX(index)} cy={lineY(point.cumulativeEstimatedOutputTokens)} r="3.2"><title>{formatDay(point.day)} · +{formatNumber(point.estimatedOutputTokens, language)} · {formatNumber(point.cumulativeEstimatedOutputTokens, language)}</title></circle>
              {/if}
            {/each}
            <text x={lineChart.left} y="230">{formatDay(analytics.range.fromDay)}</text><text x={lineChart.right} y="230" text-anchor="end">{formatDay(analytics.range.toDay)}</text>
          </svg>
        {:else}<div class="analytics-empty chart-empty">{t('noMeasuredSavings')}</div>{/if}
        <figcaption><span><strong>+{formatNumber(analytics.totals.estimatedOutputTokens, language)}</strong> {t('addedInRange')}</span><span>{t('measurementCoverage')}: {formatCoverage(analytics.measurementCoverage.firstMeasuredAt)}–{formatCoverage(analytics.measurementCoverage.lastMeasuredAt)}</span><span>{t('utcDays')}</span></figcaption>
      </figure>

      <figure class="analytics-panel chart-panel" data-testid="analytics-outcomes-chart">
        <header class="analytics-panel-header"><div><h2>{t('dailyOutcomes')}</h2><p>{t('dailyOutcomesHelp')}</p></div></header>
        <div class="stacked-day-chart" style={`grid-template-columns:repeat(${analytics.daily.length}, minmax(2px, 1fr))`}>
          {#each analytics.daily as point}
            <div class="stacked-day-column" title={`${formatDay(point.day)} · ${point.succeededJobs} ${t('succeeded')} · ${point.failedJobs} ${t('failed')} · ${point.canceledJobs} ${t('canceled')}`}><span class="outcome-succeeded" style={`height:${point.succeededJobs / outcomeMaximum * 100}%`}></span><span class="outcome-failed" style={`height:${point.failedJobs / outcomeMaximum * 100}%`}></span><span class="outcome-canceled" style={`height:${point.canceledJobs / outcomeMaximum * 100}%`}></span></div>
          {/each}
        </div>
        <div class="chart-date-axis"><span>{formatDay(analytics.range.fromDay)}</span><span>{formatDay(analytics.range.toDay)}</span></div>
        <figcaption class="chart-legend"><span><i class="outcome-succeeded"></i>{t('succeeded')} · {formatNumber(analytics.totals.succeededJobs, language)}</span><span><i class="outcome-failed"></i>{t('failed')} · {formatNumber(analytics.totals.failedJobs, language)}</span><span><i class="outcome-canceled"></i>{t('canceled')} · {formatNumber(analytics.totals.canceledJobs, language)}</span></figcaption>
      </figure>
    </div>

    <section class="analytics-panel capability-matrix-panel" data-testid="capability-usage-matrix">
      <header class="analytics-panel-header"><div><h2>{t('capabilityUsageMatrix')}</h2><p>{t('capabilityUsageMatrixHelp')}</p></div></header>
      <div class="capability-matrix-scroll"><div class="capability-matrix" style={`--family-count:${families.length}`}>
        <div class="capability-matrix-corner">{t('provider')}</div>
        {#each families as family}<div class="capability-matrix-family">{capabilityFamilyLabel(language, family)}</div>{/each}
        {#each analytics.providers as provider}
          <div class:highlighted={selectedProvider === provider.provider} class="capability-matrix-provider">{providerName(provider.provider)}</div>
          {#each families as family}
            {@const cell = matrixCell(provider.provider, family)}
            {@const supported = supportsFamily(provider.provider, family)}
            <div class:used={Boolean(cell?.finishedJobs)} class:supported class:highlighted={selectedProvider === provider.provider} class="capability-matrix-cell" style={`--cell-opacity:${cell ? .18 + cell.finishedJobs / matrixMaximum * .72 : 0}`} title={capabilityTitle(provider.provider, family)} role="img" aria-label={capabilityTitle(provider.provider, family)}>{cell?.finishedJobs ? formatNumber(cell.finishedJobs, language) : ''}</div>
          {/each}
        {:else}<div class="analytics-empty capability-matrix-empty">{t('noCapabilityUsage')}</div>{/each}
      </div></div>
    </section>

    <div class="analytics-two-column analytics-bottom-grid">
      <figure class="analytics-panel chart-panel" data-testid="capability-mix-chart">
        <header class="analytics-panel-header"><div><h2>{t('capabilityMix')}</h2><p>{t('capabilityMixHelp')}</p></div></header>
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
          <header><div><h2>{t('topCapabilities')}</h2><p>{t('topCapabilitiesHelp')}</p></div></header>
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
