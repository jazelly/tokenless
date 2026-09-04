import type { Language, Section } from '../src/types.js'

export type DesignScreen = Exclude<Section, 'routing'> | 'setup' | 'loading' | 'offline' | 'fatal'
export type DesignState = 'ready' | 'busy' | 'error'
export type DesignAtlasArgs = {
  screen: DesignScreen
  language: Language
  backgroundColor: string
  surfaceColor: string
  textColor: string
  radius: number
  designState: DesignState
  selectedProfile: string
}
