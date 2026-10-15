import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const MIN = 60_000

type World = {
  toasts: string[]
  /** Each `$.ui.status` text, in order; undefined clears the line. */
  statuses: (string | undefined)[]
  compactions: number
  clock: ReturnType<typeof mock.clock>
  usage: { read: number; write: number }
  /** Writes of the `now` atom, each of which redraws the band and pane. */
  nowWrites: number
  /** How the next compaction ends: a skip reason, or an error it rejects with. */
  compactEnds?: string | Error
  /** When set, a compaction waits for it before it ends. */
  compactGate?: Promise<void>
  /** The mod's `$.store`, kept across a simulated restart. */
  store: Record<string, unknown>
  /** Each `$.ui.open` argument, in order. */
  opens: unknown[]
  /** Each closed pane id, in order. */
  closes: string[]
  /** The open panes, each with the title of its latest open. */
  panes: Map<string, { id: string; title?: string }>
}

function world(on: On, settings?: Record<string, unknown>, store: Record<string, unknown> = {}): World {
  const w: World = {
    toasts: [],
    statuses: [],
    compactions: 0,
    clock: mock.clock(on, { now: 1_000_000 }),
    usage: { read: 150_000, write: 2_000 },
    nowWrites: 0,
    store: { ...store, settings: settings ?? { isBandShown: true } },
    opens: [],
    closes: [],
    panes: new Map(),
  }
  on('store.get', (_$, e) => ({ value: w.store[e.key] }))
  on('store.set', (_$, e) => {
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete w.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('state.set', (_$, e, next) => {
    if (e.plugin === 'cache-timer' && e.key === 'now') w.nowWrites += 1

    return next(e)
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  // The engine's own band, standing in for an empty one.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, { key: 'engine' }, '') as RenderElement
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    w.opens.push(e)
    w.panes.set(e.id, e)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    w.closes.push(e.id)
    w.panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...w.panes.values()].map(o => ({
      id: o.id,
      title: o.title ?? o.id,
      isShown: true,
      isFocused: false,
      isPlaced: true,
    })),
  }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.compact', async () => {
    await w.compactGate
    if (w.compactEnds instanceof Error) throw w.compactEnds
    if (w.compactEnds !== undefined) return { skip: w.compactEnds }
    w.compactions += 1

    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] as never }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: w.usage.read,
        cache_creation_input_tokens: w.usage.write,
      },
    }
  })

  return w
}

async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive } as never)
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // drain
  }

  return stream.result
}

async function cache($: Engine, args: string) {
  return $.command.run({ command: 'cache', args } as never)
}

async function pane($: Engine) {
  return $.ui.mount({
    plugin: 'cache-timer',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'cache-timer',
    props: { bodyColumns: 60 } as never,
  })
}

const band = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'cache-timer',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
  })

/** The band's countdown reads `head`, with a block bar in the terminal and an SVG bar on desktop. */
async function expectCountdown(ui: Awaited<ReturnType<typeof band>>, surface: 'terminal' | 'desktop', head: RegExp) {
  expect(await ui.find({ type: 'Text', text: head })).toBeDefined()
  if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /^[█░]+$/ })).toBeDefined()
  else expect(await ui.find({ type: 'Svg' })).toBeDefined()
}

test('band counts down from the TTL after a cache hit', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(1000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cache-timer',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
    })
    await expectCountdown(ui, surface, /^60 min$/)
  }
})

test('band and pane show minutes until 5 minutes are left, then mm:ss alone', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(32 * MIN + 30_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /28 min/ })).toBeDefined()
  }
  const p = await pane($)
  expect(await p.find({ type: 'Text', text: /^28 min left$/ })).toBeDefined()

  await w.clock.advance(22 * MIN + 31_000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    await expectCountdown(ui, surface, /^04:59$/)
  }
  expect(await p.find({ type: 'Text', text: /^04:59 left$/ })).toBeDefined()
})

