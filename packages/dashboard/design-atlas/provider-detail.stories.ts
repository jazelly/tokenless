import { clickPreview, atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Providers / Detail + routing', args: { ...defaultArgs, screen: 'providers' } }
export const Default: AtlasStory = { play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="provider-details-chatgpt"]') }
export const AlternateProvider: AtlasStory = { args: { selectedProfile: 'research' }, play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="provider-details-claude"]') }
export const Mobile: AtlasStory = { ...Default, globals: { viewport: 'mobile' } }
