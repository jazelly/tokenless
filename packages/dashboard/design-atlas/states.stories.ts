import { atlasMeta, defaultArgs, type AtlasStory } from './storybook-meta.js'

export default { ...atlasMeta, title: 'States / Loading, offline, fatal', args: { ...defaultArgs, screen: 'loading' } }

export const Loading: AtlasStory = {}
export const Offline: AtlasStory = { args: { screen: 'offline' } }
export const Fatal: AtlasStory = { args: { screen: 'fatal' } }
export const MobileOffline: AtlasStory = { args: { screen: 'offline' }, globals: { viewport: 'mobile' } }