test('/cache seconds and the pane button switch to mm:ss the whole time', async ($, on) => {
  world(on)
  await start($)
  await step($)
  const p = await pane($)
  expect(await p.find({ type: 'Text', text: /^60 min left$/ })).toBeDefined()

  expect((await cache($, 'seconds on')).text).toBe('Always show seconds: on')
  expect(await p.find({ type: 'Text', text: /^60:00 left$/ })).toBeDefined()

  await p.press({ key: 'seconds-false' })
  expect(await p.find({ type: 'Text', text: /^60 min left$/ })).toBeDefined()

  expect((await cache($, 'lang zh-TW')).text).toBe('介面語言已設為繁體中文')
  expect((await cache($, 'seconds on')).text).toBe('永遠顯示秒數：開')
})

test('always-show-seconds saved in an earlier session still applies', async ($, on) => {
  world(on, { ttl: '1h', isAutoCompact: false, leadSeconds: 120, isBandShown: true, isSecondsShown: true, ttlSource: 'manual', lang: 'en' }, { configLang: 'en' })
  await start($)
  await step($)

  expect(await (await pane($)).find({ type: 'Text', text: /^60:00 left$/ })).toBeDefined()
})

test('warns 5 minutes before expiry, then says it expired', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  await w.clock.advance(55 * MIN + 1000)
  expect(w.toasts.some(t => t.includes('Cache has 05:00 left'))).toBe(true)

  await w.clock.advance(5 * MIN)
  expect(w.toasts.some(t => t.includes('Cache expired'))).toBe(true)
  expect(w.compactions).toBe(0)
})

test('the status line follows the countdown, says when it expired, and clears after a compaction', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock.advance(5000)
  expect(w.statuses).toHaveLength(0)

  await step($)
  await w.clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('████████ 60 min left')

  await w.clock.advance(MIN)
  expect(w.statuses.at(-1)).toBe('████████ 59 min left')

  await w.clock.advance(60 * MIN)
  expect(w.statuses.at(-1)).toBe('expired')

  const count = w.statuses.length
  await w.clock.advance(5000)
  expect(w.statuses).toHaveLength(count)

  await step($)
  await (await band($, 'terminal')).press({ key: 'compact' })
  await w.clock.advance(1000)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('the status line is in Traditional Chinese with lang zh-TW', { options: { lang: 'zh-TW' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(1000)

  expect(w.statuses.at(-1)).toBe('████████ 剩 60 分鐘')
})

test('by default the status line shows the countdown and the band is on', async ($, on) => {
  const w = world(on, {})
  await start($)
  await step($)
  await w.clock.advance(1000)

  expect(w.statuses.at(-1)).toBe('████████ 60 min left')
  expect(await (await band($, 'terminal')).find({ key: 'compact' })).toBeDefined()

  await (await pane($)).press({ key: 'band-false' })
  expect(await (await band($, 'terminal')).find({ key: 'compact' })).toBeUndefined()
})

test('a band turned off stays off after a restart', async ($, on) => {
  world(on, { isBandShown: false })
  await start($)
  await step($)

  expect(await (await band($, 'terminal')).find({ key: 'compact' })).toBeUndefined()
})

test('the status line switches between off, time and bar from /cache and the pane', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('████████ 60 min left')

  expect((await cache($, 'status off')).text).toBe('Status line: off')
  await w.clock.advance(1000)
  expect(w.statuses.at(-1)).toBeUndefined()

  const count = w.statuses.length
  await w.clock.advance(MIN)
  expect(w.statuses).toHaveLength(count)

  expect((await cache($, 'status time')).text).toBe('Status line: time')
  await w.clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('59 min left')

  await (await pane($)).press({ key: 'status-bar' })
  await w.clock.advance(1000)
  expect(w.statuses.at(-1)).toBe('████████ 59 min left')

  await cache($, 'status off')
  expect((await cache($, 'status on')).text).toBe('Status line: bar + time')
})

test('the status line stays off after a restart', async ($, on) => {
  const w = world(on, { status: 'off' })
  await start($)
  await step($)
  await w.clock.advance(MIN)

  expect(w.statuses.every(t => t === undefined)).toBe(true)
})

test('a status line turned off before it had three modes stays off', async ($, on) => {
  const w = world(on, { isStatusShown: false })
  await start($)
  await step($)
  await w.clock.advance(MIN)

  expect(w.statuses.every(t => t === undefined)).toBe(true)
  expect(w.store.settings).toMatchObject({ status: 'off' })
  expect(w.store.settings).not.toHaveProperty('isStatusShown')
})

test('no redraws before the first hit or after a compaction', async ($, on) => {
  const w = world(on)
  await start($)

  await w.clock.advance(5000)
  expect(w.nowWrites).toBe(0)

  await step($)
  w.nowWrites = 0
  await w.clock.advance(MIN)
  expect(w.nowWrites).toBe(1)

  await (await band($, 'terminal')).press({ key: 'compact' })
  expect(w.compactions).toBe(1)
  w.nowWrites = 0
  await w.clock.advance(5000)
  expect(w.nowWrites).toBe(0)
})

test('after expiry the timer redraws once a minute, then resumes on the next hit', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  await w.clock.advance(60 * MIN)
  expect(w.toasts.filter(t => t.includes('Cache expired'))).toHaveLength(1)

  w.nowWrites = 0
  await w.clock.advance(59_000)
  expect(w.nowWrites).toBe(0)

  await w.clock.advance(1000)
  expect(w.nowWrites).toBe(1)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /Last read\/write: 61 min ago/ })).toBeDefined()

  await w.clock.advance(5 * MIN)
  expect(w.nowWrites).toBe(6)
  expect(w.toasts.filter(t => t.includes('Cache expired'))).toHaveLength(1)

  await step($)
  w.nowWrites = 0
  await w.clock.advance(MIN)
  expect(w.nowWrites).toBe(1)

  await w.clock.advance(60 * MIN)
  expect(w.toasts.filter(t => t.includes('Cache expired'))).toHaveLength(2)
})

