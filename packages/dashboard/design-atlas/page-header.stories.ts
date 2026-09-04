import type { Meta, StoryObj } from '@storybook/svelte-vite'
import PageHeader from '../src/components/PageHeader.svelte'
const meta = { title: 'Components/Page header', component: PageHeader, parameters: { layout: 'padded' }, args: { title: 'Providers', description: 'Manage provider access for this profile.' } } satisfies Meta<typeof PageHeader>
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Chinese: Story = { args: { title: '服务商', description: '管理此配置档的服务商访问。' } }
