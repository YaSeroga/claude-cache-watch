import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Reading } from '../types'

const MINUTE_MS = 60_000
const COLD_MIN_TOKENS = 50_000
const HIDE_STEP_TOKENS = 100_000
const METER_CELLS = 10
const RING_PIXELS = 44
const RING_RADIUS = 16
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
const RING_MIN_FILL = 0.03
const DEMO_COMMAND = 'cache-watch-demo'
const SETUP_COMMAND = 'cache-watch-setup'
const SETUP_DONE_KEY = 'isSetupDone'
const SETUP_COLOR = 'suggestion'
const SETUP_LABEL_CELLS = 15
const TOKENS_PER_K = 1000
const TTL_CHOICES = [
  { minutes: 5, label: '5 min' },
  { minutes: 60, label: '1 hour' },
] as const
const LIMIT_PRESETS = ['150k/180k', '300k/500k', '500k/700k'] as const

const HANDOVER_PROMPT =
  'Write a handover document for a new session: the goal, the decisions and their reasons, the current state, the open steps and the key files. Save it as a markdown file. Then propose a new session with that document as its brief.'

type Level = 'cold' | 'info' | 'warn'

type CardView = {
  level: Level
  tokens: number
  window: number
  isCacheCold: boolean
  keySuffix: string
  onHide: () => unknown
}

const TONES = {
  cold: { color: 'suggestion', from: '#38bdf8', to: '#6366f1' },
  info: { color: 'warning', from: '#fbbf24', to: '#f97316' },
  warn: { color: 'error', from: '#fb7185', to: '#dc2626' },
} as const

const DEMO_WINDOW = 1_000_000
const DEMO_SAMPLES = [
  { level: 'cold', tokens: 182_000, isCacheCold: true },
  { level: 'info', tokens: 512_000, isCacheCold: false },
  { level: 'warn', tokens: 712_000, isCacheCold: true },
] as const

const reading = atom({ plugin: 'cache-watch', key: 'reading' } as const, null)
const isCold = atom({ plugin: 'cache-watch', key: 'isCold' } as const, false)
const dismissed = atom({ plugin: 'cache-watch', key: 'dismissed' } as const, '')
const isEditing = atom(
  { plugin: 'cache-watch', key: 'isEditing' } as const,
  false,
)
const isDemo = atom({ plugin: 'cache-watch', key: 'isDemo' } as const, false)
const isSetupOpen = atom(
  { plugin: 'cache-watch', key: 'isSetupOpen' } as const,
  false,
)

const parseLimits = (preset: string): [number, number] => {
  const [info, warn] = preset
    .split('/')
    .map(part => Number.parseInt(part, 10) * TOKENS_PER_K)

  return [info, warn]
}

const chosenLabel = (label: string, isChosen: boolean): string =>
  isChosen ? `✓ ${label}` : label

const tokensLabel = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1000)}k`

const texts = (level: Level, size: string): [string, string] => {
  if (level === 'cold') {
    return [
      'Prompt cache expired',
      `The next message sends all ${size} tokens at the full price.`,
    ]
  }

  if (level === 'info') {
    return [
      `Context: ${size} tokens`,
      'Each message sends all of it again. Think about a handover to a new session.',
    ]
  }

  return [
    `Context: ${size} tokens. A new session is recommended.`,
    'Each message sends all of it again. Write a handover document, then start fresh.',
  ]
}

const ring = (
  level: Level,
  fill: number,
  marks: readonly number[],
  label: string,
): string => {
  const { from, to } = TONES[level]
  const arc = Math.min(1, Math.max(RING_MIN_FILL, fill)) * RING_LENGTH
  const dots = marks
    .filter(mark => mark < 1)
    .map(
      mark =>
        `<circle cx="22" cy="2" r="1.4" fill="#8b8b8b" transform="rotate(${mark * 360} 22 22)"/>`,
    )
    .join('')
  const pulse =
    level === 'warn'
      ? '<animate attributeName="stroke-opacity" values="1;0.4;1" dur="1.8s" repeatCount="indefinite"/>'
      : ''
  const centre =
    level === 'cold'
      ? [0, 60, 120]
          .map(
            angle =>
              `<line x1="22" y1="15" x2="22" y2="29" stroke="${to}" stroke-width="2" stroke-linecap="round" transform="rotate(${angle} 22 22)"/>`,
          )
          .join('')
      : `<text x="22" y="25.5" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9.5" font-weight="700" fill="${to}">${label}</text>`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="${RING_PIXELS}" height="${RING_PIXELS}">`,
    `<defs><linearGradient id="tone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`,
    `<circle cx="22" cy="22" r="${RING_RADIUS}" fill="none" stroke="#8b8b8b" stroke-opacity="0.25" stroke-width="5"/>`,
    `<circle cx="22" cy="22" r="${RING_RADIUS}" fill="none" stroke="url(#tone)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${arc} ${RING_LENGTH}" transform="rotate(-90 22 22)">${pulse}</circle>`,
    dots,
    centre,
    '</svg>',
  ].join('')
}

