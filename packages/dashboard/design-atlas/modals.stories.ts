import { clickPreview, atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Modals / Product interactions', args: { ...defaultArgs, screen: 'profiles' } }
export const CreateProfile: AtlasStory = { play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="add-profile"]') }
export const ProfilePicker: AtlasStory = { play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="header-profile"]') }
export const CapabilityDetail: AtlasStory = { args: { screen: 'capabilities' }, play: async ({ canvasElement }) => clickPreview(canvasElement, '.capability-row') }
export const Mobile: AtlasStory = { ...CreateProfile, globals: { viewport: 'mobile' } }
