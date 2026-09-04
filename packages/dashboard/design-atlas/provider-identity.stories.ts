import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ProviderIdentity from '../src/components/ProviderIdentity.svelte'
const meta = { title: 'Components/Provider identity', component: ProviderIdentity, parameters: { layout: 'centered' }, args: { provider: 'chatgpt', label: 'ChatGPT', compact: false } } satisfies Meta<typeof ProviderIdentity>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Claude: Story = { args: { provider: 'claude', label: 'Claude' } }
export const Compact: Story = { args: { compact: true } }
