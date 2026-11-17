/**
 * dsh-transcript-import — import an existing chat transcript into a brand new
 * DSH session by appending ordinary SessionEvents, so the model continues that
 * history as if it had always happened in this session.
 *
 * Zero runtime imports from @deepseek-ai/*: the plugin is loaded from an
 * arbitrary absolute path by the profile loader, whose module resolution only
 * covers the profile/app tree. Only node builtins are imported.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PLUGIN_NAME = 'dsh-transcript-import'
const TOOL_NAME = 'transcript_import'
const DEFAULT_PROVIDER = 'deepseek-account'
const DEFAULT_MODEL = 'deepseek-flash'
const TOOL_CARD_MAX_BYTES = 8 * 1024

/** One attachment image referenced by a message, plus its stored reference once admitted. */
interface TImagePart {
  path: string
  name: string
  ref?: any
}

/**
 * One non-image attachment referenced by a message. `path` is only set when the
 * export actually carried the bytes; a bare name means the export kept metadata
 * only, so the user has to supply the file before it can be imported.
 */
interface TFilePart {
  name: string
  size?: string
  path?: string
  ref?: any
}

/** One normalized message ready for event construction. */
interface TMessage {
  role: 'user' | 'assistant'
  text: string
  reasoning: string
  notes: string[]
  images: TImagePart[]
  files: TFilePart[]
}

interface TTranscript {
  kind: string
  title: string
  createdAt: number | undefined
  messages: TMessage[]
  warnings: string[]
}

/** A turn: one user prompt plus its recorded answer (when one exists). */
interface TTurn {
  user: TMessage
  assistant: TMessage | undefined
}

/** A referenced attachment whose bytes the export did not carry. */
interface TMissingFile {
  name: string
  size?: string
  turn: number
}

