import type { Meta, StoryObj } from '@storybook/svelte-vite'
import StatusBadge from './components/StatusBadge.svelte'

const meta = {
  title: 'Components/Status badge',
  component: StatusBadge,
  parameters: { layout: 'centered' },
  args: { label: 'Connected', tone: 'success', dot: true },
  argTypes: { tone: { control: 'select', options: ['neutral', 'success', 'warning', 'danger'] } },
} satisfies Meta<typeof StatusBadge>

export default meta
type Story = StoryObj<typeof meta>
export const Connected: Story = {}
export const NeedsSetup: Story = { args: { label: 'Needs setup', tone: 'warning' } }
export const Disabled: Story = { args: { label: 'Disabled', tone: 'neutral', dot: false } }
