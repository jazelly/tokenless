<script lang="ts">
  import { onMount } from 'svelte'
  import TokenIcon from '../../src/components/TokenIcon.svelte'
  import TokenUnit from '../../src/components/TokenUnit.svelte'
  import type { Language } from '../../src/types.js'

  let { language = 'en' }: { language: Language } = $props()
  const text = (en: string, zh: string) => language === 'zh-CN' ? zh : en
  const stones = [0, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 950]
  const statuses = [
    { id: 'success', en: 'Success', zh: '成功', useEn: 'Confirmed success or ready state', useZh: '已确认成功或就绪' },
    { id: 'warning', en: 'Warning', zh: '警告', useEn: 'Attention or user action needed', useZh: '需要注意或用户操作' },
    { id: 'danger', en: 'Failure', zh: '失败', useEn: 'Failed outcome or destructive action', useZh: '失败结果或破坏性操作' },
  ]
  const hues = ['blue', 'orange', 'red', 'teal', 'green', 'yellow', 'purple']
  const hueNames = [['Blue', '蓝'], ['Orange', '橙'], ['Red', '红'], ['Teal', '青绿'], ['Green', '绿'], ['Yellow', '黄'], ['Purple', '紫']]
  const categories = [
    ['Conversation', '对话'], ['Input', '输入'], ['Search & reasoning', '检索与推理'],
    ['Media creation', '媒体生成'], ['Documents & websites', '文档与网页'],
    ['Projects & knowledge', '项目与知识'], ['Citations & task controls', '引用与任务控制'],
  ]
  let values = $state<Record<string, string>>({})
  onMount(() => {
    const css = getComputedStyle(document.documentElement)
    const names = [...hues.map(hue => `data-${hue}`), ...stones.map(n => `stone-${n}`), ...statuses.map(s => `status-${s.id}`), ...Array.from({ length: 5 }, (_, i) => `heat-${i + 1}`)]
    values = Object.fromEntries(names.map(name => [name, css.getPropertyValue(`--${name}`).trim().toUpperCase()]))
  })
</script>

