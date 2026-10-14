import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheAlert, CacheHit, CacheLang, CacheSettings, CacheStats, CacheTtl } from '../types'

const PANE = 'cache-timer'
const STORE_KEY = 'settings'
/** The userConfig language last seen, so a change there wins over the stored one. */
const CONFIG_LANG_KEY = 'configLang'
/** Below this context size a compaction saves too little to be worth losing detail. */
const MIN_COMPACT_TOKENS = 20_000
const HISTORY = 30

const DEFAULTS: CacheSettings = {
  ttl: '1h',
  isAutoCompact: false,
  leadSeconds: 120,
  isBandShown: true,
  ttlSource: 'default',
  lang: 'en',
}

const settings = atom({ plugin: 'cache-timer', key: 'settings' } as const, DEFAULTS)
const last = atom({ plugin: 'cache-timer', key: 'last' } as const, null)
const stats = atom({ plugin: 'cache-timer', key: 'stats' } as const, {
  requests: 0,
  hits: 0,
  expiries: 0,
  compactions: 0,
  history: [],
})
const alert = atom({ plugin: 'cache-timer', key: 'alert' } as const, 'none')
const now = atom({ plugin: 'cache-timer', key: 'now' } as const, 0)

export const ttlMs = (ttl: CacheTtl) => (ttl === '1h' ? 3_600_000 : 300_000)

/** The reminder fires 5 minutes before a 1h cache lapses, 1 minute before a 5m one. */
export const warnMs = (ttl: CacheTtl) => (ttl === '1h' ? 300_000 : 60_000)

/**
 * Auto-compact lead. On a 5m cache it is held to 1 minute, so a pause of
 * under 4 minutes never compacts.
 */
export const leadMs = (s: CacheSettings) =>
  Math.min(Math.max(s.leadSeconds, 15) * 1000, s.ttl === '5m' ? 60_000 : ttlMs(s.ttl) / 2)

/** Slack for clock skew between our timestamps and the API's own. */
const SLACK_MS = 30_000

/**
 * The TTL a response proves: a read after more than 5 minutes means 1h; a
 * write with no read after 5 to 55 minutes means the 5m entry lapsed.
 */
export const observedTtl = (gapMs: number, read: number, write: number): CacheTtl | undefined => {
  if (read > 0 && gapMs > ttlMs('5m') + SLACK_MS) return '1h'
  if (read === 0 && write > 0 && gapMs > ttlMs('5m') + SLACK_MS && gapMs < ttlMs('1h') - 5 * 60_000) return '5m'

  return undefined
}

export const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const sec = total % 60

  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const bar = (fraction: number, width: number) => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const SPARKS = '▁▂▃▄▅▆▇█'
export const spark = (history: readonly number[]) =>
  history.map(r => SPARKS[Math.min(SPARKS.length - 1, Math.floor(r * SPARKS.length))]).join('')

export const contextOf = (hit: CacheHit) => hit.read + hit.write + hit.uncached

const tone = (fraction: number) => (fraction > 0.5 ? 'success' : fraction > 0.15 ? 'warning' : 'error')

export const LANGS = ['en', 'zh-TW'] as const

/** Canonical language for a typed or configured value, case-insensitive. */
export const langOf = (value: unknown): CacheLang | undefined =>
  typeof value === 'string' ? LANGS.find(l => l.toLowerCase() === value.toLowerCase()) : undefined