interface TImportOptions {
  reasoning: 'block' | 'text' | 'drop'
  keepToolNotes: boolean
  preserveTime: boolean
  provider: string
  model: string
  /** Skip referenced files the user did not supply instead of waiting for them. */
  allowMissingAttachments: boolean
  /** Explicit local paths supplied by the user for referenced attachment names. */
  files: string[]
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function trim(value: string): string {
  return value.replace(/^\s+|\s+$/g, '')
}

function pushUnique(list: string[], value: string): void {
  if (list.indexOf(value) === -1) list.push(value)
}

/** Section appended to assistant text when tool/search records are kept as prose. */
function notesSection(notes: string[]): string {
  if (notes.length === 0) return ''
  return `\n\n（当时的检索与文件操作记录）\n${notes.map((note) => `- ${note}`).join('\n')}`
}

function joinText(parts: string[]): string {
  return parts.map(trim).filter((part) => part.length > 0).join('\n\n')
}

/** Render a byte count the way the exporter does (one decimal, KiB base). */
function formatSize(bytes: unknown): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  return kilobytes < 1024 ? `${kilobytes.toFixed(1)} KB` : `${(kilobytes / 1024).toFixed(1)} MB`
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Source formats                                                      */
/* ------------------------------------------------------------------ */

/** DeepSeek client export: chat_sessions/<id>.json (role USER/ASSISTANT + fragments). */
function fromDeepSeekExport(document: Record<string, any>, warnings: string[]): TMessage[] {
  const messages: TMessage[] = []
  for (const raw of Array.isArray(document.messages) ? document.messages : []) {
    if (!isRecord(raw)) continue
    const role = str(raw.role).toLowerCase()
    const fragments: any[] = Array.isArray(raw.fragments) ? raw.fragments : []
    const notes: string[] = []
    const files: TFilePart[] = []
    if (role === 'user') {
      const text = joinText(fragments.filter((f) => f?.type === 'REQUEST').map((f) => str(f.content)))
      for (const fragment of fragments) {
        if (fragment?.type !== 'FILE') continue
        for (const file of Array.isArray(fragment.files) ? fragment.files : []) {
          const name = str(file?.file_name)
          if (name.length === 0) continue
          // Images in a JSON export are not carried as image blocks here, so
          // they stay notes; non-image files become pending attachments.
          if (file?.is_image === true) pushUnique(notes, `附件：${name}`)
          else files.push({ name, size: formatSize(file?.file_size) })
        }
      }
      if (text.length > 0 || notes.length > 0 || files.length > 0) {
        messages.push({ role: 'user', text, reasoning: '', notes, images: [], files })
      } else warnings.push('跳过一条空的用户消息')
      continue
    }
    if (role === 'assistant') {
      const reasoning = joinText(fragments.filter((f) => f?.type === 'THINK').map((f) => str(f.content)))
      const text = joinText(fragments.filter((f) => f?.type === 'RESPONSE').map((f) => str(f.content)))
      for (const fragment of fragments) {
        if (fragment?.type === 'TOOL_SEARCH') {
          const queries = (Array.isArray(fragment.queries) ? fragment.queries : []).map(str).filter((q) => q.length > 0)
          pushUnique(notes, queries.length > 0 ? `联网搜索：${queries.join(' / ')}` : '联网搜索')
        } else if (fragment?.type === 'TOOL_OPEN') {
          const label = str(fragment.title) || str(fragment.url)
          if (label.length > 0) pushUnique(notes, `打开网页：${label}`)
        }
      }
      if (text.length > 0 || reasoning.length > 0 || notes.length > 0) {
        messages.push({ role: 'assistant', text, reasoning, notes, images: [], files: [] })
      } else {
        warnings.push('跳过一条空的回答消息')
      }
    }
  }
  return messages
}

/** Native dsh-transcript/1 format. */
function fromTranscriptFormat(document: Record<string, any>, warnings: string[]): TMessage[] {
  const messages: TMessage[] = []
  for (const raw of Array.isArray(document.messages) ? document.messages : []) {
    if (!isRecord(raw)) continue
    const role = str(raw.role).toLowerCase()
    if (role !== 'user' && role !== 'assistant') {
      warnings.push(`跳过未知角色 "${str(raw.role)}"`)
      continue
    }
    const text = str(raw.text)
    const reasoning = str(raw.reasoning)
    const notes = Array.isArray(raw.notes) ? raw.notes.map(str).filter((n) => n.length > 0) : []
    if (text.length === 0 && reasoning.length === 0 && notes.length === 0) {
      warnings.push('跳过一条空消息')
      continue
    }
    messages.push({ role, text, reasoning, notes, images: [], files: [] })
  }
  return messages
}

/** Generic {messages:[{role,content}]} exports (OpenAI / Claude style). */
function fromGenericMessages(document: Record<string, any>, warnings: string[]): TMessage[] {
  const messages: TMessage[] = []
  for (const raw of Array.isArray(document.messages) ? document.messages : []) {
    if (!isRecord(raw)) continue
    const role = str(raw.role).toLowerCase()
    if (role !== 'user' && role !== 'assistant') {
      warnings.push(`跳过未知角色 "${str(raw.role)}"`)
      continue
    }
    let text = ''
    let reasoning = ''
    if (typeof raw.content === 'string') {
      text = raw.content
    } else if (Array.isArray(raw.content)) {
      const parts: string[] = []
      for (const block of raw.content) {
        if (!isRecord(block)) continue
        if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') parts.push(str(block.text))
        else if (block.type === 'thinking' || block.type === 'reasoning') reasoning = joinText([reasoning, str(block.thinking) || str(block.text)])
      }
      text = joinText(parts)
    }
    if (text.length === 0 && reasoning.length === 0) {
      warnings.push('跳过一条空消息')
      continue
    }
    messages.push({ role, text, reasoning, notes: [], images: [], files: [] })
  }
  return messages
}

/** Parse one half of a Markdown export section into a normalized message. */
function markdownMessage(raw: string, role: 'user' | 'assistant', baseDir: string): TMessage {
  const reasoning: string[] = []
  const notes: string[] = []
  const images: TImagePart[] = []
  const files: TFilePart[] = []
  let body = raw.replace(/<details>\s*<summary>(.+?)<\/summary>([\s\S]*?)<\/details>/g, (_match, summary: string, inner: string) => {
    if (summary.includes('思考链')) {
      const text = trim(inner)
      if (text.length > 0) reasoning.push(text)
    } else if (summary.includes('联网搜索')) {
      const queries = [...inner.matchAll(/- 查询：\s*`([^`]+)`/g)].map((match) => match[1])
      notes.push(queries.length > 0 ? `联网搜索：${queries.join(' / ')}` : '联网搜索')
    }
    return ''
  })
  body = body.replace(/^🔗 打开网页：\[(.+?)\]\(.+?\)\s*$/gm, (_match, title: string) => {
    notes.push(`打开网页：${title}`)
    return ''
  })
  // Non-image attachment lines written by the exporter:
  //   📎 **附件（导出包未包含原文件）**：`name` · size · 非图片
  //   📎 **附件**：[name](attachments/file)（size）
  //   📎 **附件缺失**：`name` → `rel`
  body = body.replace(/^📎 \*\*附件（导出包未包含原文件）\*\*：`([^`]+)` · ([^·]+?) · (图片|非图片)\s*$/gm,
    (_match, name: string, size: string, kind: string) => {
      if (role === 'user' && kind === '非图片') files.push({ name, size: trim(size) })
      else notes.push(`附件：${name}`)
      return ''
    })
  body = body.replace(/^📎 \*\*附件\*\*：\[(.+?)\]\((.+?)\)（(.+?)）\s*$/gm,
    (_match, name: string, target: string, size: string) => {
      if (role === 'user' && target.length > 0) {
        files.push({ name, size: trim(size), path: isAbsolute(target) ? target : join(baseDir, target) })
      } else notes.push(`附件：${name}`)
      return ''
    })
  body = body.replace(/^📎 \*\*附件缺失\*\*：`([^`]+)` → `.+?`\s*$/gm, (_match, name: string) => {
    if (role === 'user') files.push({ name })
    else notes.push(`附件：${name}`)
    return ''
  })
  body = body.replace(/^!\[(.+?)\]\((.+?)\)\s*$/gm, (_match, alt: string, target: string) => {
    // A user image becomes a real image block; anything else (or an assistant
    // image, which has no producer here) stays a filename note.
    if (role === 'user' && target.length > 0) {
      images.push({ path: isAbsolute(target) ? target : join(baseDir, target), name: alt })
    } else {
      notes.push(`附件：${alt}`)
    }
    return ''
  })
  body = body.replace(/^_【CONTENT_RISK】_[^\n]*$/gm, '')
  body = body.replace(/^\s*---\s*$/gm, '')
  body = body.replace(/^\*msg [^*]*\*\s*$/m, '')
  body = body.replace(/\n{3,}/g, '\n\n')
  return { role, text: trim(body), reasoning: joinText(reasoning), notes, images, files }
}

/**
 * Markdown export produced by the exporter GUI (`<dir>/<id>_<title>/<title>.md`):
 * `## 🧑 用户` / `## 🤖 AI` sections, thinking in `<details>`, search results and
 * opened pages as inline blocks. Disclaimers and attachment images become notes.
 */
function fromMarkdownExport(markdown: string, baseDir: string, warnings: string[]): TTranscript {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const titleLine = lines.find((line) => line.startsWith('# '))
  const createdAtText = markdown.match(/\*\*创建\*\*\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
  const createdAt = createdAtText === null
    ? undefined
    : new Date(
      Number(createdAtText[1]),
      Number(createdAtText[2]) - 1,
      Number(createdAtText[3]),
      Number(createdAtText[4]),
      Number(createdAtText[5]),
      Number(createdAtText[6]),
    ).getTime()
  const messages: TMessage[] = []
  let role: 'user' | 'assistant' | undefined
  let buffer: string[] = []
  const flush = (): void => {
    if (role === undefined) return
    const message = markdownMessage(buffer.join('\n'), role, baseDir)
    if (message.text.length > 0 || message.reasoning.length > 0 || message.notes.length > 0
      || message.images.length > 0 || message.files.length > 0) {
      messages.push(message)
    } else warnings.push('跳过一条空消息')
  }
  let started = false
  for (const line of lines) {
    if (!started) {
      if (line.trim() === '## 对话') started = true
      continue
    }
    if (line.trim() === '## 🧑 用户') {
      flush()
      role = 'user'
      buffer = []
      continue
    }
    if (line.trim() === '## 🤖 AI') {
      flush()
      role = 'assistant'
      buffer = []
      continue
    }
    buffer.push(line)
  }
  flush()
  return {
    kind: 'markdown-export',
    title: titleLine === undefined ? '' : trim(titleLine.slice(2)),
    createdAt,
    messages,
    warnings,
  }
}

function detectAndNormalize(document: unknown, warnings: string[]): TTranscript {
  if (!isRecord(document)) throw new Error('文件内容必须是一个 JSON 对象')
  const format = str(document.format)
  if (format === 'dsh-transcript/1') {
    return {
      kind: 'dsh-transcript/1',
      title: str(document.title),
      createdAt: parseTime(document.createdAt),
      messages: fromTranscriptFormat(document, warnings),
      warnings,
    }
  }
  const messages: any[] = Array.isArray(document.messages) ? document.messages : []
  const looksDeepSeek = messages.some((m) => isRecord(m) && Array.isArray(m.fragments))
    || messages.some((m) => isRecord(m) && (str(m.role) === 'USER' || str(m.role) === 'ASSISTANT'))
  if (looksDeepSeek) {
    return {
      kind: 'deepseek-client-export',
      title: str(document.title),
      createdAt: parseTime(document.inserted_at) ?? parseTime(document.created_at),
      messages: fromDeepSeekExport(document, warnings),
      warnings,
    }
  }
  if (messages.length > 0) {
    return {
      kind: 'generic-messages',
      title: str(document.title),
      createdAt: parseTime(document.created_at) ?? parseTime(document.createdAt),
      messages: fromGenericMessages(document, warnings),
      warnings,
    }
  }
  throw new Error('无法识别的记录格式：需要 dsh-transcript/1、DeepSeek 客户端导出，或 {messages:[{role,content}]}')
}

/* ------------------------------------------------------------------ */
/* Turn planning                                                       */
/* ------------------------------------------------------------------ */

function planTurns(messages: TMessage[], warnings: string[]): TTurn[] {
  const turns: TTurn[] = []
  let pending: TMessage | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      if (pending !== undefined) {
        warnings.push('有用户消息没有得到回答，已按单轮保留')
        turns.push({ user: pending, assistant: undefined })
      }
      pending = message
      continue
    }
    if (pending === undefined) {
      warnings.push('跳过开头没有提问的回答')
      continue
    }
    turns.push({ user: pending, assistant: message })
    pending = undefined
  }
  if (pending !== undefined) warnings.push('最后一条用户消息没有回答，已忽略')
  return turns
}

/* ------------------------------------------------------------------ */
/* Attachment hydration                                                */
/* ------------------------------------------------------------------ */

/** Attachment store batch cap per admitted message. */
const MAX_IMAGES_PER_BATCH = 20

/** Detect the encoded image type from magic bytes; the store cross-checks it. */
function sniffImageMediaType(data: Uint8Array): string | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

/**
 * Replace referenced image files with durable attachment references so the
 * seeded user messages carry real image blocks the model can see. Any image
 * that cannot be admitted degrades back to a filename note with a warning.
 * @param messages - normalized messages, mutated in place.
 * @param ctx - plugin context (needs the `attachments` service).
 * @param warnings - shared warning sink.
 */
async function hydrateImages(messages: TMessage[], ctx: any, warnings: string[]): Promise<void> {
  const store = ctx?.attachments
  for (const message of messages) {
    if (message.images.length === 0) continue
    if (store === undefined || typeof store.saveImages !== 'function') {
      for (const image of message.images) pushUnique(message.notes, `附件：${image.name}`)
      warnings.push('当前环境没有附件服务（attachments），图片已降级为文件名注记')
      message.images = []
      continue
    }
    const kept: TImagePart[] = []
    for (let offset = 0; offset < message.images.length; offset += MAX_IMAGES_PER_BATCH) {
      const batch = message.images.slice(offset, offset + MAX_IMAGES_PER_BATCH)
      const inputs: any[] = []
      const usable: TImagePart[] = []
      for (const image of batch) {
        try {
          const bytes = await readFile(image.path)
          const mediaType = sniffImageMediaType(bytes)
          if (mediaType === undefined) throw new Error('不是可识别的 PNG/JPEG/WebP/GIF 图片')
          inputs.push({ data: bytes, mediaType, name: image.name })
          usable.push(image)
        } catch (error: any) {
          pushUnique(message.notes, `附件：${image.name}`)
          warnings.push(`附件 ${image.name} 未能导入：${error?.message ?? String(error)}`)
        }
      }
      if (inputs.length === 0) continue
      try {
        const refs = await store.saveImages(inputs)
        usable.forEach((image, index) => kept.push({ ...image, ref: refs[index] }))
      } catch (error: any) {
        for (const image of usable) pushUnique(message.notes, `附件：${image.name}`)
        warnings.push(`附件 ${usable.map((image) => image.name).join('、')} 未能导入：${error?.message ?? String(error)}`)
      }
    }
    message.images = kept
  }
}

/**
 * Compare attachment names the way a person would: the DeepSeek client appends
 * a duplicate marker (`广义生命论 (10086).docx`) that the local file lacks.
 * @param name - a referenced name or a supplied path.
 * @returns a case-folded leaf name without the duplicate marker.
 */
function normalizeFileName(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  return leaf.replace(/\s*\(\d+\)(?=\.[^.]*$)/, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Referenced attachments that still have no local bytes.
 * @param turns - planned rounds.
 * @returns missing references with their 1-based turn numbers.
 */
function listMissingFiles(turns: TTurn[]): TMissingFile[] {
  const missing: TMissingFile[] = []
  turns.forEach((turn, index) => {
    for (const file of turn.user.files) {
      if (file.path === undefined) missing.push({ name: file.name, size: file.size, turn: index + 1 })
    }
  })
  return missing
}

/**
 * Match user-supplied paths to referenced attachments by filename, so a record
 * that only kept metadata can still get real bytes.
 * @param turns - planned rounds, mutated in place.
 * @param supplied - local paths the user handed over.
 * @param warnings - shared warning sink.
 */
function matchSuppliedFiles(turns: TTurn[], supplied: string[], warnings: string[]): void {
  const pending = new Map<string, string[]>()
  for (const path of supplied) {
    const key = normalizeFileName(path)
    const list = pending.get(key)
    if (list === undefined) pending.set(key, [path])
    else list.push(path)
  }
  for (const turn of turns) {
    for (const file of turn.user.files) {
      if (file.path !== undefined) continue
      const list = pending.get(normalizeFileName(file.name))
      if (list === undefined || list.length === 0) continue
      file.path = list.shift()
    }
  }
  for (const list of pending.values()) {
    for (const path of list) warnings.push(`附件 ${path} 在记录里没有对应的引用，已忽略`)
  }
}

/**
 * Store every referenced file that has local bytes as a durable attachment so
 * seeded messages carry `file` blocks. Failed reads degrade to filename notes.
 * @param turns - planned rounds, mutated in place.
 * @param ctx - plugin context (needs the `attachments` service).
 * @param warnings - shared warning sink.
 */
async function hydrateFiles(turns: TTurn[], ctx: any, warnings: string[]): Promise<void> {
  const files = turns.flatMap((turn) => turn.user.files).filter((file) => file.path !== undefined)
  if (files.length === 0) return
  const store = ctx?.attachments
  if (store === undefined || typeof store.saveFile !== 'function') {
    for (const turn of turns) {
      for (const file of turn.user.files) {
        pushUnique(turn.user.notes, `附件：${file.name}`)
        file.path = undefined
      }
    }
    warnings.push('当前环境没有附件服务（attachments），文件附件已降级为文件名注记')
    return
  }
  for (const turn of turns) {
    for (const file of turn.user.files) {
      if (file.path === undefined) continue
      try {
        file.ref = await store.saveFile({ data: await readFile(file.path), name: file.name })
      } catch (error: any) {
        file.path = undefined
        pushUnique(turn.user.notes, `附件：${file.name}`)
        warnings.push(`附件 ${file.name} 未能导入：${error?.message ?? String(error)}`)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Event construction                                                  */
/* ------------------------------------------------------------------ */

/** Split text into stream-sized deltas so the synthetic stream stays reasonable. */
function deltas(text: string): string[] {
  const size = 160
  const parts: string[] = []
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size))
  return parts
}

function streamFor(blocks: any[], baseTime: number): any[] {
  const records: any[] = []
  let time = baseTime
  blocks.forEach((block, index) => {
    records.push({ type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } })
    const text = typeof block.text === 'string' ? block.text : ''
    for (const delta of deltas(text)) {
      time += 10
      records.push({
        type: 'chunk',
        time,
        chunk: block.type === 'text'
          ? { type: 'text-delta', index, text: delta }
          : { type: 'reasoning-delta', index, text: delta },
      })
    }
    records.push({ type: 'chunk', time, chunk: { type: 'block-end', index, block: { ...block } } })
    time += 10
  })
  records.push({ type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'stop' } } })
  return records
}

function assistantContent(message: TMessage, options: TImportOptions): any[] {
  const blocks: any[] = []
  const reasoning = trim(message.reasoning)
  if (reasoning.length > 0 && options.reasoning === 'block') {
    blocks.push({ type: 'reasoning', text: reasoning })
  } else if (reasoning.length > 0 && options.reasoning === 'text') {
    blocks.push({ type: 'text', text: `（以下这段是当时的思考过程）\n${reasoning}` })
  }
  const body = `${trim(message.text)}${options.keepToolNotes ? notesSection(message.notes) : ''}`
  if (body.length > 0) blocks.push({ type: 'text', text: body })
  return blocks
}

function userContent(message: TMessage): any[] {
  const text = trim(message.text)
  const notes = message.notes.length > 0 ? notesSection(message.notes) : ''
  const body = `${text}${notes}`.replace(/^\s+/, '')
  const blocks: any[] = message.images
    .filter((image) => image.ref !== undefined)
    .map((image) => ({ type: 'image', attachment: image.ref }))
  for (const file of message.files) {
    if (file.ref !== undefined) blocks.push({ type: 'file', attachment: file.ref })
  }
  if (body.length > 0) blocks.push({ type: 'text', text: body })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '（空消息）' })
  return blocks
}

/**
 * Build the complete event batch: one closed turn per recorded round, with a
 * placeholder empty system node at surface 0 (the loop replaces it with the
 * rendered system prompt on the next step).
 * Emits full event envelopes (`seq`/`time`/`type`/`data`/`surfaceOp`) because the
 * batch is handed to the agent factory as a constructor SEED: only seeded history
 * exists before the loop is built, so the loop's turn counter starts at the
 * imported turn count instead of 0.
 * @param turns - planned rounds.
 * @param options - normalization options.
 * @param now - base timestamp for the synthetic stream.
 */
function buildSeed(turns: TTurn[], options: TImportOptions, now: number): any[] {
  const seed: any[] = []
  const baseTime = Math.floor(now)
  let seq = 0
  const emit = (type: string, data: any, surfaceOp?: string): void => {
    seed.push(surfaceOp === undefined
      ? { seq: seq++, time: baseTime, type, data }
      : { seq: seq++, time: baseTime, type, data, surfaceOp })
  }
  const systemMessage = { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } }
  turns.forEach((turn, index) => {
    const turnNumber = index + 1
    emit('turn/start', { turn: turnNumber })
    emit('step/start', { turn: turnNumber, step: 1 })
    if (index === 0) {
      emit('system/message', { turn: turnNumber, step: 1, message: systemMessage }, 'append')
    }
    emit('user/message', { id: randomUUID(), role: 'user', content: userContent(turn.user), source: { kind: 'user' } }, 'append')
    let closed = false
    if (turn.assistant !== undefined) {
      const content = assistantContent(turn.assistant, options)
      if (content.length > 0) {
        emit('assistant/message', {
          turn: turnNumber,
          step: 1,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content,
            source: { kind: 'model', provider: options.provider, model: options.model },
          },
          stream: streamFor(content, baseTime + index * 60_000),
        }, 'append')
        closed = true
      }
    }
    emit('step/end', { turn: turnNumber, step: 1 })
    emit('turn/end', { turn: turnNumber, reason: { kind: closed ? 'completed' : 'blocked' } })
  })
  return seed
}

/* ------------------------------------------------------------------ */
/* Estimates                                                           */
/* ------------------------------------------------------------------ */

/** Coarse token estimate: CJK characters count ~1, other characters ~0.3. */
function estimateTokens(messages: TMessage[]): number {
  let total = 0
  for (const message of messages) {
    const text = `${message.text}${message.reasoning}${message.notes.join('')}`
    for (const char of text) total += char.charCodeAt(0) > 0x2e80 ? 1 : 0.3
  }
  return Math.ceil(total)
}

function totalChars(messages: TMessage[]): number {
  let total = 0
  for (const message of messages) total += `${message.text}${message.reasoning}${message.notes.join('')}`.length
  return total
}

/* ------------------------------------------------------------------ */
/* Tool card (DSH / DSHgo)                                             */
/* ------------------------------------------------------------------ */

/**
 * Build a DSHgo-native tool card, guarding every rule that would otherwise fail
 * the whole tool call (throwing builder, non-lossless JSON, 8 KiB budget).
 */
function toolCard(build: () => any): any {
  try {
    const view = build()
    const text = JSON.stringify(view)
    if (text === undefined || Buffer.byteLength(text, 'utf8') > TOOL_CARD_MAX_BYTES) return {}
    return { 'dsh-go/view': JSON.parse(text) }
  } catch {
    return {}
  }
}

function importView(value: any): any {
  const awaiting = value.needsAttachments === true && value.dryRun !== true
  return {
    type: 'stack',
    title: awaiting
      ? `需要确认附件：${value.title || '未命名记录'}`
      : value.dryRun ? `预演：${value.title || '未命名记录'}` : `已导入「${value.title || '聊天记录'}」`,
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: '轮次', value: `${value.turns}` },
          { type: 'metric', label: '消息', value: `${value.messages}` },
          { type: 'metric', label: '约', value: `${formatNumber(value.approxTokens)} tok` },
        ],
      },
      {
        type: 'text',
        tone: 'muted',
        text: awaiting
          ? `记录里 ${value.missingFiles.length} 个附件不在导出包里，等待提供路径或选择跳过`
          : value.dryRun ? `来源：${value.kind}` : `新会话 ${value.sessionId}，打开它即可继续这段对话`,
      },
    ],
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/* ------------------------------------------------------------------ */
/* Tool implementation                                                 */
/* ------------------------------------------------------------------ */