<main class="foundations" data-testid="color-and-units">
  <header>
    <p class="eyebrow">Tokenless API · Design Atlas</p>
    <h1>{text('Color & units', '色板与单位')}</h1>
    <p>{text('Warm paper, graphite text, and established palettes for data.', '暖纸背景、石墨文字与成熟的数据图表色板。')}</p>
  </header>

  <section class="foundation-panel brand-intro">
    <div class="brand-sample"><TokenIcon size={64} /><span>DATA / TABLEAU BLUE</span><strong>{values['data-blue']}</strong></div>
    <div><p class="eyebrow">{text('Interface + data', '界面基底 + 数据强调色')}</p><h2>{text('A warm frame. Colorful data.', '暖色基底，彩色数据。')}</h2><p>{text('Graphite #171715 and warm paper #F6F5F2 anchor the interface. Tableau blue carries the main data series. The first seven Tableau 10 colors identify capability categories in their published order; ColorBrewer Blues provides the quantity scale.', '石墨色 #171715 与暖纸色 #F6F5F2 构成界面基底。Tableau 蓝用于主要数据系列。Tableau 10 的前七色按原始顺序区分能力类别，ColorBrewer Blues 用于数量色阶。')}</p><div class="palette-ribbon" aria-hidden="true">{#each hues as hue}<i style={`background:var(--data-${hue})`}></i>{/each}</div><a class="preview-link" href={`/?path=/story/overview-usage-analytics--${language === 'zh-CN' ? 'chinese' : 'default'}`} target="_top">{text('View the Dashboard with this palette →', '查看这套色板在 Dashboard 中的效果 →')}</a></div>
  </section>

  <section class="foundation-panel" data-testid="categorical-palette">
    <div class="section-heading"><span>01</span><h2>{text('Categories · Tableau 10', '类别 · Tableau 10')}</h2></div>
    <p>{text('Different capabilities are different categories, not a light-to-dark ranking. Always use the mapping below in charts and legends. These colors identify categories; they do not indicate success or failure.', '不同能力是不同类别，不是由浅到深的排名。图表与图例始终使用以下固定映射。这些颜色用于识别类别，不表示成功或失败。')}</p>
    <p class="source-links">{text('Source:', '来源：')} <a href="https://www.tableau.com/blog/colors-upgrade-tableau-10-56782" target="_blank" rel="noreferrer">Tableau</a> · <a href="https://d3js.org/d3-scale-chromatic/categorical" target="_blank" rel="noreferrer">D3 schemeTableau10</a></p>
    <div class="data-swatches">{#each hues as hue, i}<div class="swatch"><div class="swatch-color" style={`background:var(--data-${hue})`}></div><strong>{text(hueNames[i]![0]!, hueNames[i]![1]!)}</strong><code>{values[`data-${hue}`]}</code><small>{text(categories[i]![0]!, categories[i]![1]!)}</small></div>{/each}</div>
  </section>

  <section class="foundation-panel">
    <div class="section-heading"><span>02</span><h2>{text('Quantity · ColorBrewer Blues', '数量 · ColorBrewer Blues')}</h2></div>
    <p>{text('Heatmaps use five fixed steps from light to dark, relative to the largest visible count. Darker means more demand, not better results. Use this sequential scale for the demand matrix. Category charts use the seven distinct hues above; keep their labels and segment separators visible.', '热力图相对于当前最大计数，使用固定的五档色阶。越深表示需求越多，不表示结果越好。需求矩阵使用这套连续色阶。类别图表使用上方七种不同色相，并保留文字图例和分段边界。')}</p>
    <p class="source-links">{text('Source:', '来源：')} <a href="https://d3js.org/d3-scale-chromatic/sequential" target="_blank" rel="noreferrer">D3 schemeBlues[5] / ColorBrewer</a></p>
    <div class="heat-scale">{#each [4, 16, 31, 56, 76] as count, i}<div><strong style={`background:var(--heat-${i + 1});color:var(--heat-ink-${i + 1})`}>{count}</strong><code>{values[`heat-${i + 1}`]}</code></div>{/each}</div>
    <small>{text('Illustrative requirement counts; not live usage. All five text/fill pairs meet 4.5:1 contrast.', '示例能力需求次数，不是实际用量。五档数字与底色的对比度均达到 4.5:1。')}</small>
  </section>

  <section class="foundation-panel">
    <div class="section-heading"><span>03</span><h2>{text('Neutral foundation', '中性基底')}</h2></div>
    <p>{text('0: surface · 50–150: backgrounds · 200: borders · 300–500: disabled and quiet surfaces · 600: secondary text · 950: primary text and actions.', '0：表面 · 50–150：背景 · 200：边框 · 300–500：禁用与弱化表面 · 600：次要文字 · 950：主要文字与操作。')}</p>
    <div class="swatch-grid">{#each stones as level}<div class="swatch"><div class="swatch-color" style={`background:var(--stone-${level})`}></div><strong>Stone {level}</strong><code>{values[`stone-${level}`]}</code></div>{/each}</div>
  </section>

  <section class="foundation-panel">
    <div class="section-heading"><span>04</span><h2>{text('Semantic colors', '状态色')}</h2></div>
    <p>{text('Reserved for status, never assigned to a provider or capability category. Successful job bars use sage, failures use clay; trend lines use Tableau blue. Keep a status label or icon alongside the color.', '只用于状态，不分配给 Provider 或能力类别。成功任务柱使用灰绿，失败使用陶土色；趋势曲线使用 Tableau 蓝。状态颜色始终配合文字或图标。')}</p>
    <div class="status-grid">{#each statuses as status}<div style={`--status:var(--status-${status.id});--status-surface:var(--status-${status.id}-surface);--status-line:var(--status-${status.id}-line)`}><strong><i></i>{text(status.en, status.zh)}</strong><code>{values[`status-${status.id}`]}</code><p>{text(status.useEn, status.useZh)}</p></div>{/each}</div>
  </section>

  <section class="foundation-panel">
    <div class="section-heading"><span>05</span><h2>{text('Token unit', 'Token 单位')}</h2></div>
    <p>{text('A circled T with one short crossbar: our product symbol for tokens. Use it beside token quantities, with the full word in accessible labels and help. It is a unit, not a currency or a capability count.', '圆框 T 加一条短横：产品内表示 tokens 的单位符号。放在 token 数值旁，辅助阅读标签和提示中保留完整单位。它不表示货币或能力需求次数。')}</p>
    <div class="icon-specimen"><div class="icon-large"><TokenIcon size={96} /></div><div class="icon-sizes">{#each [14, 16, 20, 24, 32] as size}<span><TokenIcon {size} /><code>{size}px</code></span>{/each}</div></div>
    <div class="unit-examples"><div><small>{text('Estimated output', '估算输出')}</small><strong class="token-quantity">≈12,480 <TokenUnit {language} size={24} /></strong></div><div><small>{text('Capability demand', '能力需求')}</small><strong>76 <span>{text('requirements', '次')}</span></strong></div><div><small>{text('Success rate', '成功率')}</small><strong>98<span>%</span></strong></div></div>
    <small>{text('Illustrative values. Hover or focus the unit icon to read its meaning. The same icon is used in the header, output chart, System, and chat details.', '示例数值。悬停或聚焦单位图标可阅读含义。页头、输出图表、系统页和聊天详情使用同一个图标。')}</small>
  </section>
</main>

<style>
  .foundations { max-width: 1120px; margin: auto; padding: 48px 32px; }
  .foundations > header { margin-bottom: 32px; }
  .foundations p { max-width: 760px; margin-top: 12px; color: var(--muted); font-size: 14px; line-height: 1.65; }
  .foundations .eyebrow { margin: 0 0 10px; font-size: 11px; }
  .foundation-panel { margin-top: 20px; padding: 28px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
  .brand-intro { display: grid; grid-template-columns: 240px 1fr; align-items: center; gap: 36px; }
  .brand-sample { display: flex; min-height: 220px; flex-direction: column; align-items: flex-start; justify-content: space-between; padding: 24px; border-radius: 6px; background: var(--chart-primary); color: var(--surface); }
  .brand-sample span { margin-top: 24px; font-size: 10px; letter-spacing: .14em; }
  .brand-sample strong { font-size: 24px; }
  code { display: block; margin-top: 8px; color: var(--muted); font: 11px ui-monospace, monospace; }
  .section-heading { display: flex; align-items: center; gap: 12px; }
  .section-heading > span { color: var(--muted); font: 12px ui-monospace, monospace; }
  .swatch-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(94px, 1fr)); gap: 16px; margin-top: 24px; }
  .swatch-color { height: 72px; margin-bottom: 12px; border: 1px solid var(--line-soft); border-radius: 5px; }
  .swatch strong { font-size: 12px; }
  .data-swatches { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 14px; margin-top: 24px; }
  .data-swatches small { display: block; margin-top: 10px; font-size: 11px; line-height: 1.45; }
  .palette-ribbon { display: flex; gap: 6px; margin-top: 20px; }
  .palette-ribbon i { width: 30px; height: 8px; border-radius: 2px; }
  .source-links a { color: var(--chart-primary); text-underline-offset: 3px; }
  .preview-link { display: inline-block; margin-top: 18px; color: var(--chart-primary); font-size: 12px; text-underline-offset: 3px; }
  .heat-scale { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 24px 0 16px; }
  .heat-scale strong { display: grid; height: 64px; place-items: center; border-radius: 5px; font-size: 18px; }
  .heat-scale code { text-align: center; }
  .status-grid i { width: 12px; height: 12px; border-radius: 3px; }
  .status-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 24px; }
  .status-grid > div { padding: 20px; border: 1px solid var(--status-line); border-radius: 6px; background: var(--status-surface); }
  .status-grid strong { display: flex; align-items: center; gap: 8px; color: var(--status); font-size: 14px; }
  .status-grid i { background: var(--status); }
  .status-grid p { font-size: 12px; }
  .icon-specimen { display: flex; align-items: center; gap: 36px; margin: 24px 0; }
  .icon-large { display: grid; width: 160px; height: 160px; flex: 0 0 auto; place-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--canvas); }
  .icon-sizes { display: flex; flex-wrap: wrap; align-items: baseline; gap: 24px; }
  .icon-sizes > span { text-align: center; }
  .unit-examples { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 24px 0; border-top: 1px solid var(--line-soft); }
  .unit-examples strong { display: flex; gap: 8px; align-items: center; margin-top: 12px; font-size: 28px; font-variant-numeric: tabular-nums; }
  .unit-examples strong > span { font-size: 14px; font-weight: 450; }
  .foundation-panel > small { display: block; line-height: 1.6; }
  @media (max-width: 640px) {
    .foundations { padding: 24px 16px; }
    .foundation-panel { padding: 20px; }
    .data-swatches { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .brand-intro, .status-grid, .unit-examples { grid-template-columns: 1fr; }
    .brand-sample { min-height: 180px; }
    .icon-specimen { flex-direction: column; align-items: flex-start; gap: 20px; }
    .icon-sizes { gap: 20px; }
  }
</style>
