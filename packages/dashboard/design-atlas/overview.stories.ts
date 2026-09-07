import { atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Overview / Usage analytics', args: { ...defaultArgs, screen: 'overview' } }

export const Default: AtlasStory = {}
export const Mobile: AtlasStory = { globals: { viewport: 'mobile' } }
export const Chinese: AtlasStory = { args: { language: 'zh-CN' } }
export const Loading: AtlasStory = { args: { designState: 'busy' } }
export const Error: AtlasStory = { args: { designState: 'error' } }