function renderSummary(value: any): string {
  const lines: string[] = []
  const imageNote = value.images > 0 ? `，含 ${value.images} 张附件图片` : ''
  const fileNote = value.files > 0 ? `，含 ${value.files} 个文件附件` : ''
  if (value.needsAttachments === true && value.dryRun !== true) {
    lines.push(`这份记录引用了 ${value.missingFiles.length} 个导出包没有携带的非图片附件，所以还没有导入：`)
    for (const item of value.missingFiles) lines.push(`- ${item}`)
    lines.push('先问用户手上有哪些文件：有的话让用户把本地路径发来，带上 files 参数（按文件名自动放回原来那条消息）重新调用；用户不提供或不想放的话，带上 allowMissingAttachments=true 重新调用，会只保留文件名注记后正常导入。')
    if (value.warnings.length > 0) lines.push(`提示：${value.warnings.join('；')}`)
    return lines.join('\n')
  }
  if (value.dryRun) {
    lines.push(`预演完成：来源格式 ${value.kind}，${value.turns} 轮 / ${value.messages} 条消息${imageNote}${fileNote}，约 ${formatNumber(value.approxTokens)} tokens（${formatNumber(value.chars)} 字符）。`)
    lines.push('尚未写入任何会话。确认无误后请用 dryRun=false 重新调用。')
    if (value.needsAttachments === true) {
      lines.push(`注意：${value.missingFiles.length} 个非图片附件不在导出包里（${value.missingFiles.join('；')}）。正式导入前需要用户提供本地路径（files 参数），或明确跳过（allowMissingAttachments=true）。`)
    }
  } else {
    lines.push(`已导入 ${value.turns} 轮 / ${value.messages} 条消息${imageNote}${fileNote}（约 ${formatNumber(value.approxTokens)} tokens）到新会话 ${value.sessionId}。`)
    lines.push('这段历史属于那个新会话，不属于当前会话。请在会话列表里打开它再继续对话；当前会话不会出现这些记录。')
  }
  if (value.warnings.length > 0) lines.push(`提示：${value.warnings.join('；')}`)
  return lines.join('\n')
}