test('while minutes are shown the timer redraws once a minute, then every second', { timeoutMs: 20_000 }, async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  w.nowWrites = 0
  await w.clock.advance(59_000)
  expect(w.nowWrites).toBe(0)
  await w.clock.advance(1000)
  expect(w.nowWrites).toBe(1)
  await w.clock.advance(2 * MIN)
  expect(w.nowWrites).toBe(3)

  await w.clock.advance(52 * MIN)
  w.nowWrites = 0
  await w.clock.advance(10_000)
  expect(w.nowWrites).toBe(10)
})

test('with seconds on the timer redraws every second', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await cache($, 'seconds on')

  w.nowWrites = 0
  await w.clock.advance(10_000)
  expect(w.nowWrites).toBe(10)
})

test('auto-compact fires once, before expiry, when switched on', async ($, on) => {
  const w = world(on, { ttl: '1h', isAutoCompact: true, leadSeconds: 120, isBandShown: true })
  await start($)
  await step($)

  await w.clock.advance(57 * MIN)
  expect(w.compactions).toBe(0)

  await w.clock.advance(1 * MIN + 1000)
  expect(w.compactions).toBe(1)

  await w.clock.advance(5 * MIN)
  expect(w.compactions).toBe(1)
  expect(w.toasts.some(t => t.includes('Cache expired'))).toBe(false)
})

test('the band compact button compacts and clears the timer', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cache-timer',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never,
    })
    if (surface === 'terminal') {
      await ui.press({ key: 'compact' })
      expect(w.compactions).toBe(1)
    }
    expect(await ui.find({ key: 'compact' })).toBeUndefined()
  }

  await w.clock.advance(61 * MIN)
  expect(w.toasts.some(t => t.includes('Cache expired'))).toBe(false)
})

test('a 5m cache never auto-compacts within 4 minutes, whatever the lead', async ($, on) => {
  const w = world(on, { ttl: '5m', isAutoCompact: true, leadSeconds: 300, isBandShown: true, ttlSource: 'manual' })
  await start($)
  await step($)

  await w.clock.advance(3 * MIN + 55_000)
  expect(w.compactions).toBe(0)

  await w.clock.advance(10_000)
  expect(w.compactions).toBe(1)
})