/** Every UI string, keyed by language. */
export const STRINGS = {
  en: {
    paneTitle: 'Prompt cache',
    on: 'on',
    off: 'off',
    shown: 'shown',
    hidden: 'hidden',
    lessThanMinuteAgo: 'under a minute ago',
    minutesAgo: (m: number) => `${m} min ago`,
    source: { default: 'default', observed: 'detected', switch: 'from model switch', manual: 'set by you' },
    noTimer: 'No cache is being timed',
    remainingHead: (c: string) => `Cache has ${c} left`,
    expired: 'Cache expired',
    summaryHead: (head: string, ttl: string, source: string) => `${head} (TTL ${ttl}, ${source})`,
    summaryStats: (rate: string, hits: number, requests: number, expiries: number, compactions: number) =>
      `Hit rate ${rate} (${hits}/${requests}) · ${expiries} expired · ${compactions} compacted`,
    summaryAuto: (onOff: string, sec: number) => `Auto-compact before expiry: ${onOff}, ${sec}s ahead`,
    compactSkipped: (why: string) => `Compaction skipped: ${why}`,
    autoCompacted: 'Cache was about to expire, so the conversation was compacted',
    busy: 'Claude is replying; compact once this turn ends',
    expiredToast: (tok: string) => `Cache expired; the next message re-writes about ${tok} tokens`,
    warnToast: (c: string) => `Cache has ${c} left; continuing now is cheapest`,
    paneOpened: 'Opened the cache pane.',
    autoReply: (onOff: string) => `Auto-compact before expiry: ${onOff}`,
    ttlReply: (ttl: string) => `Cache TTL set to ${ttl}`,
    bandReply: (shown: string) => `Band above the prompt: ${shown}`,
    langReply: 'Language set to English',
    compactReply: 'Asked to compact the conversation.',
    usage: 'Usage: /cache [auto on|off] [ttl 5m|1h] [band on|off] [lang en|zh-TW] [compact]',
    autoLabel: (onOff: string) => `auto-compact ${onOff}`,
    compactNow: 'Compact',
    pane: 'Pane',
    hide: 'Hide',
    bandLast: (ago: string, r: string, w: string) => `Last read/write ${ago} · read ${r} · wrote ${w}`,
    bandRewrite: (tok: string) => ` · next message re-writes about ${tok} tokens`,
    compactedHint: 'Compacted; the next message writes a fresh cache',
    noCacheHint: 'No cache yet; the timer starts after your first message',
    remaining: (c: string, total: string) => `${c} / ${total} left`,
    lastLine: (ago: string) => `Last read/write: ${ago}`,
    tokensLine: (r: string, w: string, u: string) => `This request read ${r} · wrote ${w} · uncached ${u}`,
    rewriteLine: (tok: string) => `After expiry, about ${tok} tokens are re-written`,
    thisSession: 'This session',
    statsLine: (rate: string, hits: number, requests: number, expiries: number, compactions: number) =>
      `Hit rate ${rate} (${hits}/${requests} requests) · ${expiries} expired · ${compactions} compacted`,
    historyLine: (sp: string) => `Cached share per request: ${sp}`,
    settings: 'Settings',
    ttlLabel: (source: string) => `TTL (${source})`,
    autoCompact: 'Auto-compact before expiry',
    lead: 'Lead',
    minutes: (m: number) => `${m} min`,
    leadNote: (sec: number, min: string) =>
      `Compacts with ${sec}s left (at most 1 minute ahead on a 5m TTL); never auto-compacts under ${min} tokens of context.`,
    band: 'Band above the prompt',
    language: 'Language',
    compactConversation: 'Compact conversation now',
  },
  'zh-TW': {
    paneTitle: 'Prompt 快取',
    on: '開',
    off: '關',
    shown: '顯示',
    hidden: '隱藏',
    lessThanMinuteAgo: '不到 1 分鐘前',
    minutesAgo: (m: number) => `${m} 分鐘前`,
    source: { default: '預設', observed: '自動偵測', switch: '切換模型時回報', manual: '手動設定' },
    noTimer: '目前沒有在計時的快取',
    remainingHead: (c: string) => `快取剩 ${c}`,
    expired: '快取已過期',
    summaryHead: (head: string, ttl: string, source: string) => `${head}（TTL ${ttl}，${source}）`,
    summaryStats: (rate: string, hits: number, requests: number, expiries: number, compactions: number) =>
      `命中率 ${rate}（${hits}/${requests}）· 過期 ${expiries} 次 · 壓縮 ${compactions} 次`,
    summaryAuto: (onOff: string, sec: number) => `到期前自動壓縮：${onOff}，提前 ${sec} 秒`,
    compactSkipped: (why: string) => `壓縮被略過：${why}`,
    autoCompacted: '快取快過期了，已自動壓縮對話',
    busy: 'Claude 正在回覆，等這一輪結束再壓縮',
    expiredToast: (tok: string) => `快取已過期，下一則訊息會重新寫入約 ${tok} tokens`,
    warnToast: (c: string) => `快取剩 ${c}，這時回來繼續最省`,
    paneOpened: '已開啟快取面板。',
    autoReply: (onOff: string) => `到期前自動壓縮：${onOff}`,
    ttlReply: (ttl: string) => `快取 TTL 設為 ${ttl}`,
    bandReply: (shown: string) => `提示框上方進度條：${shown}`,
    langReply: '介面語言已設為繁體中文',
    compactReply: '已要求壓縮對話。',
    usage: '用法：/cache [auto on|off] [ttl 5m|1h] [band on|off] [lang en|zh-TW] [compact]',
    autoLabel: (onOff: string) => `自動壓縮 ${onOff}`,
    compactNow: '立即壓縮',
    pane: '面板',
    hide: '隱藏',
    bandLast: (ago: string, r: string, w: string) => `上次讀寫 ${ago} · 讀取 ${r} · 寫入 ${w}`,
    bandRewrite: (tok: string) => ` · 下一則訊息會重新寫入約 ${tok} tokens`,
    compactedHint: '已壓縮，下一則訊息會寫入新的快取',
    noCacheHint: '還沒有快取，送出第一則訊息後開始計時',
    remaining: (c: string, total: string) => `剩餘 ${c} / ${total}`,
    lastLine: (ago: string) => `上次讀寫：${ago}`,
    tokensLine: (r: string, w: string, u: string) => `這次讀取 ${r} · 寫入 ${w} · 未快取 ${u}`,
    rewriteLine: (tok: string) => `過期後重新寫入約 ${tok} tokens`,
    thisSession: '本 session',
    statsLine: (rate: string, hits: number, requests: number, expiries: number, compactions: number) =>
      `命中率 ${rate}（${hits}/${requests} 次請求）· 過期 ${expiries} 次 · 壓縮 ${compactions} 次`,
    historyLine: (sp: string) => `每次請求的快取比例：${sp}`,
    settings: '設定',
    ttlLabel: (source: string) => `TTL（${source}）`,
    autoCompact: '到期前自動壓縮',
    lead: '提前',
    minutes: (m: number) => `${m} 分`,
    leadNote: (sec: number, min: string) =>
      `實際在剩 ${sec} 秒時壓縮（5m TTL 最多提前 1 分鐘）；上下文不到 ${min} tokens 時不自動壓縮。`,
    band: '提示框上方進度條',
    language: '語言',
    compactConversation: '立即壓縮對話',
  },
} as const

