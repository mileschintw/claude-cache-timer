import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const MIN = 60_000

type World = {
  toasts: string[]
  compactions: number
  clock: ReturnType<typeof mock.clock>
  usage: { read: number; write: number }
}

function world(on: On, settings?: Record<string, unknown>): World {
  const w: World = {
    toasts: [],
    compactions: 0,
    clock: mock.clock(on, { now: 1_000_000 }),
    usage: { read: 150_000, write: 2_000 },
  }
  mock.store(on, settings ? { settings } : {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
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
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.compact', () => {
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

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
}

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of stream) {
    // drain
  }

  return stream.result
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
    expect(await ui.find({ type: 'Text', text: /59:59 \/ 60:00/ })).toBeDefined()
  }
})

test('warns 5 minutes before expiry, then says it expired', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)

  await w.clock.advance(55 * MIN + 1000)
  expect(w.toasts.some(t => t.includes('快取剩'))).toBe(true)

  await w.clock.advance(5 * MIN)
  expect(w.toasts.some(t => t.includes('快取已過期'))).toBe(true)
  expect(w.compactions).toBe(0)
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
  expect(w.toasts.some(t => t.includes('快取已過期'))).toBe(false)
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
  expect(w.toasts.some(t => t.includes('快取已過期'))).toBe(false)
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
  expect(await ui.find({ type: 'Text', text: /TTL（自動偵測）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/ 60:00/ })).toBeDefined()
})

test('a write with no read after a 10 minute gap proves a 5m TTL', async ($, on) => {
  const w = world(on)
  await start($)
  await step($)
  await w.clock.advance(10 * MIN)
  w.usage = { read: 0, write: 150_000 }
  await step($)

  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /TTL（自動偵測）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/ 05:00/ })).toBeDefined()
})
