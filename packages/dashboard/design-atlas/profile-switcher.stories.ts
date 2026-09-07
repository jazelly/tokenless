import type { Meta, StoryObj } from '@storybook/svelte-vite'
import ProfileSwitcherDemo from './components/ProfileSwitcherDemo.svelte'
import { canonicalViewports, clickPreview } from './storybook-meta.js'

const meta = {
  title: 'Components/Profile switcher', component: ProfileSwitcherDemo,
  parameters: { layout: 'centered', viewport: { options: canonicalViewports } },
  args: { initialValue: 'design', language: 'en' },
  argTypes: {
    language: { control: 'select', options: ['en', 'zh-CN'] },
    initialValue: { control: 'select', options: ['design', 'studio', 'research', 'personal'] },
  },
} satisfies Meta<typeof ProfileSwitcherDemo>
export default meta
type Story = StoryObj<typeof meta>
export const Desktop: Story = {}
export const Open: Story = { play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="header-profile"]') }
export const Mobile: Story = { globals: { viewport: 'mobile' } }
export const Chinese: Story = { ...Open, args: { language: 'zh-CN' } }
