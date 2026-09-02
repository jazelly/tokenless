import type { Meta, StoryObj } from '@storybook/svelte-vite'
import NavigationItem from './components/NavigationItem.svelte'

const meta = {
  title: 'Components/Navigation item',
  component: NavigationItem,
  parameters: { layout: 'centered' },
  args: { label: 'Overview', icon: 'overview', active: true, compact: false },
  argTypes: { icon: { control: 'select', options: ['overview', 'profiles', 'providers', 'capabilities', 'history', 'system'] } },
} satisfies Meta<typeof NavigationItem>

export default meta
type Story = StoryObj<typeof meta>
export const Active: Story = {}
export const Resting: Story = { args: { active: false } }
export const Mobile: Story = { args: { compact: true }, globals: { viewport: 'mobile' } }