test('a read after a 10 minute gap proves a 1h TTL', async ($, on) => {
  const w = world(on, { ttl: '5m', isAutoCompact: false, leadSeconds: 120, isBandShown: true, ttlSource: 'default' })
  await start($)
  await step($)
  await w.clock.advance(10 * MIN)
  await step($)

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /TTL \(detected\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^60 min left$/ })).toBeDefined()
})

test('a write with no read after a 10 minute gap proves a 5m TTL', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(10 * MIN)
  w.usage = { read: 0, write: 150_000 }
  await step($)

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /TTL \(detected\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^05:00 left$/ })).toBeDefined()
})


test('the UI is English by default', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /auto-compact off/ })).toBeDefined()
  }
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /^Settings$/ })).toBeDefined()
  expect(w.toasts).toEqual([])
})

test('lang zh-TW in userConfig draws in Traditional Chinese', { options: { lang: 'zh-TW' } }, async ($, on) => {
  world(on)
  await start($)
  await step($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /自動壓縮 關/ })).toBeDefined()
  }
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /TTL（預設）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^剩餘 60 分鐘$/ })).toBeDefined()
})

test('lang zh-TW in userConfig reminds in Traditional Chinese', { options: { lang: 'zh-TW' } }, async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  await w.clock.advance(55 * MIN + 1000)
  expect(w.toasts.some(t => t.includes('快取剩'))).toBe(true)
  await w.clock.advance(5 * MIN)
  expect(w.toasts.some(t => t.includes('快取已過期'))).toBe(true)
})

test('a language picked earlier stands while userConfig is unchanged', async ($, on) => {
  world(on, { ttl: '1h', isAutoCompact: false, leadSeconds: 120, isBandShown: true, ttlSource: 'manual', lang: 'zh-TW' }, { configLang: 'en' })
  await start($)

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /TTL（手動設定）/ })).toBeDefined()
})

test('a userConfig change replaces the language picked earlier', { options: { lang: 'en' } }, async ($, on) => {
  world(on, { ttl: '1h', isAutoCompact: false, leadSeconds: 120, isBandShown: true, ttlSource: 'manual', lang: 'zh-TW' }, { configLang: 'zh-TW' })
  await start($)

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /TTL \(set by you\)/ })).toBeDefined()
})

test('the pane language buttons switch the UI', async ($, on) => {
  world(on)
  await start($)

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /^Language$/ })).toBeDefined()
  await ui.press({ key: 'lang-zh-TW' })
  expect(await ui.find({ type: 'Text', text: /^語言$/ })).toBeDefined()
  await ui.press({ key: 'lang-en' })
  expect(await ui.find({ type: 'Text', text: /^Language$/ })).toBeDefined()
})

test('a language switch retitles the open pane', async ($, on) => {
  const w = world(on)
  await start($)
  await cache($, '')
  expect(w.opens).toEqual([expect.objectContaining({ id: 'cache-timer', title: 'Prompt cache' })])

  const ui = await pane($)
  await ui.press({ key: 'lang-zh-TW' })
  expect(w.opens.at(-1)).toEqual({ id: 'cache-timer', title: 'Prompt 快取' })
  await cache($, 'lang en')
  expect(w.opens.at(-1)).toEqual({ id: 'cache-timer', title: 'Prompt cache' })
  expect(w.opens).toHaveLength(3)
})

test('a language switch leaves a closed pane closed', async ($, on) => {
  const w = world(on)
  await start($)
  await cache($, 'lang zh-TW')
  expect(w.opens).toEqual([])
})

test('/cache lang switches the language and later replies follow it', async ($, on) => {
  world(on)
  await start($)

  expect((await cache($, 'auto on')).text).toBe('Auto-compact before expiry: from 100k tokens')
  expect((await cache($, 'auto 200k')).text).toBe('Auto-compact before expiry: from 200k tokens')
  expect((await cache($, 'auto 30k')).text).toContain('Usage: /cache')
  expect((await cache($, 'lang zh-TW')).text).toBe('介面語言已設為繁體中文')
  expect((await cache($, 'auto on')).text).toBe('到期前自動壓縮：200k tokens 起')
  expect((await cache($, 'auto off')).text).toBe('到期前自動壓縮：關')
  expect((await cache($, 'lang fr')).text).toContain('用法：')
  expect((await cache($, 'lang en')).text).toBe('Language set to English')
  expect((await cache($, 'nope')).text).toContain('Usage: /cache')
})

