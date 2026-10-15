import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheAlert, CacheHit, CacheLang, CacheSettings, CacheStats, CacheTtl, SavedSession } from '../types'

const PANE = 'cache-timer'
const STORE_KEY = 'settings'
/** The userConfig language last seen, so a change there wins over the stored one. */
const CONFIG_LANG_KEY = 'configLang'
/** Below this context size a compaction saves too little to be worth losing detail. */
const MIN_COMPACT_TOKENS = 20_000
const HISTORY = 30
/** Store key prefix for one session's last hit and stats, which outlive a restart. */
const SESSION_KEY_PREFIX = 'session:'
/** How many sessions' saved hits the store keeps; the oldest go first. */
const SESSIONS_KEPT = 20
/** From this much time left the countdown shows seconds; above it, whole minutes. */
const SECONDS_SHOWN_FROM_MS = 5 * 60_000

const DEFAULTS: CacheSettings = {
  ttl: '1h',
  isAutoCompact: false,
  leadSeconds: 120,
  isBandShown: true,
  isStatusShown: true,
  isSecondsShown: false,
  ttlSource: 'default',
  lang: 'en',
}

const settings = atom({ plugin: 'cache-timer', key: 'settings' } as const, DEFAULTS)
const last = atom({ plugin: 'cache-timer', key: 'last' } as const, null)
const NO_STATS: CacheStats = { requests: 0, hits: 0, expiries: 0, compactions: 0, history: [] }
const stats = atom({ plugin: 'cache-timer', key: 'stats' } as const, NO_STATS)
const alert = atom({ plugin: 'cache-timer', key: 'alert' } as const, 'none')
const now = atom({ plugin: 'cache-timer', key: 'now' } as const, 0)
const compactingSince = atom({ plugin: 'cache-timer', key: 'compactingSince' } as const, 0)
const isPaneOpen = atom({ plugin: 'cache-timer', key: 'isPaneOpen' } as const, false)
/** A compaction that has not ended after this long is shown as over, so Compact never stays stuck. */
const COMPACTING_GIVE_UP_MS = 120_000
/** Cells of the status line's bar. */
const STATUS_BAR_CELLS = 8
/** The band's bar is this wide at most, and dropped below the least. */
const BAND_BAR_MAX = 10
const BAND_BAR_MIN = 4

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

/** Fixed colors for the SVG bar, which can't use theme keys: mid-tones that read on light and dark. */
const SVG_TONE = { success: '#3fb950', warning: '#d29922', error: '#f85149' } as const
const SVG_TRACK = '#8b949e55'
/** CSS pixels the SVG bar takes per cell the text bar would. */
const SVG_PX_PER_CELL = 10

const isWide = (code: number) =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6)

/** Terminal cells a string takes: East Asian wide characters take two. */
export const cells = (text: string) => [...text].reduce((n, ch) => n + (isWide(ch.codePointAt(0) ?? 0) ? 2 : 1), 0)

export const LANGS = ['en', 'zh-TW'] as const

/** Canonical language for a typed or configured value, case-insensitive. */
export const langOf = (value: unknown): CacheLang | undefined =>
  typeof value === 'string' ? LANGS.find(l => l.toLowerCase() === value.toLowerCase()) : undefined

