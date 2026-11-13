export type Reading = { at: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-watch': {
      reading: Reading | null
      isCold: boolean
      dismissed: string
      isEditing: boolean
      isDemo: boolean
      isSetupOpen: boolean
    }
  }
}
