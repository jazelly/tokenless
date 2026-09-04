import { atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Chat History', args: { ...defaultArgs, screen: 'jobs' } }

export const Default: AtlasStory = {}
export const Mobile: AtlasStory = { globals: { viewport: 'mobile' } }
export const Chinese: AtlasStory = { args: { language: 'zh-CN' } }