/** Every UI string, keyed by language. */
export const STRINGS = {
  en: {
    notifyTitle: 'Cache timer',
    bandPrefix: 'cache',
    commandDescription: 'Prompt cache timer: open the pane, or auto on|off, ttl 5m|1h, band on|off, status on|off, seconds on|off, lang en|zh-TW',
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
    statusReply: (shown: string) => `Countdown in the status line: ${shown}`,
    secondsReply: (onOff: string) => `Always show seconds: ${onOff}`,
    langReply: 'Language set to English',
    compactFailed: (why: string) => `Compaction failed: ${why}`,
    alreadyCompacting: 'Already compacting the conversation',
    usage: 'Usage: /cache [auto on|off] [ttl 5m|1h] [band on|off] [status on|off] [seconds on|off] [lang en|zh-TW]',
    autoLabel: (onOff: string) => `auto-compact ${onOff}`,
    compactNow: 'Compact',
    pane: 'Pane',
    hide: 'Hide',
    bandRewrite: (tok: string) => `next message re-writes ~${tok}`,
    compacting: 'Compacting…',
    statusHead: (b: string, c: string) => `cache ${b} ${c} left`,
    compactedHint: 'Compacted; the next message writes a fresh cache',
    noCacheHint: 'No cache yet; the timer starts after your first message',
    remaining: (c: string) => `${c} left`,
    lastLine: (ago: string) => `Last read/write: ${ago}`,
    tokensLine: (r: string, w: string, u: string) => `This request read ${r} · wrote ${w} · uncached ${u}`,
    estimatedLine: (tok: string) => `Restored after a restart: about ${tok} tokens of context; read and write unknown`,
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
    statusLine: 'Countdown in the status line',
    seconds: 'Always show seconds',
    language: 'Language',
    compactConversation: 'Compact conversation now',
  },
  'zh-TW': {
    notifyTitle: '快取計時器',
    bandPrefix: 'cache',
    commandDescription: 'Prompt 快取計時器：開啟面板，或 auto on|off、ttl 5m|1h、band on|off、status on|off、seconds on|off、lang en|zh-TW',
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
    statusReply: (shown: string) => `狀態列倒數：${shown}`,
    secondsReply: (onOff: string) => `永遠顯示秒數：${onOff}`,
    langReply: '介面語言已設為繁體中文',
    compactFailed: (why: string) => `壓縮失敗：${why}`,
    alreadyCompacting: '正在壓縮對話',
    usage: '用法：/cache [auto on|off] [ttl 5m|1h] [band on|off] [status on|off] [seconds on|off] [lang en|zh-TW]',
    autoLabel: (onOff: string) => `自動壓縮 ${onOff}`,
    compactNow: '立即壓縮',
    pane: '面板',
    hide: '隱藏',
    bandRewrite: (tok: string) => `下一則重寫約 ${tok}`,
    compacting: '壓縮中…',
    statusHead: (b: string, c: string) => `快取 ${b} 剩 ${c}`,
    compactedHint: '已壓縮，下一則訊息會寫入新的快取',
    noCacheHint: '還沒有快取，送出第一則訊息後開始計時',
    remaining: (c: string) => `剩餘 ${c}`,
    lastLine: (ago: string) => `上次讀寫：${ago}`,
    tokensLine: (r: string, w: string, u: string) => `這次讀取 ${r} · 寫入 ${w} · 未快取 ${u}`,
    estimatedLine: (tok: string) => `重開後還原：上下文約 ${tok} tokens，讀寫各多少不明`,
    rewriteLine: (tok: string) => `過期後重新寫入約 ${tok} tokens`,
    thisSession: '本 session',
    statsLine: (rate: string, hits: number, requests: number, expiries: number, compactions: number) =>
      `命中率 ${rate}（${hits}/${requests} 次請求）· 過期 ${expiries} 次 · 壓縮 ${compactions} 次`,
    historyLine: (sp: string) => `每次請求的快取比例：${sp}`,
    settings: '設定',
    ttlLabel: (source: string) => `TTL（${source}）`,
    autoCompact: '到期前自動壓縮',
    lead: '提前',
    minutes: (m: number) => `${m} 分鐘`,
    leadNote: (sec: number, min: string) =>
      `實際在剩 ${sec} 秒時壓縮（5m TTL 最多提前 1 分鐘）；上下文不到 ${min} tokens 時不自動壓縮。`,
    band: '提示框上方進度條',
    statusLine: '狀態列倒數',
    seconds: '永遠顯示秒數',
    language: '語言',
    compactConversation: '立即壓縮對話',
  },
} as const

type Strings = (typeof STRINGS)[CacheLang]

/**
 * Time left as shown in the status line, band and pane: whole minutes, rounded
 * up, while more than 5 minutes are left; from there (or always, with seconds
 * on) `mm:ss`.
 */
export const countdown = (lang: CacheLang, remainingMs: number, isSecondsShown: boolean) =>
  isSecondsShown || remainingMs <= SECONDS_SHOWN_FROM_MS ? clock(remainingMs) : STRINGS[lang].minutes(Math.ceil(remainingMs / 60_000))