async function resolvePath(path: string, exec: any): Promise<string> {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
  const cwd = str(exec?.agent?.session?.header?.cwd) || process.cwd()
  const separator = cwd.includes('\\') ? '\\' : '/'
  return `${cwd.replace(/[\\/]$/, '')}${separator}${path.replace(/^\.?[\\/]/, '')}`
}

/** Resolve a file or an export directory to the one session record inside it. */
async function pickRecordFile(input: string): Promise<string> {
  const info = await stat(input).catch(() => null)
  if (info === null) throw new Error(`路径不存在：${input}`)
  if (info.isFile()) return input
  if (!info.isDirectory()) throw new Error(`不是文件也不是目录：${input}`)
  const entries = await readdir(input, { withFileTypes: true })
  const isSessionMarkdown = (name: string): boolean => name.toLowerCase().endsWith('.md') && !name.startsWith('_')
  const candidates: string[] = entries
    .filter((entry) => entry.isFile() && isSessionMarkdown(entry.name))
    .map((entry) => join(input, entry.name))
  if (candidates.length === 0) {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const nested = await readdir(join(input, entry.name), { withFileTypes: true }).catch(() => [])
      for (const file of nested) {
        if (file.isFile() && isSessionMarkdown(file.name)) candidates.push(join(input, entry.name, file.name))
      }
    }
  }
  if (candidates.length === 0) throw new Error('目录里没有找到导出的会话 .md 文件')
  if (candidates.length > 1) throw new Error(`目录里有多个会话记录，请指定其中一个：${candidates.join('；')}`)
  return candidates[0]
}

