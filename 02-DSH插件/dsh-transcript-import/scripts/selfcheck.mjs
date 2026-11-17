// Local harness: exercises the plugin's tool without a live DSH engine.
// Offline contract check: exercises the tool with a fake host context and
// validates the emitted event log. No DSH process or live model is involved.
// Run: node scripts/selfcheck.mjs <transcript file or export dir> [attachment path]
// Use PLUGIN_ENTRY=../lib/plugin.js to check the built output instead of the source.
const { apply } = await import(process.env.PLUGIN_ENTRY ?? '../src/plugin.ts')

const created = []
const captured = { tool: null }

apply({
  tools: { register: (definition) => { captured.tool = definition } },
  agents: {
    create: async (options) => {
      const events = [...(options.seed ?? [])]
      const session = {
        id: `test-session-${created.length + 1}`,
        // Mirrors the real Session API: one event per call, opts are surface metadata.
        append(type, data, opts) {
          const input = { seq: events.length, time: 1780000000000 + events.length, type, data }
          if (opts !== undefined) input.surfaceOp = opts.surfaceOp
          events.push(input)
          return input
        },
        events: () => events,
      }
      created.push(session)
      return { agent: { session } }
    },
  },
  sessions: { flush: async () => {} },
  // Stand-in for `ctx.attachments`: enough to prove the seed carries image blocks.
  attachments: {
    saveImages: async (inputs) => inputs.map((input, index) => ({
      attachmentId: `sha256:${String(index).padStart(64, '0')}`,
      mediaType: input.mediaType,
      width: 100,
      height: 100,
      bytes: input.data.byteLength,
      ...(input.name === undefined ? {} : { name: input.name }),
    })),
    saveFile: async (input) => ({
      attachmentId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      name: input.name,
      bytes: input.data.byteLength,
    }),
  },
})

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`)
}

function validate(events) {
  let seq = 0
  let turn = 0
  let step = 0
  let surface = 0
  let lastType = ''
  for (const entry of events) {
    const type = entry.type
    const data = entry.data
    const intent = entry.surfaceOp === undefined ? undefined : { surfaceOp: entry.surfaceOp }
    assert(entry.seq === seq, `seed seq ${entry.seq} contiguous at ${seq}`)
    assert(typeof entry.time === 'number' && Number.isSafeInteger(entry.time), 'integer event time')
    assert(typeof type === 'string', 'event type')
    assert(data !== undefined && JSON.stringify(data) !== undefined, `lossless payload for ${type}`)
    if (type !== 'system/message' && type !== 'user/message' && type !== 'assistant/message') {
      assert(intent === undefined, `${type} must not carry surface intent`)
    } else {
      assert(intent?.surfaceOp === 'append', `${type} surfaceOp append`)
      assert(intent.sourceEventSeqs === undefined, `${type} no sourceEventSeqs`)
      surface += 1
    }
    switch (type) {
      case 'turn/start':
        assert(data.turn === turn + 1, 'turn numbers are sequential')
        turn = data.turn
        break
      case 'step/start':
        assert(data.turn === turn && data.step === 1, 'step opens inside the turn')
        step = data.step
        break
      case 'system/message':
        assert(data.turn === turn && data.step === step, 'system message in open step')
        assert(data.message.content.length === 0, 'placeholder system node is empty')
        break
      case 'user/message':
        assert(data.role === 'user' && data.content.length > 0, 'user message content')
        assert(lastType === 'step/start' || lastType === 'system/message', 'user message follows step start')
        break
      case 'assistant/message': {
        assert(data.message.role === 'assistant', 'assistant role')
        assert(data.message.content.length > 0, 'assistant content')
        assert(data.message.source.kind === 'model', 'assistant source kind')
        const blocks = data.message.content
        const starts = data.stream.filter((r) => r.chunk?.type === 'block-start').length
        const ends = data.stream.filter((r) => r.chunk?.type === 'block-end').length
        assert(starts === blocks.length && ends === blocks.length, 'stream block count matches content')
        for (const [index, block] of blocks.entries()) {
          const start = data.stream.find((r) => r.chunk?.type === 'block-start' && r.chunk.index === index)
          const end = data.stream.find((r) => r.chunk?.type === 'block-end' && r.chunk.index === index)
          assert(start?.chunk.blockType === block.type, `stream start type at ${index}`)
          assert(JSON.stringify(end?.chunk.block) === JSON.stringify(block), `stream end block at ${index}`)
          const deltaType = block.type === 'text' ? 'text-delta' : 'reasoning-delta'
          const joined = data.stream
            .filter((r) => r.chunk?.type === deltaType && r.chunk.index === index)
            .map((r) => r.chunk.text)
            .join('')
          assert(joined === block.text, `stream deltas rebuild block ${index}`)
        }
        assert(data.stream.at(-1).chunk.type === 'finish', 'stream ends with finish')
        break
      }
      case 'step/end':
        assert(data.turn === turn, 'step closes inside turn')
        break
      case 'turn/end':
        assert(data.turn === turn && typeof data.reason?.kind === 'string', 'turn closes with reason')
        break
      case 'session/title':
        assert(typeof data.title === 'string' && data.title.length > 0, 'title payload')
        break
      default:
        throw new Error(`unexpected event ${type}`)
    }
    assert(!('seq' in data), 'harness payloads carry no seq')
    lastType = type
    seq += 1
  }
  assert(seq === events.length, 'no gaps')
  assert(lastType === 'turn/end' || lastType === 'session/title', 'log ends with turn/end')
  assert(surface >= 3, 'surface nodes produced')
}

async function main() {
  const target = process.argv[2]
  const exec = {
    agent: { options: { provider: 'deepseek-account', model: 'deepseek-flash' }, session: { header: { cwd: process.cwd() } } },
  }

  const dry = await captured.tool.execute({ path: target, dryRun: true }, exec)
  console.log('dryRun:', JSON.stringify(dry))

  const supplied = process.argv[3]
  let real = await captured.tool.execute({ path: target, ...(supplied === undefined ? {} : { files: [supplied] }) }, exec)
  console.log('import:', JSON.stringify(real))
  if (real.sessionId === undefined) {
    real = await captured.tool.execute({ path: target, allowMissingAttachments: true }, exec)
    console.log('skip import:', JSON.stringify(real))
  }
  assert(created.length === 1, 'exactly one session created')
  const events = created[0].events()
  validate(events)
  console.log(`events: ${events.length}`)
  console.log('user blocks:', JSON.stringify(events
    .filter((entry) => entry.type === 'user/message')
    .map((entry) => entry.data.content.map((block) => block.type))))
  console.log('render:', captured.tool.output.render({}, real)[0].text)
  const card = captured.tool.output.presentationMeta({}, real)
  assert(JSON.stringify(card).length < 8192, 'card under 8 KiB')
  console.log('card:', JSON.stringify(card))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
