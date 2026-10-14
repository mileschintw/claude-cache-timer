import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheAlert, CacheHit, CacheSettings, CacheStats, CacheTtl } from '../types'

const PANE = 'cache-timer'
const STORE_KEY = 'settings'
/** Below this context size a compaction saves too little to be worth losing detail. */
const MIN_COMPACT_TOKENS = 20_000
const HISTORY = 30

const DEFAULTS: CacheSettings = {
  ttl: '1h',
  isAutoCompact: false,
  leadSeconds: 120,
  isBandShown: true,
  ttlSource: 'default',
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

const ago = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)

  return minutes < 1 ? '不到 1 分鐘前' : `${minutes} 分鐘前`
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

const SOURCE_LABEL = { default: '預設', observed: '自動偵測', switch: '切換模型時回報', manual: '手動設定' } as const

/** The pane's figures as text, for a surface that places no pane. */
async function summary($: EngineInterface) {
  const s = await read($, settings)
  const hit = await read($, last)
  const st = await read($, stats)
  const t = await $.clock.now()
  const remaining = hit === null ? 0 : hit.at + ttlMs(s.ttl) - t
  const head = hit === null ? '目前沒有在計時的快取' : remaining > 0 ? `快取剩 ${clock(remaining)}` : '快取已過期'
  const rate = st.requests === 0 ? '—' : `${Math.round((st.hits / st.requests) * 100)}%`

  return [
    `${head}（TTL ${s.ttl}，${SOURCE_LABEL[s.ttlSource]}）`,
    `命中率 ${rate}（${st.hits}/${st.requests}）· 過期 ${st.expiries} 次 · 壓縮 ${st.compactions} 次`,
    `到期前自動壓縮：${s.isAutoCompact ? '開' : '關'}，提前 ${Math.round(leadMs(s) / 1000)} 秒`,
  ].join('\n')
}

