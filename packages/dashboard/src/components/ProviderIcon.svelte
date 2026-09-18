<script lang="ts">
  const assets = import.meta.glob<string>('../../../../assets/providers/*.{svg,png,ico}', { eager: true, query: '?url', import: 'default' })
  const icons = Object.fromEntries(Object.entries(assets).map(([path, url]) => [path.split('/').at(-1)!.split('.')[0], url]))
  let { provider, size = 18 }: { provider: string; size?: number } = $props()
</script>

<img src={icons[provider]} width={size} height={size} alt="" aria-hidden="true" class="provider-icon" />

<style>
  .provider-icon { display: block; object-fit: contain; flex: none; }
</style>
