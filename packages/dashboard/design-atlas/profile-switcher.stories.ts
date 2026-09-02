import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ProfileSwitcherDemo from './components/ProfileSwitcherDemo.svelte'

const meta = {
  title: 'Components/Profile switcher',
  component: ProfileSwitcherDemo,
  parameters: { layout: 'centered' },
  args: { initialValue: 'design', compact: false, startOpen: false },
  argTypes: {
    initialValue: { control: 'select', options: ['design', 'studio', 'research', 'personal'] },
    compact: { control: 'boolean' },
    startOpen: { control: 'boolean' },
  },
} satisfies Meta<typeof ProfileSwitcherDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Desktop: Story = {}
export const Open: Story = { args: { startOpen: true } }
export const Mobile: Story = { args: { compact: true }, globals: { viewport: 'mobile' } }