async function runImport(args: any, exec: any, ctx: any): Promise<any> {
  const warnings: string[] = []
  const filePath = await resolvePath(str(args.path), exec)
  const recordFile = await pickRecordFile(filePath)
  let transcript: TTranscript
  if (recordFile.toLowerCase().endsWith('.md')) {
    let markdown: string
    try {
      markdown = await readFile(recordFile, 'utf8')
    } catch (error: any) {
      throw new Error(`无法读取记录文件 ${recordFile}：${error?.message ?? String(error)}`)
    }
    transcript = fromMarkdownExport(markdown, dirname(recordFile), warnings)
  } else {
    let document: unknown
    try {
      document = JSON.parse(await readFile(recordFile, 'utf8'))
    } catch (error: any) {
      throw new Error(`无法读取记录文件 ${recordFile}：${error?.message ?? String(error)}`)
    }
    transcript = detectAndNormalize(document, warnings)
  }
  const turns = planTurns(transcript.messages, warnings)
  if (turns.length === 0) throw new Error('没有可导入的对话轮次（需要至少一条提问和一条回答）')
  const firstLine = trim(turns[0].user.text).split('\n')[0]
  const derivedTitle = firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine

  const provider = str(args.provider) || str(exec?.agent?.options?.provider) || DEFAULT_PROVIDER
  const model = str(args.model) || str(exec?.agent?.options?.model) || DEFAULT_MODEL
  const supplied: string[] = []
  for (const raw of Array.isArray(args.files) ? args.files : []) {
    const value = str(raw)
    if (value.length > 0) supplied.push(await resolvePath(value, exec))
  }
  matchSuppliedFiles(turns, supplied, warnings)
  const options: TImportOptions = {
    reasoning: args.reasoning === 'text' || args.reasoning === 'drop' ? args.reasoning : 'block',
    keepToolNotes: args.keepToolNotes !== false,
    preserveTime: args.preserveTime === true,
    provider,
    model,
    allowMissingAttachments: args.allowMissingAttachments === true,
    files: supplied,
  }

  const messages = turns.flatMap((turn) => (turn.assistant === undefined ? [turn.user] : [turn.user, turn.assistant]))
  const missing = listMissingFiles(turns)
  const base = {
    kind: transcript.kind,
    title: trim(str(args.title)) || transcript.title || derivedTitle,
    turns: turns.length,
    messages: messages.length,
    images: messages.reduce((total, message) => total + message.images.length, 0),
    files: turns.reduce((total, turn) => total + turn.user.files.length, 0),
    missingFiles: missing.map((file) => `${file.name}${file.size === undefined ? '' : `（${file.size}）`}（第 ${file.turn} 轮）`),
    needsAttachments: missing.length > 0,
    chars: totalChars(messages),
    approxTokens: estimateTokens(messages),
    warnings,
  }

  if (args.dryRun === true) return { ...base, dryRun: true }

  // The record names files the export did not carry. Ask before writing anything:
  // the caller decides whether to hand over local paths or skip them.
  if (base.needsAttachments && !options.allowMissingAttachments) return { ...base, dryRun: false }

  // Store the referenced images now: the seed is built synchronously and must
  // already contain the durable attachment references.
  await hydrateImages(messages, ctx, warnings)
  base.images = messages.reduce((total, message) => total + message.images.filter((image) => image.ref !== undefined).length, 0)
  await hydrateFiles(turns, ctx, warnings)
  base.files = turns.reduce((total, turn) => total + turn.user.files.filter((file) => file.ref !== undefined).length, 0)
  // Skipped attachments stay visible as notes so the history does not silently
  // lose something the original conversation had.
  for (const turn of turns) {
    for (const file of turn.user.files) {
      if (file.path === undefined && file.ref === undefined) {
        pushUnique(turn.user.notes, `附件：${file.name}${file.size === undefined ? '' : `（${file.size}）`}`)
      }
    }
  }

  const cwd = str(args.cwd) || str(exec?.agent?.session?.header?.cwd)
  // Session lists sort by the newest event time. Preserving the record's old
  // timestamps buries the imported session at the bottom, so by default the
  // history is stamped "now"; preserveTime keeps the original clock.
  const baseTime = options.preserveTime ? transcript.createdAt ?? Date.now() : Date.now()
  const seed = buildSeed(turns, options, baseTime)
  // Create through the agent factory, not ctx.sessions.create(): only the
  // factory owns the persistence write handle, so a session created there is
  // durable and survives a restart (a store-only session persists nothing).
  // The imported log travels as the constructor seed so the loop is built on
  // top of it and continues the turn sequence instead of restarting at turn 1.
  const sessionId = `session-${randomUUID()}`
  let handle: any
  try {
    handle = await ctx.agents.create({
      sessionId,
      seed,
      agentOptions: { provider, model },
      ...(cwd.length > 0 ? { meta: { cwd } } : {}),
    })
  } catch (error: any) {
    throw new Error(`创建新会话失败：${error?.message ?? String(error)}`)
  }
  const session = (handle?.agent ?? handle)?.session
  if (session === undefined) throw new Error('创建新会话失败：factory 没有返回 session')
  if (base.title.length > 0) {
    // Seeded events never publish on session/event, so the title plugin never
    // sees the imported first prompt; pin the title explicitly instead.
    try {
      session.append('session/title', { title: base.title, messageSeqs: [], source: { kind: 'user' } })
    } catch {
      base.warnings.push('未能写入会话标题（该 profile 可能没有挂载 session-title）')
    }
  }
  try {
    await ctx.sessions.flush(session)
  } catch (error: any) {
    warnings.push(`持久化刷新失败：${error?.message ?? String(error)}`)
  }
  return { ...base, dryRun: false, sessionId: String(session.id) }
}