test('a press during a turn says to wait, and compacts once the turn ends', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await $.turn.start({ text: 'go', turnId: 't2' })
  w.compactEnds = new Error('A turn is running')

  await (await band($, 'terminal')).press({ key: 'compact' })
  expect(w.compactions).toBe(0)
  expect(w.toasts).toContain('Claude is replying; compact once this turn ends')

  await $.turn.complete({ turnId: 't2', reason: 'answer', answer: 'done', durationMs: 1, isAborted: false } as never)
  w.compactEnds = undefined
  await (await pane($)).press({ key: 'compact-now' })
  expect(w.compactions).toBe(1)
})

test('a compaction that fails while idle shows why, not that Claude is replying', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  // A test hook that throws is skipped, and the call then rejects with the kit's own error.
  w.compactEnds = new Error('not allowed from here')

  await (await band($, 'terminal')).press({ key: 'compact' })
  expect(w.compactions).toBe(0)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^Compaction failed: .+/)
})

test('a vetoed compaction says why', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  w.compactEnds = 'a hook said no'

  await (await pane($)).press({ key: 'compact-now' })
  expect(w.compactions).toBe(0)
  expect(w.toasts).toEqual(['Compaction skipped: a hook said no'])
})

test('a failed auto-compact stays quiet', async ($, on) => {
  const w = world(on, { ttl: '1h', isAutoCompact: true, leadSeconds: 120, isBandShown: true, ttlSource: 'manual' })
  await start($)
  await step($)
  w.compactEnds = new Error('not allowed from here')

  await w.clock.advance(58 * MIN + 1000)
  expect(w.compactions).toBe(0)
  expect(w.toasts.some(t => t.includes('Compaction failed') || t.includes('Claude is replying'))).toBe(false)
})

test('a vetoed auto-compact says why', async ($, on) => {
  const w = world(on, { ttl: '1h', isAutoCompact: true, leadSeconds: 120, isBandShown: true, ttlSource: 'manual' })
  await start($)
  await step($)
  w.compactEnds = 'a hook said no'

  await w.clock.advance(58 * MIN + 1000)
  expect(w.compactions).toBe(0)
  expect(w.toasts).toContain('Compaction skipped: a hook said no')
})

test('in a headless session the Compact buttons run /compact, one at a time', async ($, on) => {
  const w = world(on)
  const runs: string[] = []
  on('command.run', { command: 'compact' }, (_$, e) => {
    runs.push(e.command)

    return { text: 'Compacted' }
  })
  await start($, false)
  await step($)

  await (await band($, 'desktop')).press({ key: 'compact' })
  // `/compact` hasn't reported back: the button says it is compacting, and a press does nothing.
  expect(await (await band($, 'desktop')).find({ type: 'Button', label: 'Compacting…' } as never)).toBeDefined()
  const p = await pane($)
  await p.press({ key: 'compact-now' })
  expect(runs).toEqual(['compact'])

  // Nothing ended it: after two minutes the buttons work again.
  await w.clock.advance(2 * MIN + 1000)
  await p.press({ key: 'compact-now' })
  expect(runs).toEqual(['compact', 'compact'])
  expect(w.toasts).toEqual([])
})

test('in a headless session a /compact that is refused says why', async ($, on) => {
  const w = world(on)
  on('command.run', { command: 'compact' }, () => {
    throw new Error('no')
  })
  await start($, false)
  await step($)

  await (await band($, 'desktop')).press({ key: 'compact' })
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^Compaction failed: .+/)
})

