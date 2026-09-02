import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ProviderCardDemo from './components/ProviderCardDemo.svelte'

const meta = {
  title: 'Components/Provider card',
  component: ProviderCardDemo,
  parameters: { layout: 'centered' },
  args: { name: 'ChatGPT', slug: 'chatgpt', short: 'C', tint: '#7bd5b1', mode: 'Browser', status: 'Supported', initialEnabled: true },
} satisfies Meta<typeof ProviderCardDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Disabled: Story = { args: { name: 'Gemini', slug: 'gemini', short: 'G', tint: '#a7b3ec', status: 'Needs setup', initialEnabled: false } }