const LANG_LABEL: Record<CacheLang, string> = { en: 'English', 'zh-TW': '繁體中文' }

const strings = async ($: EngineInterface): Promise<Strings> => STRINGS[(await read($, settings)).lang] ?? STRINGS.en

const wholeMinutes = (ms: number) => Math.floor(ms / 60_000)

const ago = (L: Strings, ms: number) => {
  const minutes = wholeMinutes(ms)

  return minutes < 1 ? L.lessThanMinuteAgo : L.minutesAgo(minutes)
}

let ticker: { cancel: () => void } | undefined
let isCompacting = false
let compactTriedFor = 0
/** Model turns that started and haven't ended; `$.session.compact()` rejects while there are any. */
const runningTurns = new Set<string>()
/**
 * A headless session (the desktop app, the SDK, `-p`) has no `$.session.compact()`:
 * compaction there runs inside a turn, as `/compact`.
 */
let isHeadless = false

/** How a compaction the mod asked for ended. */
type CompactOutcome =
  | { kind: 'compacted' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'busy' }
  | { kind: 'failed'; reason: string }
  | { kind: 'already' }
  /** Ran `/compact`, which reports its own result in the transcript. */
  | { kind: 'ran' }

/** An outcome worth a toast: one that didn't compact, and didn't run `/compact` (which reports itself). */
type CompactNotice = Exclude<CompactOutcome, { kind: 'compacted' } | { kind: 'ran' }>

const outcomeText = (L: Strings, o: CompactNotice) => {
  switch (o.kind) {
    case 'skipped':
      return L.compactSkipped(o.reason)
    case 'busy':
      return L.busy
    case 'failed':
      return L.compactFailed(o.reason)
    case 'already':
      return L.alreadyCompacting
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)) || 'unknown error'

/** `$.ui.notify`, which the engine has but its shipped declarations leave out. */
type Notifier = { notify: (text: string, options?: { title?: string }) => Promise<unknown> }

/** A native notification where the surface has one; the toast is the reminder everywhere. */
async function notify($: EngineInterface, text: string) {
  try {
    await ($.ui as EngineInterface['ui'] & Notifier).notify(text, { title: (await strings($)).notifyTitle })
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
  const head =
    hit === null
      ? L.noTimer
      : remaining > 0
        ? L.remainingHead(countdown(s.lang, remaining, s.isSecondsShown))
        : L.expired
  const rate = st.requests === 0 ? '—' : `${Math.round((st.hits / st.requests) * 100)}%`

  return [
    L.summaryHead(head, s.ttl, L.source[s.ttlSource]),
    L.summaryStats(rate, st.hits, st.requests, st.expiries, st.compactions),
    L.summaryAuto(s.isAutoCompact ? L.on : L.off, Math.round(leadMs(s) / 1000)),
  ].join('\n')
}

/** Opens the pane; a surface that places none gets the summary as a toast. */
async function openPane($: EngineInterface, isFocused: boolean) {
  // `/cache` leaves `focus` out: the host refuses any `focus` value from a command.
  const title = (await strings($)).paneTitle
  const { isPlaced } = await $.ui.open(isFocused ? { id: PANE, title, focus: true } : { id: PANE, title })
  await update($, isPaneOpen, () => isPlaced)

  return isPlaced
}

/** The band's Pane button: opens the pane, or closes it while it is open. */
async function togglePane($: EngineInterface) {
  if (await read($, isPaneOpen)) {
    await $.ui.close({ id: PANE })
    await update($, isPaneOpen, () => false)

    return
  }

  if (!(await openPane($, true))) $.ui.toast(await summary($), { timeoutMs: 8000 })
}

async function saveSettings($: EngineInterface, fn: (s: CacheSettings) => CacheSettings) {
  const before = (await read($, settings)).lang
  await update($, settings, s => fn(s ?? DEFAULTS))
  const after = await read($, settings)
  await $.store.set(STORE_KEY, after)
  if (after.lang !== before) await retitlePane($)
}

/** Re-opening an open pane's id only retitles it; a closed pane stays closed. */
async function retitlePane($: EngineInterface) {
  if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
  await $.ui.open({ id: PANE, title: (await strings($)).paneTitle })
}

async function markCompacted($: EngineInterface) {
  await update($, compactingSince, () => 0)
  await update($, last, () => null)
  await update($, alert, (): CacheAlert => 'compacted')
  await update($, stats, st => ({ ...st, compactions: st.compactions + 1 }))
  await saveSession($)
}

/** Keeps this session's last hit and stats in the store, where a restart finds them. */
async function saveSession($: EngineInterface) {
  const saved: SavedSession = { last: await read($, last), stats: await read($, stats), savedAt: await $.clock.now() }
  await $.store.set(SESSION_KEY_PREFIX + (await $.session.id()), saved)
}

/** Drops all but the most recently saved sessions. */
async function pruneSessions($: EngineInterface) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(SESSION_KEY_PREFIX))
  if (keys.length <= SESSIONS_KEPT) return

  const dated = await Promise.all(
    keys.map(async key => ({ key, savedAt: ((await $.store.get(key)) as SavedSession | undefined)?.savedAt ?? 0 })),
  )
  dated.sort((a, b) => b.savedAt - a.savedAt)
  for (const { key } of dated.slice(SESSIONS_KEPT)) await $.store.delete(key)
}

