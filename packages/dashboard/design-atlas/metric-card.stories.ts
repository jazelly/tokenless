import type { Meta, StoryObj } from '@storybook/svelte-vite'
import MetricCardDemo from './components/MetricCardDemo.svelte'

const meta = {
  title: 'Components/Metric card',
  component: MetricCardDemo,
  parameters: { layout: 'centered' },
  args: { label: 'Completed jobs', value: '24', detail: 'Selected range · Aug 4–Sep 2', icon: 'activity' },
  argTypes: { icon: { control: 'select', options: ['provider', 'activity', 'success', 'capability'] } },
} satisfies Meta<typeof MetricCardDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
export const Success: Story = { args: { label: 'Success rate', value: '92%', detail: '22 succeeded · 2 failed', icon: 'success' } }
