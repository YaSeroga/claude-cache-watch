import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-watch',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const HOUR_MS = 3_600_000
const WINDOW = 1_000_000

const measure = (tokens: number) => ({
  context: { tokens, window: WINDOW },
  rateLimits: [],
  changed: ['context' as const],
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the card follows the cache timer and the context size on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    on('session.measure', (_, e) => ({ changed: e.changed }))
    // Stands for what the engine draws when the mod passes.
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>engine</Text>
    })

    // A small, warm context: the mod draws nothing.
    await $.session.measure(measure(100_000))
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /cache|Context/ })).toBe(undefined)
    await ui.unmount()

    // One hour without a request: the cache is gone.
    await clock.advance(HOUR_MS + 1)
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /expired/ }))?.text).toBe(
      'Prompt cache expired',
    )
    await ui.unmount()

    // While a turn runs, the requests keep the cache warm: no cold card.
    ui = await $.ui.mount({
      ...BAND,
      surface,
      props: { ...BAND.props, isWorking: true },
    })
    expect(await ui.find({ type: 'Text', text: /expired/ })).toBe(undefined)
    await ui.unmount()

    // The next response warms the cache again and passes the info limit.
    await $.session.measure(measure(512_000))
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe(
      'Context: 512k tokens',
    )
    expect(await ui.find({ type: 'Text', text: /expired/ })).toBe(undefined)
    await ui.unmount()

    await $.session.measure(measure(712_000))
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe(
      'Context: 712k tokens. A new session is recommended.',
    )

    // Hide holds while the state stays the same.
    await $.ui.press({ plugin: 'cache-watch', key: 'hide' })
    await ui.unmount()
    await $.session.measure(measure(730_000))
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Context/ })).toBe(undefined)
    await ui.unmount()

    // The card comes back after 100k more tokens.
    await $.session.measure(measure(801_000))
    ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe(
      'Context: 801k tokens. A new session is recommended.',
    )
    await $.ui.press({ plugin: 'cache-watch', key: 'hide' })
    await ui.unmount()

    // It also comes back when the cache expires.
    await clock.advance(HOUR_MS + 1)
    ui = await $.ui.mount({ ...BAND, surface })
    expect(
      (await ui.find({ type: 'Text', text: /cache expired/ }))?.text,
    ).toBe('Prompt cache expired: the next message is at the full price.')
    await ui.unmount()
  })
}

test('the handover goes to the prompt box, or to a field in the card', async ($, on) => {
  mock.clock(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const filled: string[] = []
  const sent: string[] = []
  let hasPromptBox = true
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: hasPromptBox }
  })
  on('prompt.submit', (_, e) => {
    sent.push(e.text)

    return { text: e.text }
  })

  await $.session.measure(measure(600_000))
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.ui.press({ plugin: 'cache-watch', key: 'handover' })
  expect(filled.length).toBe(1)
  expect(sent.length).toBe(0)
  await ui.unmount()

  // A surface that draws its own prompt box refuses the fill.
  hasPromptBox = false
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.ui.press({ plugin: 'cache-watch', key: 'handover' })
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.ui.input({
    plugin: 'cache-watch',
    key: 'handover-text',
    text: 'my edited handover prompt',
  })
  expect(sent).toEqual(['my edited handover prompt'])
  await ui.unmount()
})

test('the first start shows the setup card, and Done closes it for good', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const saved: Record<string, unknown> = {}
  on('config.set', (_, e) => {
    saved[e.key] = e.value

    return { value: e.value }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const start = { cwd: '/', surface: 'desktop', isInteractive: true } as const
  await $.session.start(start)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /setup/ }))?.text).toBe(
    'cache-watch setup',
  )

  await $.ui.press({ plugin: 'cache-watch', key: 'ttl-5' })
  await $.ui.press({ plugin: 'cache-watch', key: 'limits-300k' })
  expect(saved).toEqual({
    'cache-watch.cacheTtlMinutes': 5,
    'cache-watch.contextLimits': '300k/500k',
  })

  await $.ui.press({ plugin: 'cache-watch', key: 'setup-done' })
  await ui.unmount()

  // The next start reads the stored answer: no setup card.
  await $.session.start(start)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /setup/ })).toBe(undefined)
  await ui.unmount()
})

test(
  'the chosen settings move the cache timer and the limits',
  { options: { cacheTtlMinutes: 5, contextLimits: '300k/500k' } },
  async ($, on) => {
    const clock = mock.clock(on)
    on('session.measure', (_, e) => ({ changed: e.changed }))

    await $.session.measure(measure(350_000))
    let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /Context/ }))?.text).toBe(
      'Context: 350k tokens',
    )
    expect(await ui.find({ type: 'Text', text: /expired/ })).toBe(undefined)
    await ui.unmount()

    const fiveMinutesMs = 300_000
    await clock.advance(fiveMinutesMs + 1)
    ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /expired/ })).not.toBe(undefined)
    await ui.unmount()
  },
)

test('the demo command shows every card at once and closes again', async ($, on) => {
  mock.clock(on)
  mock.store(on, { isSetupDone: true })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({
    command: 'cache-watch-demo',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    for (const words of [/^Prompt cache expired$/, /512k/, /712k/]) {
      expect(await ui.find({ type: 'Text', text: words })).not.toBe(undefined)
    }

    await ui.unmount()
  }

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.ui.press({ plugin: 'cache-watch', key: 'close-demo' })
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /demo/ })).toBe(undefined)
  await ui.unmount()
})