type Strings = (typeof STRINGS)[CacheLang]

const LANG_LABEL: Record<CacheLang, string> = { en: 'English', 'zh-TW': '繁體中文' }

const strings = async ($: EngineInterface): Promise<Strings> => STRINGS[(await read($, settings)).lang] ?? STRINGS.en

const ago = (L: Strings, ms: number) => {
  const minutes = Math.floor(ms / 60_000)

  return minutes < 1 ? L.lessThanMinuteAgo : L.minutesAgo(minutes)
}

let ticker: { cancel: () => void } | undefined
let isCompacting = false
let compactTriedFor = 0

/** A native notification where the surface has one; the toast is the reminder everywhere. */
async function notify($: EngineInterface, text: string) {
  try {
    await $.ui.notify(text, { title: 'Cache timer' })
  } catch {
    // No notification channel on this surface.
  }
}

/** The pane's figures as text, for a surface that places no pane. */
async function summary($: EngineInterface) {
  const s = await read($, settings)
  const hit = await read($, last)
  const st = await read($, stats)
  const L: Strings = STRINGS[s.lang]
  const t = await $.clock.now()
  const remaining = hit === null ? 0 : hit.at + ttlMs(s.ttl) - t
  const head = hit === null ? L.noTimer : remaining > 0 ? L.remainingHead(clock(remaining)) : L.expired
  const rate = st.requests === 0 ? '—' : `${Math.round((st.hits / st.requests) * 100)}%`

  return [
    L.summaryHead(head, s.ttl, L.source[s.ttlSource]),
    L.summaryStats(rate, st.hits, st.requests, st.expiries, st.compactions),
    L.summaryAuto(s.isAutoCompact ? L.on : L.off, Math.round(leadMs(s) / 1000)),
  ].join('\n')
}