test('in a headless session auto-compact runs /compact once, at the lead', async ($, on) => {
  const w = world(on, { ttl: '1h', isAutoCompact: true, leadSeconds: 120, isBandShown: true, ttlSource: 'manual' })
  const runs: string[] = []
  on('command.run', { command: 'compact' }, (_$, e) => {
    runs.push(e.command)

    return { text: 'Compacted' }
  })
  await start($, false)
  await step($)

  await w.clock.advance(57 * MIN)
  expect(runs).toEqual([])

  await w.clock.advance(1 * MIN + 1000)
  expect(runs).toEqual(['compact'])

  await w.clock.advance(1 * MIN)
  expect(runs).toEqual(['compact'])
  expect(w.compactions).toBe(0)
  // /compact reports itself in the transcript, so no toast says it compacted.
  expect(w.toasts.some(t => t.includes('compacted'))).toBe(false)
})

/** A promise and the function that resolves it. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })

  return { opened, open }
}

/** Lets pending work run until `isDone` holds; throws if it never does. */
async function until(isDone: () => boolean) {
  for (let i = 0; i < 1000 && !isDone(); i++) await Promise.resolve()
  if (!isDone()) throw new Error('never done')
}

test('a Compact press returns before a slow /compact ends', async ($, on) => {
  const w = world(on)
  const g = gate()
  const runs: string[] = []
  on('command.run', { command: 'compact' }, async (_$, e) => {
    await g.opened
    runs.push(e.command)

    return { text: 'Compacted' }
  })
  await start($, false)
  await step($)

  await (await band($, 'desktop')).press({ key: 'compact' })
  expect(runs).toEqual([])

  g.open()
  await until(() => runs.length === 1)
  expect(w.toasts).toEqual([])
})

test('a Compact press returns before a slow compaction ends, and still reports how it went', async ($, on) => {
  const w = world(on)
  const g = gate()
  await start($)
  await step($)
  w.compactEnds = 'a hook said no'
  w.compactGate = g.opened

  await (await pane($)).press({ key: 'compact-now' })
  expect(w.toasts).toEqual([])

  g.open()
  await until(() => w.toasts.length === 1)
  expect(w.toasts).toEqual(['Compaction skipped: a hook said no'])
})

/** What the mod keeps for session `sess-1` after one hit at `at`, as a restart finds it. */
const savedSession = (at: number) => ({
  'session:sess-1': {
    last: { at, read: 150_000, write: 2_000, uncached: 500 },
    savedAt: at,
  },
})

test('a turn saves the session last hit to the store', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  expect(w.store['session:sess-1']).toEqual(savedSession(1_000_000)['session:sess-1'])
})

test('after a restart the band and pane show the saved hit right away', async ($, on) => {
  const w = world(on, undefined, savedSession(1_000_000 - 10 * MIN))
  await start($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    await expectCountdown(ui, surface, /^50 min$/)
  }
  const p = await pane($)
  expect(await p.find({ type: 'Text', text: /^50 min left$/ })).toBeDefined()
  expect(await p.find({ type: 'Text', text: /read 150k · wrote 2k/ })).toBeDefined()
  expect(w.toasts).toHaveLength(0)
})

test('after a restart the status line shows the saved hit right away', async ($, on) => {
  const w = world(on, undefined, savedSession(1_000_000 - 10 * MIN))
  await start($)

  expect(w.statuses.at(-1)).toBe('███████░ 50 min left')
})

test('an unchanged status line is set again every 15 seconds, in case the first came too early', async ($, on) => {
  const w = world(on, undefined, savedSession(1_000_000 - 70 * MIN))
  await start($)
  expect(w.statuses).toEqual(['expired'])

  await w.clock.advance(14_000)
  expect(w.statuses).toEqual(['expired'])

  await w.clock.advance(1000)
  expect(w.statuses).toEqual(['expired', 'expired'])
})

test('a redraw of the prompt area sets the status line again within a few seconds', async ($, on) => {
  const w = world(on, {}, savedSession(1_000_000 - 70 * MIN))
  await start($)
  await w.clock.advance(5000)
  expect(w.statuses).toEqual(['expired'])

  await band($, 'desktop')
  await w.clock.advance(1000)
  expect(w.statuses).toEqual(['expired', 'expired'])

  await band($, 'desktop')
  await w.clock.advance(1000)
  expect(w.statuses).toHaveLength(2)

  await w.clock.advance(2000)
  expect(w.statuses).toHaveLength(3)
})

