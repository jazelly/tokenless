import { atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Capabilities', args: { ...defaultArgs, screen: 'capabilities' } }

export const Default: AtlasStory = {}
export const Mobile: AtlasStory = { globals: { viewport: 'mobile' } }
export const Chinese: AtlasStory = { args: { language: 'zh-CN' } }