const parameters = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '聊天记录文件的路径（绝对路径，或相对当前工作目录）' },
    dryRun: { type: 'boolean', description: '只解析并估算，不写会话；默认 false' },
    reasoning: { type: 'string', enum: ['block', 'text', 'drop'], description: '思考链处理：block=原生 reasoning 块，text=并入正文，drop=丢弃；默认 block' },
    keepToolNotes: { type: 'boolean', description: '是否把检索/打开网页/附件记录降级为正文注记；默认 true' },
    preserveTime: { type: 'boolean', description: '是否保留记录里的原始时间戳；默认 false（用当前时间，新会话才会排在列表顶部）' },
    title: { type: 'string', description: '新会话标题，默认用记录自带的标题或首条消息' },
    provider: { type: 'string', description: '写入 assistant 消息的 provider 标记，默认沿用当前会话' },
    model: { type: 'string', description: '写入 assistant 消息的 model 标记，默认沿用当前会话' },
    cwd: { type: 'string', description: '新会话的工作目录，默认沿用当前会话' },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: '用户提供的附件本地路径（绝对路径或相对当前工作目录）。按文件名匹配记录里引用、但导出包没有携带的非图片附件，放回原来那条消息',
    },
    allowMissingAttachments: {
      type: 'boolean',
      description: '记录引用了导出包没带的附件时，是否跳过它们直接导入（只保留文件名注记）；默认 false，会先返回待确认列表让用户决定',
    },
  },
  required: ['path'],
  additionalProperties: false,
}