async function openPane($: EngineInterface) {
  const { isPlaced } = await $.ui.open({ id: PANE, title: 'Prompt cache' })
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
    const result = await $.session.compact()

    if (result.skip !== undefined) {
      $.ui.toast(`壓縮被略過：${result.skip}`)

      return
    }

    // Our own call skips our session.compact hook, so the reset happens here.
    if ((await read($, last)) !== null) await markCompacted($)

    if (why === 'auto') {
      $.ui.toast('快取快過期了，已自動壓縮對話')
      void notify($, '快取快過期了，已自動壓縮對話')
    }
  } catch {
    // Rejects while a turn runs: that turn's own requests keep the cache warm.
    if (why === 'manual') $.ui.toast('Claude 正在回覆，等這一輪結束再壓縮')
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
    const message = `快取已過期，下一則訊息會重新寫入約 ${tokens(contextOf(hit))} tokens`
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
    const message = `快取剩 ${clock(remaining)}，這時回來繼續最省`
    $.ui.toast(message, { timeoutMs: 8000 })
    void notify($, message)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(STORE_KEY)) as Partial<CacheSettings> | undefined
    if (saved) await update($, settings, () => ({ ...DEFAULTS, ...saved }))

    await $.command.register({
      name: 'cache',
      description: 'Prompt cache timer: open the pane, or auto on|off, ttl 5m|1h, band on|off, compact',
      argumentHint: '[auto on|off] [ttl 5m|1h] [band on|off] [compact]',
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

    if (verb === undefined) {
      const { isPlaced } = await $.ui.open({ id: PANE, title: 'Prompt cache' })

      return { text: isPlaced ? '已開啟快取面板。' : await summary($) }
    }

    if (verb === 'auto' && (value === 'on' || value === 'off')) {
      await saveSettings($, s => ({ ...s, isAutoCompact: value === 'on' }))

      return { text: `到期前自動壓縮：${value === 'on' ? '開' : '關'}` }
    }

    if (verb === 'ttl' && (value === '5m' || value === '1h')) {
      await saveSettings($, s => ({ ...s, ttl: value, ttlSource: 'manual' }))

      return { text: `快取 TTL 設為 ${value}` }
    }

    if (verb === 'band' && (value === 'on' || value === 'off')) {
      await saveSettings($, s => ({ ...s, isBandShown: value === 'on' }))

      return { text: `提示框上方進度條：${value === 'on' ? '顯示' : '隱藏'}` }
    }

    if (verb === 'compact') {
      await compactNow($, 'manual')

      return { text: '已要求壓縮對話。' }
    }

    return { text: '用法：/cache [auto on|off] [ttl 5m|1h] [band on|off] [compact]' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settings)
    const hit = await read($, last)

    if (e.props.hasSurvey || !s.isBandShown || hit === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
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
            <Text color="error">快取已過期</Text>
          )}
          <Text dimColor>自動壓縮 {s.isAutoCompact ? '開' : '關'}</Text>
          <Button key="compact" label="立即壓縮" onPress={() => compactNow($, 'manual')} />
          <Button key="pane" label="面板" onPress={() => openPane($)} />
          <Button key="hide" label="隱藏" dimColor onPress={() => saveSettings($, x => ({ ...x, isBandShown: false }))} />
        </Box>
        <Text dimColor>
          上次讀寫 {ago(t - hit.at)} · 讀取 {tokens(hit.read)} · 寫入 {tokens(hit.write)}
          {remaining > 0 ? '' : ` · 下一則訊息會重新寫入約 ${tokens(contextOf(hit))} tokens`}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, settings)
    const hit = await read($, last)
    const st = await read($, stats)
    const state = await read($, alert)
    const t = await read($, now)
    const total = ttlMs(s.ttl)
    const remaining = hit === null ? 0 : hit.at + total - t
    const fraction = remaining / total
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - 4))
    const hitRate = st.requests === 0 ? '—' : `${Math.round((st.hits / st.requests) * 100)}%`

    const headline =
      hit === null ? (
        <Text dimColor>{state === 'compacted' ? '已壓縮，下一則訊息會寫入新的快取' : '還沒有快取，送出第一則訊息後開始計時'}</Text>
      ) : remaining > 0 ? (
        <Box flexDirection="column">
          <Text bold color={tone(fraction)}>
            剩餘 {clock(remaining)} / {clock(total)}
          </Text>
          <Text color={tone(fraction)}>{bar(fraction, width)}</Text>
        </Box>
      ) : (
        <Text bold color="error">
          快取已過期
        </Text>
      )

    return (
      <Box flexDirection="column" gap={1}>
        {headline}

        {hit !== null && (
          <Box flexDirection="column">
            <Text>上次讀寫：{ago(t - hit.at)}</Text>
            <Text>
              這次讀取 {tokens(hit.read)} · 寫入 {tokens(hit.write)} · 未快取 {tokens(hit.uncached)}
            </Text>
            <Text dimColor>過期後重新寫入約 {tokens(contextOf(hit))} tokens</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>本 session</Text>
          <Text>
            命中率 {hitRate}（{st.hits}/{st.requests} 次請求）· 過期 {st.expiries} 次 · 壓縮 {st.compactions} 次
          </Text>
          {st.history.length > 0 && <Text dimColor>每次請求的快取比例：{spark(st.history)}</Text>}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text bold>設定</Text>
          <Box flexDirection="row" gap={1}>
            <Text>TTL（{SOURCE_LABEL[s.ttlSource]}）</Text>
            <Button key="ttl-5m" label="5m" variant={s.ttl === '5m' ? 'primary' : 'secondary'} onPress={() => saveSettings($, x => ({ ...x, ttl: '5m', ttlSource: 'manual' }))} />
            <Button key="ttl-1h" label="1h" variant={s.ttl === '1h' ? 'primary' : 'secondary'} onPress={() => saveSettings($, x => ({ ...x, ttl: '1h', ttlSource: 'manual' }))} />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text>到期前自動壓縮</Text>
            <Button
              key="auto"
              label={s.isAutoCompact ? '開' : '關'}
              variant={s.isAutoCompact ? 'primary' : 'secondary'}
              onPress={() => saveSettings($, x => ({ ...x, isAutoCompact: !x.isAutoCompact }))}
            />
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text>提前</Text>
            {[60, 120, 300].map(sec => (
              <Button
                key={`lead-${sec}`}
                label={`${sec / 60} 分`}
                variant={s.leadSeconds === sec ? 'primary' : 'secondary'}
                onPress={() => saveSettings($, x => ({ ...x, leadSeconds: sec }))}
              />
            ))}
          </Box>
          <Text dimColor>
            實際在剩 {Math.round(leadMs(s) / 1000)} 秒時壓縮（5m TTL 最多提前 1 分鐘）；上下文不到 {tokens(MIN_COMPACT_TOKENS)} tokens 時不自動壓縮。
          </Text>
          <Box flexDirection="row" gap={1}>
            <Text>提示框上方進度條</Text>
            <Button
              key="band"
              label={s.isBandShown ? '顯示' : '隱藏'}
              variant={s.isBandShown ? 'primary' : 'secondary'}
              onPress={() => saveSettings($, x => ({ ...x, isBandShown: !x.isBandShown }))}
            />
          </Box>
        </Box>

        <Button key="compact-now" label="立即壓縮對話" onPress={() => compactNow($, 'manual')} />
      </Box>
    )
  })
}
