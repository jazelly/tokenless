import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ProviderModesDemo from './components/ProviderModesDemo.svelte'
const meta = { title: 'Components/Provider modes', component: ProviderModesDemo, parameters: { layout: 'centered' }, args: { language: 'en', enabled: true } } satisfies Meta<typeof ProviderModesDemo>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Disabled: Story = { args: { enabled: false } }
export const Chinese: Story = { args: { language: 'zh-CN' } }