/**
 * Puts a hit found after a restart back on the timer, with the reminders that
 * already fired for it marked as fired and no auto-compact the moment it loads.
 */
async function restoreHit($: EngineInterface, hit: CacheHit | null, st: CacheStats) {
  const t = await $.clock.now()
  const s = await read($, settings)
  await update($, last, () => hit)
  await update($, stats, () => st)
  await update($, now, () => t)
  if (hit === null) return

  const remaining = hit.at + ttlMs(s.ttl) - t
  await update($, alert, (): CacheAlert => (remaining <= 0 ? 'expired' : remaining <= warnMs(s.ttl) ? 'warned' : 'none'))
  if (remaining <= leadMs(s)) compactTriedFor = hit.at
}

/** Restores this session's saved hit; false when the store has none for it. */
async function restoreSession($: EngineInterface) {
  const saved = (await $.store.get(SESSION_KEY_PREFIX + (await $.session.id()))) as SavedSession | undefined
  if (saved === undefined) return false

  await restoreHit($, saved.last, saved.stats)

  return true
}

/**
 * The hit a resumed transcript implies when the store has none for it (a
 * session from before this version, or a fork): its last response's time and
 * context size, with the read/write split unknown.
 */
async function estimateHit($: EngineInterface, secondsSince: number, contextTokens: number) {
  const hit: CacheHit = { at: (await $.clock.now()) - secondsSince * 1000, read: contextTokens, write: 0, uncached: 0, isEstimated: true }
  await restoreHit($, hit, NO_STATS)
}

/** A line in the debug log; `$.ui.log` is missing in tests. */
function debugLog($: EngineInterface, text: string) {
  try {
    $.ui.log(`cache-timer: ${text}`, { to: 'debug' })
  } catch {
    // No log on this host.
  }
}

async function compactNow($: EngineInterface): Promise<CompactOutcome> {
  if (isCompacting) return { kind: 'already' }
  isCompacting = true
  const startedAt = await $.clock.now()
  await update($, compactingSince, () => startedAt)
  let isRan = false

  try {
    if (isHeadless) {
      const ran = await compactByCommand($)
      isRan = true

      return ran
    }

    const result = await $.session.compact()

    if (result.skip !== undefined) return { kind: 'skipped', reason: result.skip }

    // Our own call skips our session.compact hook, so the reset happens here.
    if ((await read($, last)) !== null) await markCompacted($)

    return { kind: 'compacted' }
  } catch (err) {
    debugLog($, `compaction rejected (${runningTurns.size} turns running): ${errorText(err)}`)

    // It rejects while a turn runs; anything else is a real failure, with its reason.
    return runningTurns.size > 0 ? { kind: 'busy' } : { kind: 'failed', reason: errorText(err) }
  } finally {
    isCompacting = false
    // `/compact` may still be running; the session.compact hook, the turn's end or the give-up clears it.
    if (!isRan) await update($, compactingSince, () => 0)
  }
}