let expiry: Timer | undefined

const armExpiry = ($: EngineInterface, ms: number) => {
  expiry?.cancel()
  expiry = $.clock.after(ms, () => void update($, isCold, () => true))
}

export const register: Register = (on, options) => {
  const ttlMinutes = Number(options.cacheTtlMinutes)
  const ttlMs = ttlMinutes * MINUTE_MS
  const limits = String(options.contextLimits)
  const [infoTokens, warnTokens] = parseLimits(limits)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: DEMO_COMMAND,
      description: 'Show or close a demo of all cache-watch cards',
      immediate: true,
    })
    await $.command.register({
      name: SETUP_COMMAND,
      description: 'Open the cache-watch setup card',
      immediate: true,
    })

    if ((await $.store.get(SETUP_DONE_KEY)) !== true) {
      await update($, isSetupOpen, () => true)
    }

    const last = await read($, reading)

    if (last === null) {
      return next(e)
    }

    const leftMs = last.at + ttlMs - (await $.clock.now())

    if (leftMs > 0) {
      armExpiry($, leftMs)
    } else {
      await update($, isCold, () => true)
    }

    return next(e)
  })

  on('command.run', { command: DEMO_COMMAND }, async $ => {
    const isOn = !(await read($, isDemo))
    await update($, isDemo, () => isOn)

    return {
      text: isOn
        ? `The cache-watch demo is above the prompt. Run /${DEMO_COMMAND} again to close it.`
        : 'The cache-watch demo is closed.',
    }
  })

  on('command.run', { command: SETUP_COMMAND }, async $ => {
    await update($, isSetupOpen, () => true)

    return { text: 'The cache-watch setup card is above the prompt.' }
  })

  on('session.measure', async ($, e, next) => {
    if (!e.changed.includes('context')) {
      return next(e)
    }

    const { tokens, window } = e.context
    const at = await $.clock.now()
    const measured: Reading | null =
      tokens === undefined ? null : { at, tokens, window }
    await update($, reading, () => measured)
    await update($, isCold, () => false)

    if (measured === null) {
      expiry?.cancel()
    } else {
      armExpiry($, ttlMs)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const last = await read($, reading)
    const isExpired = await read($, isCold)
    const hidden = await read($, dismissed)
    const isFieldOpen = await read($, isEditing)
    const isDemoOn = await read($, isDemo)
    const isSetupOn = await read($, isSetupOpen)

    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Input, Text } = $.ui.resolve(e)

    if (isSetupOn) {
      const saveOption = async (field: string, value: number | string) => {
        try {
          const { deny } = await $.config.set({
            key: `cache-watch.${field}`,
            value,
          })

          if (deny !== undefined) {
            $.ui.toast(`Setting not saved: ${deny}`)
          }
        } catch {
          $.ui.toast('Setting not saved: the settings have no cache-watch row.')
        }
      }

      const finishSetup = async () => {
        await $.store.set(SETUP_DONE_KEY, true)
        await update($, isSetupOpen, () => false)
      }

      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={SETUP_COLOR}
          paddingX={1}
          gap="sm"
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexDirection="column" flexGrow={1}>
              <Text weight="semibold" color={SETUP_COLOR}>
                cache-watch setup
              </Text>
              <Text dimColor size="footnote">
                Open this card again with /{SETUP_COMMAND}.
              </Text>
            </Box>
            <Button
              key="setup-done"
              label="Done"
              role="dismiss"
              onPress={finishSetup}
            />
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={SETUP_LABEL_CELLS}>
              <Text>Cache lifetime</Text>
            </Box>
            {TTL_CHOICES.map(choice => (
              <Button
                key={`ttl-${choice.minutes}`}
                label={chosenLabel(choice.label, choice.minutes === ttlMinutes)}
                variant={choice.minutes === ttlMinutes ? 'primary' : 'secondary'}
                onPress={() => saveOption('cacheTtlMinutes', choice.minutes)}
              />
            ))}
            <Text dimColor size="footnote">
              1 hour on a subscription, 5 minutes in usage overage.
            </Text>
          </Box>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={SETUP_LABEL_CELLS}>
              <Text>Context limits</Text>
            </Box>
            {LIMIT_PRESETS.map(preset => (
              <Button
                key={`limits-${preset.split('/')[0]}`}
                label={chosenLabel(preset.replace('/', ' / '), preset === limits)}
                variant={preset === limits ? 'primary' : 'secondary'}
                onPress={() => saveOption('contextLimits', preset)}
              />
            ))}
            <Text dimColor size="footnote">
              Handover hint / new-session warning, in tokens.
            </Text>
          </Box>
        </Box>
      )
    }

    const offerHandover = async () => {
      const { isFilled } = await $.prompt.fill({
        text: HANDOVER_PROMPT,
        mode: 'append',
      })

      if (!isFilled) {
        await update($, isEditing, () => true)
      }
    }

    const sendHandover = async (text: string) => {
      await update($, isEditing, () => false)
      await $.prompt.submit({ text, asUser: true })
    }

    const card = (view: CardView) => {
      const tone = TONES[view.level]
      const size = tokensLabel(view.tokens)
      const [title, detail] = texts(view.level, size)
      const scale = Math.max(view.window, warnTokens)
      const fill = view.tokens / scale
      const canHandOver = view.level !== 'cold'
      let meter

      if (e.surface === 'desktop') {
        const { Svg } = $.ui.resolve(e)
        meter = (
          <Svg
            source={ring(
              view.level,
              fill,
              [infoTokens / scale, warnTokens / scale],
              size,
            )}
            alt={`${size} tokens of context`}
            width={RING_PIXELS}
            height={RING_PIXELS}
          />
        )
      } else {
        const cells = Math.round(Math.min(1, fill) * METER_CELLS)
        meter = (
          <Text color={tone.color}>
            {'▰'.repeat(cells) + '▱'.repeat(METER_CELLS - cells)}
          </Text>
        )
      }

      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={tone.color}
          paddingX={1}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            {meter}
            <Box flexDirection="column" flexGrow={1}>
              <Text weight="semibold" color={tone.color}>
                {title}
              </Text>
              <Text dimColor size="footnote">
                {detail}
              </Text>
              {view.isCacheCold && canHandOver && (
                <Text color={TONES.cold.color} size="footnote">
                  Prompt cache expired: the next message is at the full price.
                </Text>
              )}
            </Box>
            {canHandOver && !isFieldOpen && (
              <Button
                key={`handover${view.keySuffix}`}
                label="Write handover"
                variant={view.level === 'warn' ? 'primary' : 'secondary'}
                onPress={offerHandover}
              />
            )}
            <Button
              key={`hide${view.keySuffix}`}
              label="Hide"
              role="dismiss"
              onPress={view.onHide}
            />
          </Box>
          {canHandOver && isFieldOpen && (
            <Input
              key={`handover-text${view.keySuffix}`}
              rows={3}
              value={HANDOVER_PROMPT}
              submitLabel="send"
              onSubmit={sendHandover}
            />
          )}
        </Box>
      )
    }

    if (isDemoOn) {
      const closeDemo = async () => {
        await update($, isEditing, () => false)
        await update($, isDemo, () => false)
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text dimColor size="footnote">
              cache-watch demo: sample values, real buttons
            </Text>
            <Button
              key="close-demo"
              label="Close demo"
              role="dismiss"
              onPress={closeDemo}
            />
          </Box>
          {DEMO_SAMPLES.map(sample =>
            card({
              ...sample,
              window: DEMO_WINDOW,
              keySuffix: `-${sample.level}`,
              onHide: closeDemo,
            }),
          )}
        </Box>
      )
    }

    if (last === null) {
      return next(e)
    }

    const isCacheCold =
      isExpired && !e.props.isWorking && last.tokens >= COLD_MIN_TOKENS
    let level: Level | null = null

    if (last.tokens >= warnTokens) {
      level = 'warn'
    } else if (last.tokens >= infoTokens) {
      level = 'info'
    } else if (isCacheCold) {
      level = 'cold'
    }

    const sizeStep = Math.floor(last.tokens / HIDE_STEP_TOKENS)
    const stateKey = `${level}|${sizeStep}|${isCacheCold ? last.at : ''}`

    if (level === null || hidden === stateKey) {
      return next(e)
    }

    return card({
      level,
      tokens: last.tokens,
      window: last.window,
      isCacheCold,
      keySuffix: '',
      onHide: async () => {
        await update($, isEditing, () => false)
        await update($, dismissed, () => stateKey)
      },
    })
  })
}