test('a hit that expired while the app was closed shows as expired, with no toast', async ($, on) => {
  const w = world(on, undefined, savedSession(1_000_000 - 70 * MIN))
  await start($)
  await w.clock.advance(5000)

  expect(await (await band($, 'desktop')).find({ type: 'Text', text: /^Cache expired$/ })).toBeDefined()
  expect(w.toasts).toHaveLength(0)
})

test('a restart after a compaction finds no hit to time', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await (await band($, 'terminal')).press({ key: 'compact' })

  expect((w.store['session:sess-1'] as { last: unknown }).last).toBeNull()
})

test('the store keeps only the 20 most recently saved sessions', async ($, on) => {
  const old = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`session:old-${i}`, { last: null, savedAt: i }]),
  )
  const w = world(on, undefined, { ...old, other: 1 })
  await start($)

  const kept = Object.keys(w.store).filter(k => k.startsWith('session:'))
  expect(kept).toHaveLength(20)
  expect(kept).not.toContain('session:old-4')
  expect(kept).toContain('session:old-5')
  expect(w.store.other).toBe(1)
})

const resume = ($: Engine, source: 'resume' | 'fork' | 'startup' = 'resume') =>
  $.classic.SessionStart({ source, seconds_since_last_response: 600, context_tokens: 120_000 } as never)

test('a session saved before this version is estimated from the resume', async ($, on) => {
  world(on)
  await start($)
  await resume($)

  const ui = await band($, 'desktop')
  await expectCountdown(ui, 'desktop', /^50 min$/)
  const p = await pane($)
  expect(await p.find({ type: 'Text', text: /^50 min left$/ })).toBeDefined()
  expect(await p.find({ type: 'Text', text: /Restored after a restart: about 120k tokens/ })).toBeDefined()
})

test('a saved hit wins over the estimate', async ($, on) => {
  world(on, undefined, savedSession(1_000_000 - 20 * MIN))
  await start($)
  await resume($)

  const p = await pane($)
  expect(await p.find({ type: 'Text', text: /^40 min left$/ })).toBeDefined()
  expect(await p.find({ type: 'Text', text: /read 150k · wrote 2k/ })).toBeDefined()
})

test('a fresh start estimates nothing', async ($, on) => {
  world(on)
  await start($)
  await resume($, 'startup')

  expect(await (await pane($)).find({ type: 'Text', text: /No cache yet/ })).toBeDefined()
})

test('/cache compact is gone: it prints the usage, and the native /compact does the job', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  const reply = (await cache($, 'compact')).text
  expect(reply).toContain('Usage: /cache')
  expect(reply).not.toContain('compact]')
  expect(w.compactions).toBe(0)
})

const bandAt = ($: Engine, surface: 'terminal' | 'desktop', bodyColumns: number) =>
  $.ui.mount({
    plugin: 'cache-timer',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns } as never,
  })

test('the band stays one row: parts drop as it narrows, and Compact always stays', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(1000)

  const wide = await bandAt($, 'terminal', 100)
  expect(await wide.find({ type: 'Text', text: /^[█░]{10}$/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /auto-compact off/ })).toBeDefined()
  await wide.unmount()

  const narrow = await bandAt($, 'terminal', 40)
  expect(await narrow.find({ type: 'Text', text: /auto-compact/ })).toBeUndefined()
  expect(await narrow.find({ key: 'pane' })).toBeDefined()
  await narrow.unmount()

  const narrower = await bandAt($, 'terminal', 25)
  expect(await narrower.find({ key: 'pane' })).toBeUndefined()
  await narrower.unmount()

  const tiny = await bandAt($, 'terminal', 10)
  expect(await tiny.find({ type: 'Text', text: /^[█░]+$/ })).toBeUndefined()
  expect(await tiny.find({ key: 'compact' })).toBeDefined()
  expect(await tiny.find({ type: 'Text', text: /^60 min$/ })).toBeDefined()
})

