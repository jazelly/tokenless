import { clickPreview, atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Jobs / Detail', args: { ...defaultArgs, screen: 'jobs' } }
export const Default: AtlasStory = { play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="job-job-1"]') }
export const Canceled: AtlasStory = { play: async ({ canvasElement }) => clickPreview(canvasElement, '[data-testid="job-job-1-canceled"]') }
export const Mobile: AtlasStory = { ...Default, globals: { viewport: 'mobile' } }
