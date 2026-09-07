import { atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'Profiles', args: { ...defaultArgs, screen: 'profiles' } }

export const Default: AtlasStory = {}
export const Research: AtlasStory = { args: { selectedProfile: 'research' } }
export const Mobile: AtlasStory = { globals: { viewport: 'mobile' } }
export const Chinese: AtlasStory = { args: { language: 'zh-CN' } }
