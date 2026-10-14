export type CacheTtl = '5m' | '1h'

export type CacheSettings = {
  ttl: CacheTtl
  isAutoCompact: boolean
  /** Seconds before expiry that auto-compact fires. */
  leadSeconds: number
  isBandShown: boolean
  /** Where the TTL came from: the default, a response that proved it, a model switch, or the person. */
  ttlSource: 'default' | 'observed' | 'switch' | 'manual'
}

export type CacheHit = {
  /** When the main thread last read or wrote the cache, ms since the epoch. */
  at: number
  read: number
  write: number
  uncached: number
}

export type CacheStats = {
  requests: number
  hits: number
  expiries: number
  compactions: number
  /** Share of each request's input the cache served, oldest first, 0..1. */
  history: number[]
}

/** Which reminder has fired for the current hit. */
export type CacheAlert = 'none' | 'warned' | 'compacted' | 'expired'

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': {
      settings: CacheSettings
      last: CacheHit | null
      stats: CacheStats
      alert: CacheAlert
      now: number
    }
  }
}
