import { atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Setup', args: { ...defaultArgs, screen: 'setup' } }

export const Default: AtlasStory = {}
export const Chinese: AtlasStory = { args: { language: 'zh-CN' } }
