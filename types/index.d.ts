export type CacheTtl = '5m' | '1h'

export type CacheLang = 'en' | 'zh-TW'

/** What the status line shows: nothing, the time left, or a bar and the time left. */
export type CacheStatusMode = 'off' | 'time' | 'bar'

export type CacheSettings = {
  ttl: CacheTtl
  isAutoCompact: boolean
  /** Seconds before expiry that auto-compact fires. */
  leadSeconds: number
  /** Least context, in tokens, that auto-compact acts on. */
  compactMinTokens: number
  isBandShown: boolean
  /** What the status line shows. */
  status: CacheStatusMode
  /** Show `mm:ss` the whole time, not whole minutes until 5 minutes are left. */
  isSecondsShown: boolean
  /** Where the TTL came from: the default, a response that proved it, a model switch, or the person, who fixes it. */
  ttlSource: 'default' | 'observed' | 'switch' | 'fixed'
  /** UI language. */
  lang: CacheLang
  /** The pane's settings are unfolded. */
  isSettingsOpen: boolean
}

export type CacheHit = {
  /** When the main thread last read or wrote the cache, ms since the epoch. */
  at: number
  read: number
  write: number
  uncached: number
  /**
   * Rebuilt from a resumed transcript after a restart: only the context size is
   * known, and `read` carries all of it.
   */
  isEstimated?: true
}

/** One session's timer as the store keeps it, so it outlives a restart of the app. */
export type SavedSession = {
  last: CacheHit | null
  /** When it was saved, ms since the epoch; the oldest sessions are dropped first. */
  savedAt: number
}

/** Which reminder has fired for the current hit. */
export type CacheAlert = 'none' | 'warned' | 'compacted' | 'expired'

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': {
      settings: CacheSettings
      last: CacheHit | null
      alert: CacheAlert
      now: number
      /** When the running compaction started, ms since the epoch; 0 while none runs. */
      compactingSince: number
      /** The pane is open and placed; the band's Pane button is lit and closes it. */
      isPaneOpen: boolean
    }
  }
}