/** Runs `/compact` once the session is idle; our session.compact hook resets the timer if it compacts. */
async function compactByCommand($: EngineInterface): Promise<CompactOutcome> {
  await $.command.run({ command: 'compact', args: '' })

  return { kind: 'ran' }
}

/**
 * The Compact buttons. A press handler has a 10-second budget and a compaction
 * can take longer, so the press only starts it and returns.
 */
function pressCompact($: EngineInterface) {
  void compactAndReport($).catch(err => debugLog($, `compact press failed: ${errorText(err)}`))
}

/**
 * Compacts, then says how it went, unless it compacted or `/compact` already
 * said so. A press while a compaction runs does nothing: the button says so.
 */
async function compactAndReport($: EngineInterface) {
  if ((await read($, compactingSince)) !== 0) return
  const outcome = await compactNow($)
  if (outcome.kind === 'compacted' || outcome.kind === 'ran') return
  $.ui.toast(outcomeText(await strings($), outcome))
}

/** The time-driven text the band and pane show at `t`: the countdown and "N min ago". */
const shownAt = (s: CacheSettings, hit: CacheHit, t: number) => {
  const remaining = hit.at + ttlMs(s.ttl) - t
  const left = remaining > 0 ? countdown(s.lang, remaining, s.isSecondsShown) : ''

  return `${left}|${wholeMinutes(t - hit.at)}`
}

/** The status line's text as last set; undefined while it is clear. */
let shownStatus: string | undefined
/** When the status line was last set. */
let statusSentAt = 0
/** Whether the prompt area was drawn since the status line was last set. */
let isRedrawn = false
/**
 * How often an unchanged status line is set again. After an app restart the
 * first one can come before the surface is ready to draw it.
 */
const STATUS_RESEND_MS = 15_000
/**
 * How soon after the last set a redraw of the prompt area sets it again. The
 * first redraw after a restart means the surface is up, as the band shows.
 */
const STATUS_REDRAWN_RESEND_MS = 3_000

/**
 * Keeps the countdown in the status line, which stays visible where the host
 * hides the band (under the desktop app's dialogs and cards). Sets it when its
 * text changes, and again while it shows: after the prompt area is redrawn (at
 * most every 3 seconds) and every 15 seconds. Clears it while no cache is timed
 * or it is turned off.
 */
async function showStatus($: EngineInterface) {
  const hit = await read($, last)
  const s = await read($, settings)
  let text: string | undefined
  if (hit !== null && s.isStatusShown) {
    const L: Strings = STRINGS[s.lang]
    const remaining = hit.at + ttlMs(s.ttl) - (await $.clock.now())
    text =
      remaining > 0
        ? L.statusHead(bar(remaining / ttlMs(s.ttl), STATUS_BAR_CELLS), countdown(s.lang, remaining, s.isSecondsShown))
        : L.expired
  }
  const t = await $.clock.now()
  const resendMs = isRedrawn ? STATUS_REDRAWN_RESEND_MS : STATUS_RESEND_MS
  if (text === shownStatus && (text === undefined || t - statusSentAt < resendMs)) return

  shownStatus = text
  statusSentAt = t
  isRedrawn = false
  $.ui.status(text)
}

/**
 * Writes `now` (which redraws the band and pane) only when what they show
 * changes: once a minute while minutes are shown or after expiry, every second
 * while seconds are, and never while no cache is timed.
 */
async function tick($: EngineInterface) {
  await showStatus($)
  const t = await $.clock.now()
  const since = await read($, compactingSince)
  if (since !== 0 && !isCompacting && t - since > COMPACTING_GIVE_UP_MS) await update($, compactingSince, () => 0)
  const hit = await read($, last)
  if (hit === null) return

  const s = await read($, settings)
  if (shownAt(s, hit, t) !== shownAt(s, hit, await read($, now))) await update($, now, () => t)

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
    // Busy or failed stays quiet: a running turn keeps the cache warm itself.
    const outcome = await compactNow($)
    const L = await strings($)
    if (outcome.kind === 'compacted') {
      $.ui.toast(L.autoCompacted)
      void notify($, L.autoCompacted)
    } else if (outcome.kind === 'skipped') {
      $.ui.toast(outcomeText(L, outcome))
    }

    return
  }

  if (state === 'none' && remaining <= warnMs(s.ttl)) {
    await update($, alert, () => 'warned')
    const message = STRINGS[s.lang].warnToast(clock(remaining))
    $.ui.toast(message, { timeoutMs: 8000 })
    void notify($, message)
  }
}

