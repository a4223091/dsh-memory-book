/**
 * Host half of memory-book（记忆）。
 *
 * 本地记忆：`$DSH_HOME/memory/`（默认 `%USERPROFILE%\.dsh\memory\`；独立实例如 qq 自动落到 `~/.dsh-qq/memory`），三层 —— core / wiki / raw。
 * - `memory` 工具：read / add / patch / remove / search（页面路径，不是文件路径）。
 * - 每轮注入：core 正文 + wiki/raw 目录索引（order 700，空库零注入）。
 * - 面板接口：/memory-book/{library,page,delete,search}。
 *
 * 已试过并移除：会话证据层（rollout）与待沉淀队列。理由：压缩摘要已提供交接信息，
 * 原始会话日志本身可检索，证据层的独立价值低于它带来的管道复杂度。
 * 沉淀 = 读会话日志（session_event_search/read）后直接提炼进 wiki/core，由模型完成。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'memory-book'
export const inject = ['tools', 'systemPrompt', 'agents', 'webServer']

/** 记忆库根目录：跟随 DSH_HOME，不同实例自动隔离。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const ROOT = path.join(DSH_HOME, 'memory')
/** L1 核心记忆：单文件，路径不可更改。 */
const CORE = 'core/核心记忆'
/** L2 知识层的五个子目录。 */
const WIKI_SUBS = ['projects', 'concepts', 'lessons', 'profile', 'entities']
/** 页面名字符集（与灵犀一致）：字母、数字、中文、点、下划线、连字符。 */
const PAGE_NAME = /^[\p{L}\p{N}._-]{1,64}$/u
const SETTINGS_FILE = path.join(ROOT, 'settings.json')
const CACHE_TTL_MS = 1000

const DEFAULT_SETTINGS = { coreChars: 4000, indexChars: 2500, pagesPerDir: 8 }

/** 面板配置项的合法范围（与 readSettings 的钳制一致）。 */
const SETTINGS_LIMITS = { coreChars: [500, 20000], indexChars: [300, 12000], pagesPerDir: [1, 50] }

const CATEGORY_LABELS = {
  projects: '项目',
  concepts: '概念',
  lessons: '经验',
  profile: '用户画像',
  entities: '实体',
  raw: '源文件索引',
}

let snapshotCache = null
let snapshotAt = 0

// ── 基础 ─────────────────────────────────────────────────────────────────────