test('Compact reads Compacting… until the compaction ends, then the band says it compacted', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  let open!: () => void
  w.compactGate = new Promise(resolve => (open = resolve))

  await (await band($, 'desktop')).press({ key: 'compact' })
  await w.clock.advance(10)
  expect(await (await band($, 'desktop')).find({ type: 'Button', label: 'Compacting…' } as never)).toBeDefined()
  expect(await (await pane($)).find({ type: 'Button', label: 'Compacting…' } as never)).toBeDefined()

  open()
  await w.clock.advance(10)
  const after = await band($, 'desktop')
  expect(await after.find({ type: 'Text', text: /^Compacted; the next message writes a fresh cache$/ })).toBeDefined()
  expect(await after.find({ key: 'compact' })).toBeUndefined()
})

test('in a headless session Compact works again once /compact is skipped or refused', async ($, on) => {
  const w = world(on)
  let isRefused = false
  on('command.run', { command: 'compact' }, async $$ => {
    if (isRefused) throw new Error('no')
    w.compactEnds = 'too small'
    await $$.session.compact({ trigger: 'manual' } as never).catch(() => undefined)

    return { text: 'skipped' }
  })
  await start($, false)
  await step($)

  await (await band($, 'desktop')).press({ key: 'compact' })
  await w.clock.advance(10)
  expect(await (await band($, 'desktop')).find({ type: 'Button', label: 'Compact' } as never)).toBeDefined()

  isRefused = true
  await (await band($, 'desktop')).press({ key: 'compact' })
  await w.clock.advance(10)
  expect(await (await band($, 'desktop')).find({ type: 'Button', label: 'Compact' } as never)).toBeDefined()
})

test('an expired band says how much the next message re-writes', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(61 * MIN)

  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Cache expired$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /next message re-writes ~153k/ })).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeDefined()
})

test('the Pane button opens the pane and lights up, and a second press closes it', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(1000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ key: 'pane', variant: 'secondary' } as never)).toBeDefined()

    await ui.press({ key: 'pane' })
    expect(w.opens.at(-1)).toEqual(expect.objectContaining({ id: 'cache-timer', focus: true }))
    expect(await ui.find({ key: 'pane', variant: 'primary' } as never)).toBeDefined()

    await ui.press({ key: 'pane' })
    expect(w.closes.at(-1)).toBe('cache-timer')
    expect(w.panes.size).toBe(0)
    expect(await ui.find({ key: 'pane', variant: 'secondary' } as never)).toBeDefined()
  }
})

// The test engine can't raise a close by the person, so the `ui.close` hook is checked by hand.
test('the Pane button is lit while /cache has the pane open, and closes it', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  await cache($, '')
  const ui = await band($, 'desktop')
  expect(await ui.find({ key: 'pane', variant: 'primary' } as never)).toBeDefined()

  await ui.press({ key: 'pane' })
  expect(w.panes.has('cache-timer')).toBe(false)
  expect(await ui.find({ key: 'pane', variant: 'secondary' } as never)).toBeDefined()
})

test('a pane left open across a reload keeps the Pane button lit', async ($, on) => {
  const w = world(on)
  w.panes.set('cache-timer', { id: 'cache-timer', title: 'Prompt cache' })
  await start($)
  await step($)

  const ui = await band($, 'desktop')
  expect(await ui.find({ key: 'pane', variant: 'primary' } as never)).toBeDefined()
  await ui.press({ key: 'pane' })
  expect(w.closes).toEqual(['cache-timer'])
})

test('the pane marks the current value of every setting as primary', async ($, on) => {
  world(on)
  await start($)
  await step($)

  const p = await pane($)
  expect(await p.find({ key: 'ttl-1h', variant: 'primary' } as never)).toBeDefined()
  expect(await p.find({ key: 'ttl-5m', variant: 'secondary' } as never)).toBeDefined()
  expect(await p.find({ key: 'auto', value: 'off' } as never)).toBeDefined()
  expect(await p.find({ key: 'lead-120' } as never)).toBeUndefined()

  await p.select({ key: 'auto', value: '200000' })
  expect(await p.find({ key: 'auto', value: '200000' } as never)).toBeDefined()
  expect(await p.find({ key: 'lead-120', variant: 'primary' } as never)).toBeDefined()
  expect(await p.find({ type: 'Text', text: /under 200k tokens/ })).toBeDefined()
})