const outputSchema = {
  type: 'object',
  properties: {
    dryRun: { type: 'boolean' },
    kind: { type: 'string' },
    title: { type: 'string' },
    sessionId: { type: 'string' },
    turns: { type: 'number' },
    messages: { type: 'number' },
    images: { type: 'number' },
    files: { type: 'number' },
    missingFiles: { type: 'array', items: { type: 'string' } },
    needsAttachments: { type: 'boolean' },
    chars: { type: 'number' },
    approxTokens: { type: 'number' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['dryRun', 'kind', 'title', 'turns', 'messages', 'images', 'files', 'missingFiles', 'needsAttachments', 'chars', 'approxTokens', 'warnings'],
  additionalProperties: false,
}

export const name = PLUGIN_NAME
export const inject = ['tools', 'sessions', 'agents', 'attachments']

export function apply(ctx: any): void {
  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      '把一份已有的聊天记录导入成一个全新的 DSH 会话，让那段对话看起来原本就发生在这个会话里。',
      'path 可以是 dsh-transcript/1 文件、DeepSeek 客户端导出（chat_sessions/*.json）、通用 {messages:[{role,content}]}、或导出器生成的 Markdown 会话文件及其所在目录。',
      '导入只写新会话，不写当前会话；先 dryRun=true 看轮数与 token 估算，再正式导入。',
      '记录里的思考链默认写成 reasoning 块；检索/打开网页降级为正文注记，图片附件会存成真实附件并写成 image 块（失败时才降级为文件名注记）。',
      '记录引用、但导出包没带的非图片附件（docx/pdf/txt 等）会先返回待确认列表：先问用户手上有哪些文件，把用户给的本地路径放进 files 再调用；用户不提供时用 allowMissingAttachments=true 跳过。',
    ].join(' '),
    parameters,
    output: {
      schema: outputSchema,
      render: (_args: any, value: any) => [{ type: 'text', text: renderSummary(value) }],
      presentationMeta: (_args: any, value: any) => toolCard(() => importView(value)),
    },
    presentCall: (args: any) => ({
      card: 'generic',
      title: '导入聊天记录',
      kind: 'read',
      rawInput: str(args.path),
      locations: [{ path: str(args.path) }],
    }),
    async execute(args: any, exec: any) {
      return runImport(args, exec, ctx)
    },
  })
}