function textOf(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function invalidate() {
  snapshotCache = null
  snapshotAt = 0
}

function readSettings() {
  const clamp = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
    return {
      coreChars: clamp(raw.coreChars, DEFAULT_SETTINGS.coreChars, 500, 20000),
      indexChars: clamp(raw.indexChars, DEFAULT_SETTINGS.indexChars, 300, 12000),
      pagesPerDir: clamp(raw.pagesPerDir, DEFAULT_SETTINGS.pagesPerDir, 1, 50),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 面板配置视图用：当前值 + 默认值 + 合法范围。 */
function settingsPayload() {
  return { settings: readSettings(), defaults: { ...DEFAULT_SETTINGS }, limits: SETTINGS_LIMITS }
}

/** 保存配置：逐个钳制到合法范围，写 settings.json。 */
function saveSettings(input) {
  const clamp = (key) => {
    const [min, max] = SETTINGS_LIMITS[key]
    return Math.min(max, Math.max(min, Math.round(Number(input[key]))))
  }
  const next = {
    coreChars: Number.isFinite(Number(input.coreChars)) ? clamp('coreChars') : DEFAULT_SETTINGS.coreChars,
    indexChars: Number.isFinite(Number(input.indexChars)) ? clamp('indexChars') : DEFAULT_SETTINGS.indexChars,
    pagesPerDir: Number.isFinite(Number(input.pagesPerDir)) ? clamp('pagesPerDir') : DEFAULT_SETTINGS.pagesPerDir,
  }
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/** 恢复默认：删掉 settings.json，回落内置默认值。 */
function resetSettings() {
  rmSync(SETTINGS_FILE, { force: true })
  return { ...DEFAULT_SETTINGS }
}

/** 解析 frontmatter：只认 `key: value` 与 `key: [a, b]`。 */
function splitFrontmatter(source) {
  const normalized = textOf(source).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { fields: {}, body: normalized.trim() }
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return { fields: {}, body: normalized.trim() }
  const head = normalized.slice(4, end)
  const body = normalized.slice(normalized.indexOf('\n', end + 1) + 1)
  const fields = {}
  for (const line of head.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (match === null) continue
    const value = match[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[match[1]] = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      fields[match[1]] = value.replace(/^["']|["']$/g, '')
    }
  }
  return { fields, body: body.trim() }
}

// ── 路径与存储 ────────────────────────────────────────────────────────────────

/** 校验并归一化页面路径；非法返回 undefined（挡住 ../ 与绝对路径）。 */
function normalizePagePath(input) {
  const raw = textOf(input).trim().replace(/\\/g, '/')
  if (raw === '') return undefined
  if (raw === CORE) return CORE
  const parts = raw.split('/')
  if (parts.length === 3 && parts[0] === 'wiki' && WIKI_SUBS.includes(parts[1]) && PAGE_NAME.test(parts[2])) return raw
  if (parts.length === 2 && parts[0] === 'raw' && PAGE_NAME.test(parts[1])) return raw
  return undefined
}

function fileOf(rel) {
  return path.join(ROOT, ...rel.split('/')) + '.md'
}

/** 枚举全部页面（core + wiki + raw）。 */
function pageEntries() {
  const out = []
  const push = (rel) => {
    const file = fileOf(rel)
    try {
      const stat = statSync(file)
      if (!stat.isFile()) return
      out.push({ rel, file, mtime: stat.mtimeMs })
    } catch {
      // 不存在就跳过。
    }
  }
  push(CORE)
  for (const sub of WIKI_SUBS) {
    let names = []
    try {
      names = readdirSync(path.join(ROOT, 'wiki', sub))
    } catch {
      names = []
    }
    for (const entry of names) {
      if (entry.endsWith('.md')) push(`wiki/${sub}/${entry.slice(0, -3)}`)
    }
  }
  let rawNames = []
  try {
    rawNames = readdirSync(path.join(ROOT, 'raw'))
  } catch {
    rawNames = []
  }
  for (const entry of rawNames) {
    if (entry.endsWith('.md')) push(`raw/${entry.slice(0, -3)}`)
  }
  return out
}

function loadPage(rel) {
  const file = fileOf(rel)
  let text
  let stat
  try {
    text = readFileSync(file, 'utf8')
    stat = statSync(file)
  } catch {
    return undefined
  }
  const parsed = splitFrontmatter(text)
  return {
    rel,
    file,
    text,
    fields: parsed.fields,
    body: parsed.body,
    updated: new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

// ── 注入内容 ─────────────────────────────────────────────────────────────────

/** 目录索引用的轻量快照（1 秒缓存）。 */
function snapshot() {
  const now = Date.now()
  if (snapshotCache !== null && now - snapshotAt < CACHE_TTL_MS) return snapshotCache
  const pages = []
  for (const entry of pageEntries()) {
    const page = loadPage(entry.rel)
    if (page === undefined) continue
    pages.push({
      rel: page.rel,
      mtime: entry.mtime,
      title: textOf(page.fields.title).trim() || path.basename(page.rel),
      summary: textOf(page.fields.summary).trim(),
      sources: Array.isArray(page.fields.sources) ? page.fields.sources : [],
      related: Array.isArray(page.fields.related) ? page.fields.related : [],
      isCore: page.rel === CORE,
      coreBody: page.rel === CORE ? page.body : '',
    })
  }
  snapshotCache = { pages }
  snapshotAt = now
  return snapshotCache
}

function categoryOf(rel) {
  if (rel === CORE) return 'core'
  if (rel.startsWith('wiki/')) return rel.split('/')[1]
  if (rel.startsWith('raw/')) return 'raw'
  return 'other'
}

function categoryLabelOf(rel) {
  if (rel === CORE) return '核心记忆'
  return CATEGORY_LABELS[categoryOf(rel)] || '其他'
}

/**
 * 索引里的一行：**页面路径打头**，模型看到就能直接 memory read，不必先 search 或猜文件名。
 * 标题与文件名相同时省掉标题，省预算。
 */
function indexLine(item) {
  const name = path.basename(item.rel)
  const label = item.title !== '' && item.title !== name ? `${item.title}：` : ''
  return `    ${item.rel}  —  ${label}${item.summary || '（无摘要）'}`
}

function renderIndex(pages) {
  const settings = readSettings()
  const lines = []
  const hasCore = pages.some((page) => page.isCore)
  lines.push(`核心记忆 core/${hasCore ? '' : '（未创建）'}`)
  lines.push('知识层 wiki/')
  for (const sub of WIKI_SUBS) {
    const items = pages.filter((page) => page.rel.startsWith(`wiki/${sub}/`)).sort((a, b) => b.mtime - a.mtime)
    lines.push(`  wiki/${sub}/  (${items.length} pages)`)
    const shown = items.slice(0, settings.pagesPerDir)
    for (const item of shown) lines.push(indexLine(item))
    if (items.length > shown.length) lines.push(`    …另有 ${items.length - shown.length} 页，用 memory search 查`)
  }
  const raws = pages.filter((page) => page.rel.startsWith('raw/')).sort((a, b) => b.mtime - a.mtime)
  lines.push(`源文件索引 raw/  (${raws.length} pages)`)
  const shownRaw = raws.slice(0, settings.pagesPerDir)
  for (const item of shownRaw) lines.push(indexLine(item))
  if (raws.length > shownRaw.length) lines.push(`    …另有 ${raws.length - shownRaw.length} 页，用 memory search 查`)

  let text = lines.join('\n')
  if (text.length > settings.indexChars) {
    const cut = text.slice(0, settings.indexChars)
    const lastBreak = cut.lastIndexOf('\n')
    text = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut) + '\n（索引超出预算已截断，用 memory search 查未列出的页面）'
  }
  return text
}

/** 实例是否提供了自定义工具卡（TOOL.md）。有则说明该实例把细节放在记忆页里，参数说明也走精简版。 */
function hasToolOverride() {
  try {
    return existsSync(path.join(ROOT, 'TOOL.md'))
  } catch {
    return false
  }
}

/** 模型可见的 memory 工具说明：实例可用 <ROOT>/TOOL.md 覆盖，不存在则用默认。 */
function toolDescription() {
  try {
    const file = path.join(ROOT, 'TOOL.md')
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      console.log('[memory-book] tool description override: ' + (text !== '' ? 'TOOL.md' : 'empty') + ' @ ' + file)
      if (text !== '') return text
    }
  } catch {
    // 读失败用默认。
  }
  return [
    '管理本地长期记忆（三层：core/核心记忆、wiki/ 知识层、raw/ 来源凭证）。',
    'core/核心记忆 是固定单文件，路径不可更改，正文每轮完整注入，上限约 4000 字符；',
    'wiki/ 每轮只注入目录索引（页面路径 + 标题 + summary），正文须按需 read；raw/ 只登记来源定位符。',
    `action 必填，取值为 ${ACTION_LIST}；brief 必填，一句话说明本次操作目的。`,
    '速查：read 读整页（返回 frontmatter 与 updated）；add 新建（content 传整页，不覆盖已有页面）；',
    'patch 局部替换（old_string 须非空且唯一匹配，new_string 传空串表示删除该片段）；',
    'remove 删除整页；search 按主题词检索全文（匹配标题/摘要/正文），多个词用空格分开时要求同时命中，',
    '全部词都没同时命中时退回「命中部分词」的结果并说明；query 不要写路径。',
    '页面格式：以 --- 包裹的 frontmatter 开头，必填 title 与 summary，可选 sources（raw/页名#条目标题）与 related（wiki/…）；',
    'summary 会出现在每轮注入的索引里，要写成「这页回答什么问题」的判别句，而不是内容缩写。',
    'raw 页按主题聚合多条来源，frontmatter 放 title/summary，正文用 ## 标题分隔条目，每条记 type（local|cloud|web）与 path / file_id+url / url、added、summary。',
    '写入时机：用户明确要求记住时直接写；未明确要求但有长期价值时先征得同意；不写临时状态、未验证猜测与敏感凭证。',
    '用户说「沉淀/整理记忆」时：用 session_event_search / session_event_read 回取本次会话的关键片段，直接提炼成 wiki 页（或 core 短规则），不需要先生成中间证据文件。',
  ].join('')
}

/** 组装 <memory_system>；空库返回空串。 */
function renderSystem() {
  if (!existsSync(ROOT)) return ''
  const settings = readSettings()
  const pages = snapshot().pages
  const core = pages.find((page) => page.isCore)
  const others = pages.filter((page) => !page.isCore)
  if (core === undefined && others.length === 0) return ''

  let coreText
  if (core === undefined) {
    coreText = '（还没建核心记忆）'
  } else {
    coreText = core.coreBody.trim()
    if (coreText === '') coreText = '（核心记忆正文为空）'
    if (coreText.length > settings.coreChars) coreText = coreText.slice(0, settings.coreChars) + '\n…（超出预算，已截断）'
  }
  const coreBlock = `<content>\n${coreText}\n</content>`
  const indexText = renderIndex(pages)

  // 实例级自定义注入模板：<ROOT>/INJECT.md，支持 {{core}} 与 {{index}} 占位符。
  // 独立实例（如 QQ 大脑）可以用它把开发向说明换成自己的人设化说明；不存在则用默认模板。
  const templatePath = path.join(ROOT, 'INJECT.md')
  if (existsSync(templatePath)) {
    try {
      const template = readFileSync(templatePath, 'utf8')
      return template.replaceAll('{{core}}', coreText).replaceAll('{{index}}', indexText).trim()
    } catch {
      // 读失败时回退默认模板。
    }
  }

  return [
    '<memory_system>',
    '<memory_layers>',
    '重要：本地记忆分三层，每层的定位、边界与访问途径不同。',
    '**核心记忆 core/核心记忆**：每轮必守的短规则（工作区路由、项目铁律、被纠正的行为）；正文每轮全文注入，无需 memory read；宜精炼（≤4000 字符），项目细节与长文放知识层。',
    '**知识层 wiki/**：可独立检索的主题知识（项目、概念、经验、画像）；只注入目录索引（含页面路径），正文用 memory read 按需取；记提炼后的要点，不落原始全文。',
    '**源文件索引 raw/**：外部资料的溯源凭证（file_id / 本地 path / url）；通过 wiki 页 frontmatter 的 sources 暴露，需核对原文时按 sources 去 read。',
    '与规则卡的边界：跨项目的行为约束写在规则卡里；这里只放工作区路由、项目铁律与知识，不重复抄规则卡。',
    '</memory_layers>',
    '<core_memory>',
    '以下是已在本轮完整注入的 `core/核心记忆` 正文。',
    coreBlock,
    '</core_memory>',
    '<memory_index>',
    '以下是记忆体系的目录索引（页面路径 — 标题：一句话摘要）。',
    indexText,
    '</memory_index>',
    '<memory_use>',
    '- 当前对话或核心记忆已经足够时直接完成任务，不额外检索。',
    '- 索引每行开头的就是页面路径，判断相关后直接 memory read，不必先 search。',
    '- 不知道路径时才用 memory search：按主题词检索，多个词用空格分开，要求同时命中。',
    '- 记忆里的路径、配置、版本可能已变化；涉及可能变化的事实时回到现场核验。',
    '</memory_use>',
    '<memory_write>',
    '- 用户明确要求记住、记录或沉淀时直接写入；未明确要求但有长期价值时先征得同意；不写临时状态、未经验证猜测与敏感凭证。',
    '- core 放每轮必用的精炼规则；长期背景、决策与经验写 wiki；原始资料凭证写 raw。',
    '- 记忆候选：用户的偏好与纠正、外部资料（上传文件/分享的网页文章）、多轮试错后找到的方案、可复用的流程与配置。',
    '- 不写：普通闲聊、一次性安排、进度流水、未经验证的猜测、以及任何敏感凭证（密码、令牌、密钥）。',
    '- 具体页面格式与限制以 memory 工具描述为准。',
    '</memory_write>',
    '</memory_system>',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

// ── 工具实现 ─────────────────────────────────────────────────────────────────

function requirePath(input, action) {
  const rel = normalizePagePath(input)
  if (rel === undefined) {
    throw new Error(
      `${action} 需要的 path 不合法。允许的路径：core/核心记忆、wiki/{projects,concepts,lessons,profile,entities}/页面名、raw/页面名` +
        '（页面名只能包含字母、数字、中文、点、下划线、连字符，不含后缀 .md）。',
    )
  }
  return rel
}

function pageFormatError(content) {
  const parsed = splitFrontmatter(content)
  const title = textOf(parsed.fields.title).trim()
  const summary = textOf(parsed.fields.summary).trim()
  if (title === '' || summary === '') return '页面格式错误：内容必须以 frontmatter 开头，且含 title 与 summary 两个必填字段'
  return undefined
}

function occurrences(haystack, needle) {
  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return count
    count += 1
    from = index + needle.length
  }
}

function snippetAround(text, index, length) {
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + length + 60)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

function doRead(args) {
  const rel = requirePath(args.path, 'read')
  const page = loadPage(rel)
  if (page === undefined) throw new Error(`读取记忆失败：页面不存在: ${rel}`)
  return `<read_only>\npath: ${rel}\nupdated: ${page.updated}\n</read_only>\n<page_content>\n${page.text}\n</page_content>`
}

function doAdd(args) {
  const rel = requirePath(args.path, 'add')
  if (existsSync(fileOf(rel))) throw new Error(`新增记忆失败：页面已存在: ${rel}`)
  const content = textOf(args.content)
  if (content.trim() === '') throw new Error('新增记忆失败：需要 content，传入完整页面内容（含 frontmatter）。')
  const invalid = pageFormatError(content)
  if (invalid !== undefined) throw new Error(`新增记忆失败：${invalid}`)
  mkdirSync(path.dirname(fileOf(rel)), { recursive: true })
  writeFileSync(fileOf(rel), content.replace(/\r\n/g, '\n').trimEnd() + '\n', 'utf8')
  invalidate()
  return `已新增页面: ${rel}`
}

function doPatch(args) {
  const rel = requirePath(args.path, 'patch')
  const page = loadPage(rel)
  if (page === undefined) throw new Error(`修改记忆失败：页面不存在: ${rel}`)
  const oldText = textOf(args.old_string)
  if (oldText === '') throw new Error('修改记忆失败：需要非空的 old_string，传入页面中待替换的原文片段。')
  if (args.new_string === undefined || args.new_string === null) throw new Error('修改记忆失败：需要 new_string；传入空字符串表示删除该片段。')
  const newText = textOf(args.new_string)
  const count = occurrences(page.text, oldText)
  if (count === 0) throw new Error('修改记忆失败：old_string 在页面中未找到匹配。请先 read 页面确认原文，再用准确片段重试。')
  if (count > 1) throw new Error(`修改记忆失败：old_string 在页面中匹配到 ${count} 处，需要唯一匹配。请带上更多上下文后重试。`)
  const index = page.text.indexOf(oldText)
  const next = page.text.slice(0, index) + newText + page.text.slice(index + oldText.length)
  writeFileSync(page.file, next.replace(/\r\n/g, '\n'), 'utf8')
  invalidate()
  return `已修改页面: ${rel}`
}

function doRemove(args) {
  const rel = requirePath(args.path, 'remove')
  const file = fileOf(rel)
  if (!existsSync(file)) throw new Error(`删除记忆失败：页面不存在: ${rel}`)
  rmSync(file, { force: true })
  invalidate()
  return `已删除页面: ${rel}`
}

/** 把 query 切成主题词：空白与常见中英文标点都是分隔符，去重去空。 */
function tokenizeQuery(query) {
  const parts = query.toLowerCase().split(/[\s,，、。;；:：\/\\|()（）\[\]【】「」“”"']+/)
  return [...new Set(parts.filter((part) => part !== ''))]
}

function doSearch(args) {
  const query = textOf(args.query).trim()
  if (query === '') throw new Error('搜索记忆失败：需要 query（主题词，不要用路径字符串）。')
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) throw new Error('搜索记忆失败：query 里没有可检索的主题词。')

  // 一页要同时命中所有词才算命中；标题命中权重最高，其次 summary，最后正文。
  const collect = (requireAll) => {
    const hits = []
    for (const entry of pageEntries()) {
      const page = loadPage(entry.rel)
      if (page === undefined) continue
      const text = page.text.toLowerCase()
      const title = textOf(page.fields.title).trim() || path.basename(page.rel)
      const summary = textOf(page.fields.summary).trim()
      const titleLower = title.toLowerCase()
      const summaryLower = summary.toLowerCase()
      let matched = 0
      let score = 0
      let firstIndex = -1
      for (const token of tokens) {
        const at = text.indexOf(token)
        if (at < 0) continue
        matched += 1
        score += 1
        if (titleLower.includes(token)) score += 4
        else if (summaryLower.includes(token)) score += 2
        if (firstIndex < 0 || at < firstIndex) firstIndex = at
      }
      if (matched === 0) continue
      if (requireAll && matched < tokens.length) continue
      hits.push({
        rel: page.rel,
        title,
        summary,
        matched,
        score,
        snippet: snippetAround(page.text, firstIndex, Math.max(1, tokens[0].length)),
        mtime: entry.mtime,
      })
    }
    return hits
  }

  let hits = collect(true)
  let note = ''
  if (hits.length === 0 && tokens.length > 1) {
    hits = collect(false)
    if (hits.length > 0) note = '\n（没有页面同时命中全部关键词，以下是命中部分关键词的）'
  }
  if (hits.length === 0) return `未找到匹配「${query}」的记忆页面。`
  hits.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  const lines = hits.slice(0, 20).map((hit, index) => {
    const label = tokens.length > 1 ? `命中 ${hit.matched}/${tokens.length} 词` : '命中'
    return `${index + 1}. ${hit.rel}「${hit.title}」\n   summary: ${hit.summary || '（无摘要）'}\n   ${label}: ${hit.snippet}`
  })
  const more = hits.length > 20 ? `\n（共命中 ${hits.length} 页，只列最近 20 页）` : ''
  return `命中 ${hits.length} 页：\n${lines.join('\n')}${note}${more}`
}

const ACTIONS = { read: doRead, add: doAdd, patch: doPatch, remove: doRemove, search: doSearch }
const ACTION_LIST = 'add / read / patch / remove / search'

// ── 面板接口 ─────────────────────────────────────────────────────────────────

function writePageContent(pathInput, contentInput) {
  const rel = requirePath(pathInput, 'write')
  const content = textOf(contentInput)
  if (content.trim() === '') throw new Error('保存失败：内容不能为空')
  const invalid = pageFormatError(content)
  if (invalid !== undefined) throw new Error(`保存失败：${invalid}`)
  mkdirSync(path.dirname(fileOf(rel)), { recursive: true })
  writeFileSync(fileOf(rel), content.replace(/\r\n/g, '\n').trimEnd() + '\n', 'utf8')
  invalidate()
  return rel
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(data === '' ? {} : JSON.parse(data))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function libraryView() {
  const settings = readSettings()
  const pages = snapshot()
    .pages.slice()
    .sort((a, b) => (a.isCore === b.isCore ? b.mtime - a.mtime : a.isCore ? -1 : 1))
    .map((page) => ({
      path: page.rel,
      category: categoryOf(page.rel),
      categoryLabel: categoryLabelOf(page.rel),
      title: page.title,
      summary: page.summary,
      sources: page.sources,
      related: page.related,
      chars: page.coreBody.length > 0 ? page.coreBody.length : 0,
      updated: new Date(page.mtime).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      core: page.isCore,
    }))
  const injected = renderSystem()
  const countOf = (category) => pages.filter((page) => page.category === category).length
  const categories = ['projects', 'concepts', 'lessons', 'profile', 'entities', 'raw'].map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    count: countOf(key),
  }))
  return {
    ok: true,
    root: ROOT,
    settings,
    defaults: { ...DEFAULT_SETTINGS },
    limits: SETTINGS_LIMITS,
    pages,
    categories,
    injected: { totalChars: injected.length, coreLimit: settings.coreChars, indexLimit: settings.indexChars },
    counts: {
      all: pages.filter((page) => !page.core).length,
      core: countOf('core'),
      wiki: pages.filter((page) => page.path.startsWith('wiki/')).length,
      raw: countOf('raw'),
    },
  }
}

function pagePayload(rel) {
  const page = loadPage(rel)
  if (page === undefined) throw new Error(`页面不存在: ${rel}`)
  return {
    path: rel,
    content: page.text,
    body: page.body,
    fields: {
      title: textOf(page.fields.title).trim(),
      summary: textOf(page.fields.summary).trim(),
      sources: Array.isArray(page.fields.sources) ? page.fields.sources : [],
      related: Array.isArray(page.fields.related) ? page.fields.related : [],
    },
    category: categoryOf(rel),
    categoryLabel: categoryLabelOf(rel),
    updated: page.updated,
  }
}

function registerRoutes(ctx) {
  const register = (pathName, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: pathName,
        handler: async (req, res) => {
          try {
            const connection = ctx.get('connection')
            const rejection =
              connection && typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : undefined
            if (rejection !== undefined && rejection !== null) {
              res.statusCode = rejection
              res.end()
              return
            }
            const url = new URL(req.url, 'http://localhost')
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            sendJson(res, 200, { ok: true, ...(await handler({ url, body })) })
          } catch (error) {
            sendJson(res, 200, { ok: false, message: String(error?.message || error) })
          }
        },
      }),
    )

  register('/memory-book/library', async () => libraryView())

  register('/memory-book/page', async ({ url, body }) => {
    if (body.path !== undefined) {
      const rel = requirePath(body.path, 'write')
      if (body.content !== undefined) {
        writePageContent(rel, body.content)
        return { path: rel, message: `已保存: ${rel}` }
      }
      return pagePayload(rel)
    }
    return pagePayload(requirePath(url.searchParams.get('path') || '', 'read'))
  })

  register('/memory-book/settings', async ({ body }) => {
    if (body.reset === true) {
      resetSettings()
      return { ...settingsPayload(), message: '已恢复默认' }
    }
    if (body.coreChars !== undefined || body.indexChars !== undefined || body.pagesPerDir !== undefined) {
      saveSettings(body)
      return { ...settingsPayload(), message: '已保存' }
    }
    return settingsPayload()
  })

  register('/memory-book/delete', async ({ body }) => {
    const rel = requirePath(body.path, 'remove')
    if (!existsSync(fileOf(rel))) throw new Error(`页面不存在: ${rel}`)
    rmSync(fileOf(rel), { force: true })
    invalidate()
    return { path: rel, message: `已删除: ${rel}` }
  })

  register('/memory-book/search', async ({ url }) => {
    const query = (url.searchParams.get('q') || '').trim()
    if (query === '') throw new Error('需要检索词')
    const needle = query.toLowerCase()
    const hits = []
    for (const entry of pageEntries()) {
      const page = loadPage(entry.rel)
      if (page === undefined) continue
      const index = page.text.toLowerCase().indexOf(needle)
      if (index < 0) continue
      hits.push({
        path: page.rel,
        title: textOf(page.fields.title).trim() || path.basename(page.rel),
        summary: textOf(page.fields.summary).trim(),
        snippet: snippetAround(page.text, index, query.length),
      })
    }
    return { hits: hits.slice(0, 30), total: hits.length }
  })
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // 有自定义工具卡（TOOL.md）的实例：参数说明精简，细节交给记忆页。
  const terse = () => hasToolOverride()
  const attached = new Map()
  // 程序化创建的 agent 可能没有 agent.ctx；此时退回根作用域的注入段（同一实例内共享）。
  let rootSection = null
  let rootUsers = 0

  const attach = (agent) => {
    const id = agent?.id
    if (!id || attached.has(id)) return
    const agentCtx = agent?.ctx
    const scoped = agentCtx && agentCtx.systemPrompt
    if (scoped !== undefined && scoped !== null && typeof scoped.section === 'function') {
      let dispose
      try {
        dispose = scoped.section({ name: 'memory:system', order: 700, text: () => renderSystem() })
      } catch {
        return
      }
      attached.set(id, dispose)
      return
    }
    if (ctx.systemPrompt === undefined || typeof ctx.systemPrompt.section !== 'function') return
    if (rootSection === null) {
      try {
        rootSection = ctx.systemPrompt.section({ name: 'memory:system', order: 700, text: () => renderSystem() })
      } catch {
        return
      }
    }
    rootUsers += 1
    attached.set(id, () => {
      rootUsers = Math.max(0, rootUsers - 1)
      if (rootUsers === 0 && rootSection !== null) {
        try {
          rootSection()
        } catch {
          // 忽略。
        }
        rootSection = null
      }
    })
  }

  const detach = (sessionId) => {
    const dispose = attached.get(sessionId)
    if (dispose === undefined) return
    attached.delete(sessionId)
    try {
      dispose()
    } catch {
      // 忽略单次释放失败。
    }
  }

  // 插件卸载/升级时释放仍在注册的注入段，避免旧版本段落残留在 agent 上。
  ctx.effect(() => () => {
    for (const dispose of attached.values()) {
      try {
        dispose()
      } catch {
        // 忽略。
      }
    }
    attached.clear()
    if (rootSection !== null) {
      try {
        rootSection()
      } catch {
        // 忽略。
      }
      rootSection = null
      rootUsers = 0
    }
  })

  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => detach(agent?.id))
  for (const agent of ctx.agents.list()) attach(agent)

  registerRoutes(ctx)

  // 参数定义只有这一份：注册 schema 与「拒绝未知参数」共用，避免两处不同步。
  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'brief'],
    properties: {
      action: { type: 'string', enum: ['read', 'add', 'patch', 'remove', 'search'], description: terse() ? '动作' : `操作类型：${ACTION_LIST}。` },
      brief: { type: 'string', description: terse() ? '一句话目的（必填）' : '一句话描述此次操作的目的。' },
      path: {
        type: 'string',
        description: terse()
          ? '记忆页路径，不带 .md；例如 wiki/concepts/记忆工具用法'
          : '页面路径，不含 .md 后缀。形如 core/核心记忆、wiki/projects/某项目、raw/某来源；'
            + 'core 路径固定不可更改。add / read / patch / remove 必填。',
      },
      content: {
        type: 'string',
        description: terse() ? '' : 'add 时必填：完整页面内容，含 frontmatter（title 与 summary 必填）。',
      },
      old_string: {
        type: 'string',
        description: terse() ? '' : 'patch 时必填：待替换的原文片段，须与页面中的内容完全一致且唯一匹配。',
      },
      new_string: {
        type: 'string',
        description: terse() ? '' : 'patch 时必填：替换文本；传空字符串表示删除该片段。',
      },
      query: {
        type: 'string',
        description: terse() ? '' : 'search 时的检索关键词，用主题词（项目名、功能名、术语），不要用路径字符串。',
      },
    },
  }
  const allowedParams = Object.keys(parameters.properties)

  ctx.tools.register({
    name: 'memory',
    description: toolDescription(),
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(callArgs) {
      const args = callArgs === undefined || callArgs === null ? {} : callArgs
      // 严格校验：不认识参数名就拒，不静默忽略（否则参数丢失后会报成「缺某参数」，误导排查方向）。
      const unknown = Object.keys(args).filter((key) => !Object.hasOwn(parameters.properties, key))
      if (unknown.length > 0) {
        throw new Error(`未知参数：${unknown.map((key) => `「${key}」`).join('')}。可用参数：${allowedParams.join('、')}。`)
      }
      const action = textOf(args.action)
      const handler = ACTIONS[action]
      if (handler === undefined) throw new Error(`未知的 action: ${action}。合法值为 ${ACTION_LIST}。`)
      return { message: handler(args) }
    },
  })
}
