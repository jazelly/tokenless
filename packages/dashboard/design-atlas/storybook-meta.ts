import type { Meta, StoryObj } from '@storybook/svelte-vite'
import { tick } from 'svelte'
import DesignAtlas from './DesignAtlas.svelte'
import type { DesignAtlasArgs } from './atlas-types.js'

export const canonicalViewports = {
  desktop: { name: 'Desktop · 1440 × 900', styles: { width: '1440px', height: '900px' }, type: 'desktop' },
  mobile: { name: 'Mobile · 390 × 844', styles: { width: '390px', height: '844px' }, type: 'mobile' },
}
export const defaultArgs: DesignAtlasArgs = {
  screen: 'overview', language: 'en', backgroundColor: '#f6f5f2', surfaceColor: '#ffffff',
  textColor: '#171715', radius: 10, designState: 'ready', selectedProfile: 'design',
}
export const commonArgTypes: Meta<typeof DesignAtlas>['argTypes'] = {
  screen: { name: 'Screen / 页面', control: 'select', options: ['setup', 'overview', 'profiles', 'providers', 'capabilities', 'jobs', 'system', 'loading', 'offline', 'fatal'] },
  language: { name: 'Language / 语言', control: 'select', options: ['en', 'zh-CN'] },
  backgroundColor: { name: 'Canvas / 背景', control: 'color' },
  surfaceColor: { name: 'Surface / 表面', control: 'color' },
  textColor: { name: 'Ink / 文字与主操作', control: 'color' },
  radius: { name: 'Radius / 圆角', control: { type: 'range', min: 0, max: 24, step: 1 } },
  designState: { name: 'UI state / 界面状态', control: 'select', options: ['ready', 'busy', 'error'] },
  selectedProfile: { name: 'Profile / 配置档', control: 'select', options: ['design', 'studio', 'research', 'personal'] },
}
export const atlasMeta = {
  component: DesignAtlas, argTypes: commonArgTypes,
  parameters: {
    layout: 'fullscreen', controls: { expanded: true }, viewport: { options: canonicalViewports },
    docs: { description: { component: 'Production Dashboard components with illustrative local data. No daemon or provider calls. / 正式 Dashboard 组件与本地示例数据，不调用 daemon 或服务商。' } },
  }, globals: { viewport: 'desktop' },
} satisfies Meta<typeof DesignAtlas>
export async function clickPreview(canvas: HTMLElement, selector: string) {
  const control = canvas.querySelector<HTMLElement>(selector)
  if (!control) throw new Error(`Preview control not found: ${selector}`)
  control.click()
  await tick()
}
export type AtlasStory = StoryObj<typeof DesignAtlas>
