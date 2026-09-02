import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ActionButton from './components/ActionButton.svelte'

const meta = {
  title: 'Components/Action button',
  component: ActionButton,
  parameters: { layout: 'centered' },
  args: { label: 'Save changes', variant: 'primary', disabled: false },
  argTypes: { variant: { control: 'select', options: ['primary', 'secondary', 'danger', 'ghost'] } },
} satisfies Meta<typeof ActionButton>

export default meta
type Story = StoryObj<typeof meta>
export const Primary: Story = {}
export const Secondary: Story = { args: { variant: 'secondary', label: 'Cancel' } }
export const Danger: Story = { args: { variant: 'danger', label: 'Delete profile' } }
export const Disabled: Story = { args: { disabled: true } }
