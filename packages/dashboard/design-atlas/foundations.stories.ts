import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ColorAndUnits from './components/ColorAndUnits.svelte'
import { canonicalViewports } from './storybook-meta.js'

export default {
  title: 'Foundations / Color & units',
  component: ColorAndUnits,
  args: { language: 'en' },
  argTypes: { language: { control: 'select', options: ['en', 'zh-CN'] } },
  parameters: { layout: 'fullscreen', viewport: { options: canonicalViewports } },
} satisfies Meta<typeof ColorAndUnits>

type Story = StoryObj<typeof ColorAndUnits>
export const Palette: Story = {}
export const Chinese: Story = { args: { language: 'zh-CN' } }
export const Mobile: Story = { globals: { viewport: 'mobile' } }