/** Cells a terminal button adds around its label: `[ label ]`. */
const BUTTON_CHROME = 4

/** The elements the bar draws with. */
type MeterElements = {
  Text: Elements['terminal']['Text']
  Svg?: Elements['desktop']['Svg']
}

/**
 * The time-left bar, `width` cells wide: block characters in the terminal, a
 * rounded SVG bar on the other surfaces (the terminal's table has an `Svg` too,
 * but it draws nothing).
 */
function meter(els: MeterElements, surface: string, fraction: number, width: number) {
  const { Text, Svg } = els
  const share = Math.min(1, Math.max(0, fraction))
  const color = tone(fraction)

  if (surface !== 'terminal' && Svg !== undefined) {
    const px = width * SVG_PX_PER_CELL
    const fill = Math.round(share * px)
    const source =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="8" viewBox="0 0 ${px} 8">` +
      `<rect width="${px}" height="8" rx="4" fill="${SVG_TRACK}"/>` +
      `<rect width="${fill}" height="8" rx="4" fill="${SVG_TONE[color]}"/></svg>`

    return <Svg source={source} alt={`${Math.round(share * 100)}%`} width={px} height={8} />
  }

  return <Text color={color}>{bar(share, width)}</Text>
}

/** One pane setting: its label and a button per value, the current one primary. */
function settingRow<T extends string | number | boolean>(
  els: { Box: Elements['terminal']['Box']; Text: Elements['terminal']['Text']; Button: Elements['terminal']['Button'] },
  key: string,
  label: string,
  options: readonly { value: T; label: string }[],
  current: T,
  pick: (value: T) => unknown,
) {
  const { Box, Text, Button } = els

  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Text>{label}</Text>
      {options.map(o => (
        <Button
          key={`${key}-${String(o.value)}`}
          label={o.label}
          variant={o.value === current ? 'primary' : 'secondary'}
          onPress={() => void pick(o.value)}
        />
      ))}
    </Box>
  )
}

/** Cells each part of the band's row takes; `prefix` 0 when there is none. */
export type BandWidths = { prefix: number; head: number; meta: number; compact: number; pane: number; hide: number; hasBar: boolean }

/**
 * What fits in the band's one row at `columns`. As it narrows, the bar shrinks
 * to its least, then the meta text goes, then the prefix, then Pane, then the
 * bar. The countdown, Compact and Hide always stay.
 */
export const bandLayout = (columns: number, w: BandWidths) => {
  for (let level = 0; level <= 4; level++) {
    const shown = { prefix: level < 2 && w.prefix > 0, meta: level < 1, pane: level < 3 }
    const parts = [shown.prefix ? w.prefix : 0, w.head, shown.meta ? w.meta : 0, w.compact, shown.pane ? w.pane : 0, w.hide].filter(n => n > 0)
    const fixed = parts.reduce((a, b) => a + b, 0) + parts.length - 1

    if (level < 4 && w.hasBar) {
      const barCells = Math.min(BAND_BAR_MAX, columns - fixed - 1)
      if (barCells >= BAND_BAR_MIN) return { ...shown, barCells }
    } else if (fixed <= columns || level === 4) {
      return { ...shown, barCells: 0 }
    }
  }

  return { prefix: false, meta: false, pane: false, barCells: 0 }
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    isHeadless = !e.isInteractive
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
      description: (await strings($)).commandDescription,
      argumentHint: '[auto on|off] [ttl 5m|1h] [band on|off] [status on|off] [seconds on|off] [lang en|zh-TW]',
    })

    // A pane can outlive a reload of the module; the engine's list says whether it is up.
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    await update($, isPaneOpen, () => isUp)

    const isRestored = await restoreSession($)
    debugLog($, `session ${await $.session.id()} started, saved hit ${isRestored ? 'restored' : 'not found'}`)
    await pruneSessions($)
    await showStatus($)

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
      await saveSession($)
    }

    return response
  })

  on('turn.start', async ($, e, next) => {
    runningTurns.add(e.turnId)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    runningTurns.delete(e.turnId)
    // A `/compact` the mod ran (headless) ends with its turn.
    if (!isCompacting) await update($, compactingSince, () => 0)

    return next(e)
  })

  // Any compaction of the main thread (/compact, auto, ours) replaces the cached prefix.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined && e.trigger !== 'precompute') {
      // Only a `/compact` raises this; the mod's own `$.session.compact()` does not.
      if (result.skip === undefined) await markCompacted($)
      else await update($, compactingSince, () => 0)
    }

    return result
  })

  // A resume or fork in the same process starts no session.start; either way the store or the transcript says when the cache was last used.
  on('classic.SessionStart', async ($, e, next) => {
    if ((e.source === 'resume' || e.source === 'fork') && !(await restoreSession($))) {
      const seconds = e.seconds_since_last_response
      const context = e.context_tokens
      if (seconds !== undefined && context !== undefined && context > 0) await estimateHit($, seconds, context)
      debugLog($, `session ${await $.session.id()} ${e.source}: estimated from the transcript`)
    }

    return next(e)
  })

  // Any close of the pane (the Pane button, its own close mark or key, an unload) unlights the button.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, isPaneOpen, () => false)

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
      return { text: (await openPane($, false)) ? L.paneOpened : await summary($) }
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

    if (verb === 'status' && (value === 'on' || value === 'off')) {
      await saveSettings($, s => ({ ...s, isStatusShown: value === 'on' }))

      return { text: L.statusReply(value === 'on' ? L.shown : L.hidden) }
    }

    if (verb === 'seconds' && (value === 'on' || value === 'off')) {
      await saveSettings($, s => ({ ...s, isSecondsShown: value === 'on' }))

      return { text: L.secondsReply(value === 'on' ? L.on : L.off) }
    }

    const lang = langOf(value)
    if (verb === 'lang' && lang !== undefined) {
      await saveSettings($, s => ({ ...s, lang }))

      return { text: STRINGS[lang].langReply }
    }

    return { text: L.usage }
  })


  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The next tick sets the status line again: this redraw may be the first the surface makes.
    isRedrawn = true
    const s = await read($, settings)
    const hit = await read($, last)
    const state = await read($, alert)

    if (e.props.hasSurvey || !s.isBandShown || (hit === null && state !== 'compacted')) {
      return next(e)
    }

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const L: Strings = STRINGS[s.lang]
    const isTerminal = e.surface === 'terminal'
    const isPaneUp = await read($, isPaneOpen)
    const paneButton = (
      <Button
        key="pane"
        label={L.pane}
        variant={isPaneUp ? 'primary' : 'secondary'}
        dimColor={!isPaneUp}
        onPress={() => togglePane($)}
      />
    )
    const hideLabel = isTerminal ? '✕' : L.hide
    const hideBand = () => saveSettings($, x => ({ ...x, isBandShown: false }))
    const hide = isTerminal ? (
      <Button key="hide" label={hideLabel} plain dimColor onPress={hideBand} />
    ) : (
      <Button key="hide" label={hideLabel} role="dismiss" onPress={hideBand} />
    )

    if (hit === null) {
      return (
        <Box flexDirection="row" gap={1} flexWrap="nowrap">
          <Text dimColor wrap="truncate">
            {L.compactedHint}
          </Text>
          {paneButton}
          {hide}
        </Box>
      )
    }

    const t = await read($, now)
    const total = ttlMs(s.ttl)
    const remaining = hit.at + total - t
    const fraction = remaining / total
    const isLive = remaining > 0
    const head = isLive ? countdown(s.lang, remaining, s.isSecondsShown) : L.expired
    const meta = isLive ? L.autoLabel(s.isAutoCompact ? L.on : L.off) : L.bandRewrite(tokens(contextOf(hit)))
    const isCompactingNow = (await read($, compactingSince)) !== 0
    const compactLabel = isCompactingNow ? L.compacting : L.compactNow
    const layout = bandLayout(e.props.bodyColumns, {
      prefix: isLive ? cells(L.bandPrefix) : 0,
      head: cells(head),
      meta: cells(`· ${meta}`),
      compact: cells(compactLabel) + BUTTON_CHROME,
      pane: cells(L.pane) + BUTTON_CHROME,
      hide: isTerminal ? cells(hideLabel) : cells(hideLabel) + BUTTON_CHROME,
      hasBar: isLive,
    })
    const color = isLive ? tone(fraction) : 'error'

    return (
      <Box flexDirection="row" gap={1} flexWrap="nowrap">
        {layout.prefix && isLive && <Text color={color}>{L.bandPrefix}</Text>}
        {layout.barCells > 0 && meter(els, e.surface, fraction, layout.barCells)}
        <Text color={color} wrap="truncate">
          {head}
        </Text>
        {layout.meta && (
          <Text dimColor wrap="truncate">
            · {meta}
          </Text>
        )}
        <Button
          key="compact"
          label={compactLabel}
          variant="primary"
          dimColor={isCompactingNow}
          onPress={() => pressCompact($)}
        />
        {layout.pane && paneButton}
        {hide}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
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
    const isCompactingNow = (await read($, compactingSince)) !== 0
    const onOff = [
      { value: true, label: L.on },
      { value: false, label: L.off },
    ]
    const shownHidden = [
      { value: true, label: L.shown },
      { value: false, label: L.hidden },
    ]

    const headline =
      hit === null ? (
        <Text dimColor>{state === 'compacted' ? L.compactedHint : L.noCacheHint}</Text>
      ) : remaining > 0 ? (
        <Box flexDirection="column">
          <Text bold color={tone(fraction)}>
            {L.remaining(countdown(s.lang, remaining, s.isSecondsShown))}
          </Text>
          {meter(els, e.surface, fraction, width)}
        </Box>
      ) : (
        <Text bold color="error">
          {L.expired}
        </Text>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          {headline}
          <Box flexDirection="row">
            <Button
              key="compact-now"
              label={isCompactingNow ? L.compacting : L.compactConversation}
              variant="primary"
              dimColor={isCompactingNow}
              onPress={() => pressCompact($)}
            />
          </Box>
        </Box>

        {hit !== null && (
          <Box flexDirection="column">
            <Text>{L.lastLine(ago(L, t - hit.at))}</Text>
            <Text>
              {hit.isEstimated
                ? L.estimatedLine(tokens(contextOf(hit)))
                : L.tokensLine(tokens(hit.read), tokens(hit.write), tokens(hit.uncached))}
            </Text>
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
          {settingRow(els, 'ttl', L.ttlLabel(L.source[s.ttlSource]), [{ value: '5m', label: '5m' }, { value: '1h', label: '1h' }], s.ttl, ttl =>
            saveSettings($, x => ({ ...x, ttl, ttlSource: 'manual' })),
          )}
          {settingRow(els, 'auto', L.autoCompact, onOff, s.isAutoCompact, v => saveSettings($, x => ({ ...x, isAutoCompact: v })))}
          {settingRow(
            els,
            'lead',
            L.lead,
            [60, 120, 300].map(sec => ({ value: sec, label: L.minutes(sec / 60) })),
            s.leadSeconds,
            v => saveSettings($, x => ({ ...x, leadSeconds: v })),
          )}
          <Text dimColor>{L.leadNote(Math.round(leadMs(s) / 1000), tokens(MIN_COMPACT_TOKENS))}</Text>
          {settingRow(els, 'band', L.band, shownHidden, s.isBandShown, v => saveSettings($, x => ({ ...x, isBandShown: v })))}
          {settingRow(els, 'status', L.statusLine, shownHidden, s.isStatusShown, v => saveSettings($, x => ({ ...x, isStatusShown: v })))}
          {settingRow(els, 'seconds', L.seconds, onOff, s.isSecondsShown, v => saveSettings($, x => ({ ...x, isSecondsShown: v })))}
          {settingRow(
            els,
            'lang',
            L.language,
            LANGS.map(lang => ({ value: lang, label: LANG_LABEL[lang] })),
            s.lang,
            lang => saveSettings($, x => ({ ...x, lang })),
          )}
        </Box>
      </Box>
    )
  })
}