async function openPane($: EngineInterface) {
  const { isPlaced } = await $.ui.open({ id: PANE, title: (await strings($)).paneTitle })
  if (!isPlaced) $.ui.toast(await summary($), { timeoutMs: 8000 })
}

async function saveSettings($: EngineInterface, fn: (s: CacheSettings) => CacheSettings) {
  await update($, settings, s => fn(s ?? DEFAULTS))
  await $.store.set(STORE_KEY, await read($, settings))
}

async function markCompacted($: EngineInterface) {
  await update($, last, () => null)
  await update($, alert, (): CacheAlert => 'compacted')
  await update($, stats, st => ({ ...st, compactions: st.compactions + 1 }))
}

async function compactNow($: EngineInterface, why: 'auto' | 'manual') {
  if (isCompacting) return
  isCompacting = true

  try {
    const L = await strings($)
    const result = await $.session.compact()

    if (result.skip !== undefined) {
      $.ui.toast(L.compactSkipped(result.skip))

      return
    }

    // Our own call skips our session.compact hook, so the reset happens here.
    if ((await read($, last)) !== null) await markCompacted($)

    if (why === 'auto') {
      $.ui.toast(L.autoCompacted)
      void notify($, L.autoCompacted)
    }
  } catch {
    // Rejects while a turn runs: that turn's own requests keep the cache warm.
    if (why === 'manual') $.ui.toast((await strings($)).busy)
  } finally {
    isCompacting = false
  }
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)

  const hit = await read($, last)
  if (hit === null) return

  const s = await read($, settings)
  const remaining = hit.at + ttlMs(s.ttl) - t
  const state = await read($, alert)

  if (remaining <= 0) {
    if (state === 'expired') return
    await update($, alert, () => 'expired')
    const message = STRINGS[s.lang].expiredToast(tokens(contextOf(hit)))
    $.ui.toast(message, { timeoutMs: 8000 })
    void notify($, message)

    return
  }

  const isWorthCompacting = contextOf(hit) >= MIN_COMPACT_TOKENS
  if (s.isAutoCompact && isWorthCompacting && remaining <= leadMs(s) && compactTriedFor !== hit.at) {
    compactTriedFor = hit.at
    await compactNow($, 'auto')

    return
  }

  if (state === 'none' && remaining <= warnMs(s.ttl)) {
    await update($, alert, () => 'warned')
    const message = STRINGS[s.lang].warnToast(clock(remaining))
    $.ui.toast(message, { timeoutMs: 8000 })
    void notify($, message)
  }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(STORE_KEY)) as Partial<CacheSettings> | undefined
    if (saved) await update($, settings, () => ({ ...DEFAULTS, ...saved, lang: langOf(saved.lang) ?? DEFAULTS.lang }))

    // The userConfig language applies on first run and whenever it changed since last seen;
    // otherwise the language picked in the pane or with /cache lang stands.
    const configLang = langOf(options.lang) ?? DEFAULTS.lang
    if (saved?.lang === undefined || (await $.store.get(CONFIG_LANG_KEY)) !== configLang) {
      await saveSettings($, s => ({ ...s, lang: configLang }))
      await $.store.set(CONFIG_LANG_KEY, configLang)
    }

    await $.command.register({
      name: 'cache',
      description: 'Prompt cache timer: open the pane, or auto on|off, ttl 5m|1h, band on|off, lang en|zh-TW, compact',
      argumentHint: '[auto on|off] [ttl 5m|1h] [band on|off] [lang en|zh-TW] [compact]',
    })

    ticker?.cancel()
    ticker = $.clock.every(1000, () => void tick($))

    return next(e)
  })

  // Every model request of the main thread: its usage says the cache was read or written now.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const usage: ModelUsage | null = response.usage

    if (e.agentId === undefined && usage !== null) {
      const read_ = usage.cache_read_input_tokens
      const write = usage.cache_creation_input_tokens
      const t = await $.clock.now()
      const prev = await read($, last)
      const s = await read($, settings)
      const wasExpired = prev !== null && prev.at + ttlMs(s.ttl) <= t && read_ === 0 && write > 0
      const seen = prev === null ? undefined : observedTtl(t - prev.at, read_, write)
      if (seen !== undefined && (seen !== s.ttl || s.ttlSource !== 'observed')) {
        await saveSettings($, x => ({ ...x, ttl: seen, ttlSource: 'observed' }))
      }

      await update($, stats, (st): CacheStats => {
        const input = read_ + write + usage.input_tokens
        const ratio = input === 0 ? 0 : read_ / input

        return {
          ...st,
          requests: st.requests + 1,
          hits: st.hits + (read_ > 0 ? 1 : 0),
          expiries: st.expiries + (wasExpired ? 1 : 0),
          history: [...st.history, ratio].slice(-HISTORY),
        }
      })

      if (read_ > 0 || write > 0) {
        const hit: CacheHit = { at: t, read: read_, write, uncached: usage.input_tokens }
        await update($, last, () => hit)
        await update($, alert, (): CacheAlert => 'none')
        await update($, now, () => t)
      }
    }

    return response
  })

  // Any compaction of the main thread (/compact, auto, ours) replaces the cached prefix.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await markCompacted($)
    }

    return result
  })

  // A model switch reports the TTL the session's cache uses.
  on('classic.PostModelSwitch', async ($, e, next) => {
    const ttl = e.cache_ttl
    if (ttl === '5m' || ttl === '1h') await saveSettings($, s => ({ ...s, ttl, ttlSource: 'switch' }))

    return next(e)
  })

  on('command.run', { command: 'cache' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [verb, value] = words
    const L = await strings($)

    if (verb === undefined) {
      const { isPlaced } = await $.ui.open({ id: PANE, title: L.paneTitle })

      return { text: isPlaced ? L.paneOpened : await summary($) }
    }

    if (verb === 'auto' && (value === 'on' || value === 'off')) {
      await saveSettings($, s => ({ ...s, isAutoCompact: value === 'on' }))

      return { text: L.autoReply(value === 'on' ? L.on : L.off) }
    }

    if (verb === 'ttl' && (value === '5m' || value === '1h')) {
      await saveSettings($, s => ({ ...s, ttl: value, ttlSource: 'manual' }))

      return { text: L.ttlReply(value) }
    }

    if (verb === 'band' && (value === 'on' || value === 'off')) {
      await saveSettings($, s => ({ ...s, isBandShown: value === 'on' }))

      return { text: L.bandReply(value === 'on' ? L.shown : L.hidden) }
    }

    const lang = langOf(value)
    if (verb === 'lang' && lang !== undefined) {
      await saveSettings($, s => ({ ...s, lang }))

      return { text: STRINGS[lang].langReply }
    }

    if (verb === 'compact') {
      await compactNow($, 'manual')

      return { text: L.compactReply }
    }

    return { text: L.usage }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settings)
    const hit = await read($, last)

    if (e.props.hasSurvey || !s.isBandShown || hit === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const L: Strings = STRINGS[s.lang]
    const t = await read($, now)
    const total = ttlMs(s.ttl)
    const remaining = hit.at + total - t
    const fraction = remaining / total
    const width = Math.max(8, Math.min(30, e.props.bodyColumns - 60))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {remaining > 0 ? (
            <Text color={tone(fraction)}>
              cache {bar(fraction, width)} {clock(remaining)} / {clock(total)}
            </Text>
          ) : (
            <Text color="error">{L.expired}</Text>
          )}
          <Text dimColor>{L.autoLabel(s.isAutoCompact ? L.on : L.off)}</Text>
          <Button key="compact" label={L.compactNow} onPress={() => compactNow($, 'manual')} />
          <Button key="pane" label={L.pane} onPress={() => openPane($)} />
          <Button key="hide" label={L.hide} dimColor onPress={() => saveSettings($, x => ({ ...x, isBandShown: false }))} />
        </Box>
        <Text dimColor>
          {L.bandLast(ago(L, t - hit.at), tokens(hit.read), tokens(hit.write))}
          {remaining > 0 ? '' : L.bandRewrite(tokens(contextOf(hit)))}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, settings)
    const hit = await read($, last)
    const st = await read($, stats)
    const L: Strings = STRINGS[s.lang]
    const state = await read($, alert)
    const t = await read($, now)
    const total = ttlMs(s.ttl)
    const remaining = hit === null ? 0 : hit.at + total - t
    const fraction = remaining / total
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - 4))
    const hitRate = st.requests === 0 ? '—' : `${Math.round((st.hits / st.requests) * 100)}%`

    const headline =
      hit === null ? (
        <Text dimColor>{state === 'compacted' ? L.compactedHint : L.noCacheHint}</Text>
      ) : remaining > 0 ? (
        <Box flexDirection="column">
          <Text bold color={tone(fraction)}>
            {L.remaining(clock(remaining), clock(total))}
          </Text>
          <Text color={tone(fraction)}>{bar(fraction, width)}</Text>
        </Box>
      ) : (
        <Text bold color="error">
          {L.expired}
        </Text>
      )

    return (
      <Box flexDirection="column" gap={1}>
        {headline}

        {hit !== null && (
          <Box flexDirection="column">
            <Text>{L.lastLine(ago(L, t - hit.at))}</Text>
            <Text>{L.tokensLine(tokens(hit.read), tokens(hit.write), tokens(hit.uncached))}</Text>
            <Text dimColor>{L.rewriteLine(tokens(contextOf(hit)))}</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>{L.thisSession}</Text>
          <Text>{L.statsLine(hitRate, st.hits, st.requests, st.expiries, st.compactions)}</Text>
          {st.history.length > 0 && <Text dimColor>{L.historyLine(spark(st.history))}</Text>}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text bold>{L.settings}</Text>
          <Box flexDirection="row" gap={1}>
            <Text>{L.ttlLabel(L.source[s.ttlSource])}</Text>
            <Button key="ttl-5m" label="5m" variant={s.ttl === '5m' ? 'primary' : 'secondary'} onPress={() => saveSettings($, x => ({ ...x, ttl: '5m', ttlSource: 'manual' }))} />
            <Button key="ttl-1h" label="1h" variant={s.ttl === '1h' ? 'primary' : 'secondary'} onPress={() => saveSettings($, x => ({ ...x, ttl: '1h', ttlSource: 'manual' }))} />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text>{L.autoCompact}</Text>
            <Button
              key="auto"
              label={s.isAutoCompact ? L.on : L.off}
              variant={s.isAutoCompact ? 'primary' : 'secondary'}
              onPress={() => saveSettings($, x => ({ ...x, isAutoCompact: !x.isAutoCompact }))}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text>{L.lead}</Text>
            {[60, 120, 300].map(sec => (
              <Button
                key={`lead-${sec}`}
                label={L.minutes(sec / 60)}
                variant={s.leadSeconds === sec ? 'primary' : 'secondary'}
                onPress={() => saveSettings($, x => ({ ...x, leadSeconds: sec }))}
              />
            ))}
          </Box>
          <Text dimColor>{L.leadNote(Math.round(leadMs(s) / 1000), tokens(MIN_COMPACT_TOKENS))}</Text>
          <Box flexDirection="row" gap={1}>
            <Text>{L.band}</Text>
            <Button
              key="band"
              label={s.isBandShown ? L.shown : L.hidden}
              variant={s.isBandShown ? 'primary' : 'secondary'}
              onPress={() => saveSettings($, x => ({ ...x, isBandShown: !x.isBandShown }))}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text>{L.language}</Text>
            {LANGS.map(lang => (
              <Button
                key={`lang-${lang}`}
                label={LANG_LABEL[lang]}
                variant={s.lang === lang ? 'primary' : 'secondary'}
                onPress={() => saveSettings($, x => ({ ...x, lang }))}
              />
            ))}
          </Box>
        </Box>

        <Button key="compact-now" label={L.compactConversation} onPress={() => compactNow($, 'manual')} />
      </Box>
    )
  })
}
