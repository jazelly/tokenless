<script lang="ts">
  import {
    BadgeQuestionMark,
    DollarSign,
    Gift,
    UserRoundCheck,
    UserRoundSearch,
    UserRoundX,
  } from '@lucide/svelte'
  import type { MessageKey } from '../i18n/index.js'
  import type { DashboardProviderProfileState } from '../types.js'

  let {
    providerId,
    subscriptionSupport,
    observation,
    t,
  }: {
    providerId: string
    subscriptionSupport: 'supported' | 'unsupported'
    observation: DashboardProviderProfileState['observation'] | undefined
    t: (key: MessageKey) => string
  } = $props()

  let auth = $derived(observation?.auth ?? 'unknown')
  let access = $derived(observation?.access ?? 'unknown')
  let planLabel = $derived(observation?.account?.tier.label ?? observation?.account?.subscription ?? null)
  let planKind = $derived(subscriptionSupport === 'unsupported'
    ? 'none'
    : auth !== 'authenticated' && access !== 'guest'
    ? 'none'
    : access === 'guest' || access === 'signed_in_free'
      ? 'free'
      : access === 'signed_in_paid'
        ? 'paid'
        : 'unknown')
  let paidLevel = $derived(planKind === 'paid' ? paidPlanLevel(providerId, planLabel) : 0)
  let authLabel = $derived(auth === 'authenticated'
    ? t('signedIn')
    : auth === 'unauthenticated'
      ? t('signedOut')
      : observation
        ? t('signInUnknown')
        : t('neverChecked'))
  let planTitle = $derived(planKind === 'free'
    ? access === 'guest' ? t('guestAccess') : t('freePlan')
    : planKind === 'paid'
      ? `${planLabel ? `${planLabel} · ` : ''}${t('paidPlan')} ${paidLevel}/3`
      : t('planUnknown'))

  function paidPlanLevel(id: string, label: string | null): 1 | 2 | 3 {
    const normalized = label?.trim().toLowerCase() ?? ''
    if (
      /enterprise|business|team|premium|高级套餐/.test(normalized) ||
      (id === 'chatgpt' && normalized === 'pro')
    ) return 3
    if (/plus|max|加强套餐/.test(normalized) || normalized === 'supergrok') return 2
    return 1
  }
</script>

<span
  class="provider-access-indicators"
  data-testid={`provider-access-${providerId}`}
  data-auth={auth}
  data-plan={planKind}
  data-subscription-support={subscriptionSupport}
  data-paid-level={paidLevel || undefined}
>
  <span class={`provider-access-indicator auth-${auth}`} title={authLabel} aria-label={authLabel}>
    {#if auth === 'authenticated'}
      <UserRoundCheck size={15} />
    {:else if auth === 'unauthenticated'}
      <UserRoundX size={15} />
    {:else}
      <UserRoundSearch size={15} />
    {/if}
  </span>

  {#if planKind !== 'none'}
    <span class={`provider-access-indicator plan-${planKind}`} title={planTitle} aria-label={planTitle}>
      {#if planKind === 'free'}
        <Gift size={15} />
      {:else if planKind === 'paid'}
        {#each Array(paidLevel) as _}
          <DollarSign size={14} />
        {/each}
      {:else}
        <BadgeQuestionMark size={15} />
      {/if}
    </span>
  {/if}
</span>
