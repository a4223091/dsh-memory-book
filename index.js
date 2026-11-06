/**
 * Host half of memory-book（记忆）v0.13.0：按项目独立的本地记忆。
 *
 * 三层记忆：
 * - 全局库：`$DSH_HOME/memory/`（默认 `%USERPROFILE%\.dsh\memory\`），放跨项目内容；
 * - 主项目：会话所属工作区文件夹下的 `.memory-book/`，任何情况下都注入；
 * - 临时项目：当前工作目录所属、且与主项目不同的项目，只在 cd 到别的项目时追加注入。
 *
 * 项目库除普通页（core/wiki/raw）外还有 7 类固定文档（project/ 下）：说明及目标、策划、
 * 计划、状态、交接、决策历史、项目经验。版本化文档每次 record 新增版本、旧版本保留但不进索引。
 *
 * - `memory` 工具：read / add / patch / remove / search / put / record / history，
 *   带 scope（current/main/global）与 doc / based_on。
 * - 每轮注入：主项目 core + 索引 + 固定文档清单；全局 core + 索引；临时项目 core + 索引（+ 清单提示）。
 * - 引擎强制维护：监听回合事件，用 `agent.followup(createUserMessage(...))` 追加一轮补更。
 * - 面板接口：/memory-book/{projects,library,page,delete,search,settings,history,resolve}。
 *
 * 写保护：先读再写（read 记 mtime）+ mtime 乐观锁 + based_on 比较并交换 + 原子写 + 进程内写锁。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

export const name = 'memory-book'
export const inject = ['tools', 'systemPrompt', 'agents', 'webServer']

/** 全局记忆库根目录：跟随 DSH_HOME，不同实例自动隔离。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const GLOBAL_ROOT = path.join(DSH_HOME, 'memory')
/** L1 核心记忆：单文件，路径不可更改。 */
const CORE = 'core/核心记忆'
/** L2 知识层的五个子目录。 */
const WIKI_SUBS = ['projects', 'concepts', 'lessons', 'profile', 'entities']
/** 页面名字符集（与灵犀一致）：字母、数字、中文、点、下划线、连字符。 */
const PAGE_NAME = /^[\p{L}\p{N}._-]{1,64}$/u
/** 版本页文件名：YYYYMMDD-HHmm，同分钟冲突加 -2、-3。 */
const VERSION_RE = /^\d{8}-\d{4}(?:-\d+)?$/
/** 全局一份配置（注入预算 + 维护节奏 + 自动补更开关）。 */
const SETTINGS_FILE = path.join(GLOBAL_ROOT, 'settings.json')
const CACHE_TTL_MS = 1000
/** 项目固定文档：说明及目标（单文件，正文 ≤2000 字）。 */
const BRIEF_PATH = 'project/说明及目标'
const BRIEF_CHAR_LIMIT = 2000
/** 项目经验目录（同类型一个页面，全量覆盖）。 */
const EXPERIENCE_DIR = 'project/经验'

/** 7 类固定文档：brief 单文件，其余 versioned 每次新增版本；项目经验单独用 type 页承载。 */
const DOC_DEFS = [
  { doc: 'brief', name: '说明及目标', versioned: false },
  { doc: 'planning', name: '策划', versioned: true },
  { doc: 'plan', name: '计划', versioned: true },
  { doc: 'status', name: '状态', versioned: true },
  { doc: 'handover', name: '交接', versioned: true },
  { doc: 'decisions', name: '决策历史', versioned: true },
]
const DOC_BY_KEY = new Map(DOC_DEFS.map((def) => [def.doc, def]))
const DOC_BY_NAME = new Map(DOC_DEFS.map((def) => [def.name, def]))
const VERSIONED_DOC_NAMES = DOC_DEFS.filter((def) => def.versioned).map((def) => def.name)

/** 面板配置项默认值：7 项注入预算 + 2 项维护节奏 + 自动补更开关。 */
const DEFAULT_SETTINGS = {
  coreChars: 1200,
  mainCoreChars: 3000,
  transientCoreChars: 800,
  indexChars: 1000,
  mainIndexChars: 2500,
  transientIndexChars: 1200,
  pagesPerDir: 8,
  fallbackRounds: 5,
  handoverChanges: 5,
  autoFollowup: true,
}

/** 面板配置项的合法范围（与 readSettings 的钳制一致；布尔项单列）。 */
const SETTINGS_LIMITS = {
  coreChars: [300, 8000],
  mainCoreChars: [300, 12000],
  transientCoreChars: [0, 4000],
  indexChars: [200, 6000],
  mainIndexChars: [200, 8000],
  transientIndexChars: [0, 6000],
  pagesPerDir: [1, 50],
  fallbackRounds: [1, 50],
  handoverChanges: [1, 50],
  autoFollowup: 'boolean',
}

const CATEGORY_LABELS = {
  projects: '项目',
  concepts: '概念',
  lessons: '经验',
  profile: '用户画像',
  entities: '实体',
  raw: '源文件索引',
}

/** 工具动作：原有 5 个 + 固定文档专用 3 个。 */
const ACTIONS = {}
const ACTION_LIST = 'read / add / patch / remove / search / put / record / history'
const MEMORY_WRITE_ACTIONS = new Set(['add', 'patch', 'remove', 'put', 'record'])
/** 有实质变化时可能要强制补更的文档（中文名，给模型看）。 */
const PLANISH_DOCS = new Set(['策划', '计划', '交接'])
/** 宿主上下文（apply 时注入；模块内所有解析都通过它做特性检测）。 */
let HOST = null

// ── 基础工具 ─────────────────────────────────────────────────────────────────

function textOf(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

/** 安全地取可选服务：宿主没装该插件时返回 undefined，而不是抛错。 */
function safeGet(name) {
  try {
    if (HOST === null) return undefined
    const get = HOST.get
    if (typeof get !== 'function') return undefined
    return get.call(HOST, name)
  } catch {
    return undefined
  }
}

function invalidate(root) {
  if (root === undefined) snapshotCache.clear()
  else snapshotCache.delete(root.toLowerCase())
}

/** 读取全局配置（唯一一份；损坏或缺失时回落默认值）。 */
function readSettings() {
  const clamp = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, Math.round(parsed)))
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
    const next = { ...DEFAULT_SETTINGS }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'autoFollowup') {
        next[key] = raw[key] === undefined ? DEFAULT_SETTINGS[key] : raw[key] !== false && raw[key] !== 'false'
        continue
      }
      const [min, max] = SETTINGS_LIMITS[key]
      next[key] = clamp(raw[key], DEFAULT_SETTINGS[key], min, max)
    }
    return next
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** 面板配置视图用：当前值 + 默认值 + 合法范围。 */
function settingsPayload() {
  return { settings: readSettings(), defaults: { ...DEFAULT_SETTINGS }, limits: SETTINGS_LIMITS }
}

/** 保存配置：只接受已知项，逐个钳制到合法范围，写全局 settings.json。 */
function saveSettings(input) {
  const next = { ...readSettings() }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (input[key] === undefined) continue
    if (key === 'autoFollowup') {
      next[key] = input[key] !== false && input[key] !== 'false'
      continue
    }
    const [min, max] = SETTINGS_LIMITS[key]
    const parsed = Number(input[key])
    if (Number.isFinite(parsed)) next[key] = Math.min(max, Math.max(min, Math.round(parsed)))
  }
  mkdirSync(GLOBAL_ROOT, { recursive: true })
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

/** 组装 frontmatter（值里的换行压成空格；空值字段跳过）。 */
function frontmatterText(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    const text = textOf(value).replace(/\s+/g, ' ').trim()
    if (text === '') continue
    lines.push(`${key}: ${text}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/** 正文首行截断，作为自动生成的 summary。 */
function firstLineSummary(body) {
  const line = textOf(body)
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item !== '')
  if (line === undefined) return '（空）'
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** 按字符（码点）计「字数」，中文一个字算一个。 */
function charCount(text) {
  return Array.from(textOf(text)).length
}

/** 页面标题：frontmatter title 优先，其次文件名。 */
function titleOfPage(page) {
  const title = textOf(page.fields.title).trim()
  return title !== '' ? title : path.basename(page.rel)
}

/** 原子写：先写同目录临时文件，再 rename 覆盖；失败时清理临时文件。 */
function atomicWriteFile(file, content) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(temp, content, 'utf8')
  try {
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error
  }
}

/** 进程内按文件写锁：同一页面同时只允许一个写入操作。 */
const writeLocks = new Set()

function withWriteLock(file, job) {
  const key = file.toLowerCase()
  if (writeLocks.has(key)) throw new Error('该页面正在被另一个写入操作占用，请稍后重试。')
  writeLocks.add(key)
  try {
    return job()
  } finally {
    writeLocks.delete(key)
  }
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
  // 项目固定文档：说明及目标 / 经验/<类型> / <文档名>/<版本>
  if (parts.length === 2 && parts[0] === 'project' && parts[1] === '说明及目标') return raw
  if (parts.length === 3 && parts[0] === 'project' && parts[1] === '经验' && PAGE_NAME.test(parts[2])) return raw
  if (parts.length === 3 && parts[0] === 'project' && VERSIONED_DOC_NAMES.includes(parts[1]) && VERSION_RE.test(parts[2])) {
    return raw
  }
  return undefined
}

/** 判断一个路径是不是固定文档；返回分类信息供各动作做限制。 */
function fixedKindOf(rel) {
  if (typeof rel !== 'string') return undefined
  if (rel === BRIEF_PATH) return { kind: 'brief', label: '说明及目标', doc: 'brief' }
  const parts = rel.split('/')
  if (parts.length === 3 && parts[0] === 'project' && parts[1] === '经验' && PAGE_NAME.test(parts[2])) {
    return { kind: 'experience', label: `项目经验/${parts[2]}`, type: parts[2] }
  }
  if (parts.length === 3 && parts[0] === 'project') {
    const def = DOC_BY_NAME.get(parts[1])
    if (def !== undefined && def.versioned && VERSION_RE.test(parts[2])) {
      return { kind: 'version', label: def.name, doc: def.doc, name: def.name, version: parts[2] }
    }
  }
  return undefined
}

/** 构造库描述：全局库或某个项目库。 */
function makeGlobalStore() {
  return { kind: 'global', title: '全局记忆库', folder: '', memoryRoot: GLOBAL_ROOT, root: GLOBAL_ROOT }
}

function makeProjectStore(folder, title, workspaceId) {
  const memoryRoot = path.join(folder, '.memory-book')
  return {
    kind: 'project',
    title: title || path.basename(folder),
    folder,
    memoryRoot,
    root: memoryRoot,
    workspaceId,
  }
}

function fileOf(rel, store) {
  return path.join(store.root, ...rel.split('/')) + '.md'
}

/** 枚举普通页面（core + wiki + raw）；固定文档不进普通索引。 */
function pageEntries(store) {
  const out = []
  const push = (rel) => {
    const file = fileOf(rel, store)
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
      names = readdirSync(path.join(store.root, 'wiki', sub))
    } catch {
      names = []
    }
    for (const entry of names) {
      if (entry.endsWith('.md')) push(`wiki/${sub}/${entry.slice(0, -3)}`)
    }
  }
  let rawNames = []
  try {
    rawNames = readdirSync(path.join(store.root, 'raw'))
  } catch {
    rawNames = []
  }
  for (const entry of rawNames) {
    if (entry.endsWith('.md')) push(`raw/${entry.slice(0, -3)}`)
  }
  return out
}

function loadPage(rel, store) {
  const file = fileOf(rel, store)
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
    mtime: stat.mtimeMs,
    updated: new Date(stat.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

/** 目录索引用的轻量快照（按库缓存 1 秒，避免每轮重复读文件）。 */
const snapshotCache = new Map()

function snapshotFor(store) {
  const key = store.root.toLowerCase()
  const now = Date.now()
  const cached = snapshotCache.get(key)
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.value
  const pages = []
  for (const entry of pageEntries(store)) {
    const page = loadPage(entry.rel, store)
    if (page === undefined) continue
    pages.push({
      rel: page.rel,
      file: page.file,
      mtime: entry.mtime,
      title: titleOfPage(page),
      summary: textOf(page.fields.summary).trim(),
      sources: Array.isArray(page.fields.sources) ? page.fields.sources : [],
      related: Array.isArray(page.fields.related) ? page.fields.related : [],
      isCore: page.rel === CORE,
      coreBody: page.rel === CORE ? page.body : '',
      bodyChars: charCount(page.body),
    })
  }
  const value = { pages }
  snapshotCache.set(key, { value, at: now })
  return value
}

function categoryOf(rel) {
  if (rel === CORE) return 'core'
  if (rel.startsWith('wiki/')) return rel.split('/')[1]
  if (rel.startsWith('raw/')) return 'raw'
  if (rel.startsWith('project/')) return 'project'
  return 'other'
}

function categoryLabelOf(rel) {
  if (rel === CORE) return '核心记忆'
  if (rel.startsWith('project/')) return '项目文档'
  return CATEGORY_LABELS[categoryOf(rel)] || '其他'
}

function indexLine(item) {
  const name = path.basename(item.rel)
  const label = item.title !== '' && item.title !== name ? `${item.title}：` : ''
  return `    ${item.rel}  —  ${label}${item.summary || '（无摘要）'}`
}

/** 渲染索引文本，按预算截断（附提示，不静默丢）。 */
function renderIndexText(pages, budget) {
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
  if (text.length > budget) {
    const cut = text.slice(0, budget)
    const lastBreak = cut.lastIndexOf('\n')
    text = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut) + '\n（索引超出预算已截断，用 memory search 查未列出的页面）'
  }
  return text
}

/** 渲染 core 正文，按预算截断。 */
function renderCoreText(pages, budget) {
  const core = pages.find((page) => page.isCore)
  let text = core === undefined ? '（还没建核心记忆）' : core.coreBody.trim()
  if (core !== undefined && text === '') text = '（核心记忆正文为空）'
  if (text.length > budget) text = text.slice(0, budget) + '\n…（超出预算，已截断）'
  return text
}

// ── 项目解析 ─────────────────────────────────────────────────────────────────

/** realpath 规范化；不存在时按绝对路径规范化（Windows 下忽略大小写比较）。 */
function normalizeDir(dir) {
  const resolved = path.resolve(textOf(dir))
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function sameDir(left, right) {
  return normalizeDir(left).toLowerCase() === normalizeDir(right).toLowerCase()
}

/** 祖先判断：相等，或以 `\`/`/` 结尾的前缀（避免 C:\ab 命中 C:\abc）。 */
function isAncestor(parent, child) {
  const a = normalizeDir(parent).toLowerCase().replace(/[\\/]+$/, '')
  const b = normalizeDir(child).toLowerCase().replace(/[\\/]+$/, '')
  if (a === b) return true
  return b.startsWith(a + path.sep) || b.startsWith(a + '/')
}

function listWorkspaces() {
  const registry = safeGet('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    const list = registry.list()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function workspaceById(id) {
  const registry = safeGet('workspaceRegistry')
  if (registry !== undefined && typeof registry.get === 'function') {
    try {
      const found = registry.get(id)
      if (found !== undefined) return found
    } catch {
      // 回落 list 查找。
    }
  }
  return listWorkspaces().find((workspace) => workspace?.id === id)
}

function workspaceBySession(sessionId) {
  for (const workspace of listWorkspaces()) {
    if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace
  }
  return undefined
}

/** 找到目录所属（最长祖先）的工作区。 */
function workspaceForPath(dir) {
  if (dir === undefined || dir === null || textOf(dir) === '') return undefined
  let best
  let bestLength = -1
  for (const workspace of listWorkspaces()) {
    const workspacePath = workspace?.path
    if (textOf(workspacePath) === '') continue
    if (!isAncestor(workspacePath, dir)) continue
    const length = normalizeDir(workspacePath).length
    if (length > bestLength) {
      best = workspace
      bestLength = length
    }
  }
  return best
}

function storeOfWorkspace(workspace) {
  return makeProjectStore(workspace.path, workspace.title, workspace.id)
}

/** 会话对象：agent.session 优先，其次会话存储（兼容程序化创建的 agent）。 */
function sessionOf(agent) {
  if (agent === undefined || agent === null) return undefined
  try {
    if (agent.session !== undefined && agent.session !== null) return agent.session
  } catch {
    // 特性探测失败时回落 sessions 服务。
  }
  const sessions = safeGet('sessions')
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      return sessions.get(agent.id)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** 会话当前工作目录（等价于会话里的 cd 结果）；拿不到时回落创建目录。 */
function currentDirOf(session) {
  if (session === undefined || session === null) return undefined
  const workingDirectory = safeGet('workingDirectory')
  if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
    try {
      const dir = workingDirectory.get(session)
      if (textOf(dir) !== '') return dir
    } catch {
      // 回落 header.cwd。
    }
  }
  const header = session.header
  return header !== undefined && textOf(header.cwd) !== '' ? header.cwd : undefined
}

/** 主项目缓存：agent/created 时算一次，agent/disposed 清理（不随 cd 变化）。 */
const primaryCache = new Map()

function computePrimary(agent) {
  if (agent === undefined || agent === null) return undefined
  const workspace = workspaceBySession(agent.id)
  if (workspace !== undefined) return storeOfWorkspace(workspace)
  const session = sessionOf(agent)
  const cwd = currentDirOf(session) || session?.header?.cwd
  if (textOf(cwd) !== '') {
    const byPath = workspaceForPath(cwd)
    if (byPath !== undefined) return storeOfWorkspace(byPath)
  }
  return undefined
}

function primaryProject(agent) {
  if (agent === undefined || agent === null) return undefined
  if (primaryCache.has(agent.id)) return primaryCache.get(agent.id)
  const store = computePrimary(agent)
  primaryCache.set(agent.id, store)
  return store
}

/** 从目录向上找最近的已有 `.memory-book` 的祖先目录。 */
function memoryAncestorOf(dir) {
  let current = path.resolve(textOf(dir))
  for (;;) {
    try {
      if (statSync(path.join(current, '.memory-book')).isDirectory()) return current
    } catch {
      // 继续向上。
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** 临时项目：当前目录所属、且与主项目不同的项目；没有主项目时不产生临时项目。 */
function transientProject(agent) {
  const primary = primaryProject(agent)
  if (primary === undefined) return undefined
  const session = sessionOf(agent)
  return transientProjectFrom(primary, currentDirOf(session))
}

/** 按「主项目 + 当前目录」算临时项目（agent 与面板接口共用）。 */
function transientProjectFrom(primary, cwd) {
  if (primary === undefined || textOf(cwd) === '') return undefined
  const cwdNorm = normalizeDir(cwd)

  let best
  let bestLength = -1
  // 候选一：当前目录所属的工作区。
  for (const workspace of listWorkspaces()) {
    const workspacePath = workspace?.path
    if (textOf(workspacePath) === '') continue
    if (!isAncestor(workspacePath, cwdNorm)) continue
    const length = normalizeDir(workspacePath).length
    if (length > bestLength) {
      best = storeOfWorkspace(workspace)
      bestLength = length
    }
  }
  // 候选二：从当前目录向上找到的已有 .memory-book 目录（更具体者优先）。
  const ancestor = memoryAncestorOf(cwd)
  if (ancestor !== undefined) {
    const length = normalizeDir(ancestor).length
    if (length > bestLength) {
      const workspace = workspaceForPath(ancestor)
      // 只有工作区根正好等于该目录时才用它登记的标题；嵌套目录用文件夹名。
      const title = workspace !== undefined && sameDir(workspace.path, ancestor) ? workspace.title : path.basename(ancestor)
      best = makeProjectStore(ancestor, title, workspace !== undefined && sameDir(workspace.path, ancestor) ? workspace.id : undefined)
      bestLength = length
    }
  }
  if (best === undefined) return undefined
  if (sameDir(best.folder, primary.folder)) return undefined
  return best
}

/** 按会话 id 算主项目（面板接口用；会话不必是活 agent）。 */
function primaryStoreForSessionId(sessionId) {
  const id = textOf(sessionId).trim()
  if (id === '') return undefined
  const workspace = workspaceBySession(id)
  if (workspace !== undefined) return storeOfWorkspace(workspace)
  const sessions = safeGet('sessions')
  let session
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      session = sessions.get(id)
    } catch {
      session = undefined
    }
  }
  const cwd = currentDirOf(session) || session?.header?.cwd
  if (textOf(cwd) !== '') {
    const byPath = workspaceForPath(cwd)
    if (byPath !== undefined) return storeOfWorkspace(byPath)
  }
  return undefined
}

/** 面板接口用：按 sessionId 求临时项目（当前目录属于另一个项目时才有）。 */
function transientForSessionId(sessionId) {
  const primary = primaryStoreForSessionId(sessionId)
  if (primary === undefined) return undefined
  const sessions = safeGet('sessions')
  let session
  if (sessions !== undefined && typeof sessions.get === 'function') {
    try {
      session = sessions.get(textOf(sessionId).trim())
    } catch {
      session = undefined
    }
  }
  return transientProjectFrom(primary, currentDirOf(session))
}

/** 面板 scope 字段：库的展示信息（/library、/projects、transient 共用）。 */
function scopePayloadOf(store) {
  return {
    kind: store.kind,
    title: store.kind === 'global' ? '全局记忆库' : store.title,
    path: store.kind === 'global' ? store.root : store.folder,
    memoryRoot: store.root,
    ...(store.kind === 'project' && store.workspaceId !== undefined ? { workspaceId: store.workspaceId } : {}),
  }
}

/** 注入/工具都要用：主项目文件夹必须存在，否则视为没有该项目。 */
function livePrimary(agent) {
  const store = primaryProject(agent)
  if (store === undefined) return undefined
  try {
    if (!statSync(store.folder).isDirectory()) return undefined
  } catch {
    return undefined
  }
  return store
}

function liveTransient(agent) {
  const store = transientProject(agent)
  if (store === undefined) return undefined
  try {
    if (!statSync(store.folder).isDirectory()) return undefined
  } catch {
    return undefined
  }
  return store
}

/** 项目库首次写入时建目录并写 `.gitignore`（内容 `*`：默认整个记忆库不进 git）。 */
function ensureProjectRoot(store) {
  mkdirSync(store.root, { recursive: true })
  const ignore = path.join(store.root, '.gitignore')
  if (!existsSync(ignore)) {
    try {
      writeFileSync(ignore, '*\n', 'utf8')
    } catch {
      // 写不进去不影响记忆写入。
    }
  }
}

/** 全局库没有固定文档：路径限制在这里统一拦。 */
function assertPathAllowed(rel, store) {
  const fixed = fixedKindOf(rel)
  if (fixed !== undefined && store.kind === 'global') {
    throw new Error('全局记忆库没有项目固定文档；固定文档请用 scope=current 或 scope=main。')
  }
}

function storeLabel(store) {
  return store.kind === 'global' ? '[全局] ' : `[项目 ${store.title}] `
}

// ── 固定文档 ─────────────────────────────────────────────────────────────────

function versionDirOf(store, def) {
  return path.join(store.root, 'project', def.name)
}

function listVersionEntries(store, def) {
  let names = []
  try {
    names = readdirSync(versionDirOf(store, def))
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.endsWith('.md')) continue
    const version = entry.slice(0, -3)
    if (!VERSION_RE.test(version)) continue
    const rel = `project/${def.name}/${version}`
    const page = loadPage(rel, store)
    if (page === undefined) continue
    out.push({
      rel,
      version,
      title: titleOfPage(page),
      summary: textOf(page.fields.summary).trim(),
      updated: page.updated,
      chars: charCount(page.body),
    })
  }
  return out.sort((a, b) => b.version.localeCompare(a.version))
}

/** 固定文档全量状态（面板 / 注入共用）。 */
function docsState(store) {
  const docs = []
  for (const def of DOC_DEFS) {
    if (!def.versioned) {
      const page = loadPage(BRIEF_PATH, store)
      docs.push({
        doc: def.doc,
        label: def.name,
        missing: page === undefined,
        latestPath: page?.rel,
        latestTitle: page === undefined ? undefined : titleOfPage(page),
        updated: page?.updated,
        versions: 0,
        chars: page === undefined ? 0 : charCount(page.body),
      })
      continue
    }
    const versions = listVersionEntries(store, def)
    const latest = versions[0]
    docs.push({
      doc: def.doc,
      label: def.name,
      missing: latest === undefined,
      latestPath: latest?.rel,
      latestTitle: latest?.title,
      updated: latest?.updated,
      versions: versions.length,
      chars: latest?.chars ?? 0,
    })
  }
  return { docs, experiences: experienceEntries(store) }
}

function experienceEntries(store) {
  let names = []
  try {
    names = readdirSync(path.join(store.root, 'project', '经验'))
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.endsWith('.md')) continue
    const type = entry.slice(0, -3)
    if (!PAGE_NAME.test(type)) continue
    const rel = `${EXPERIENCE_DIR}/${type}`
    const page = loadPage(rel, store)
    if (page === undefined) continue
    out.push({ type, path: rel, title: titleOfPage(page), updated: page.updated })
  }
  return out
}

function latestVersionOf(store, def) {
  return listVersionEntries(store, def)[0]
}

/** 本地时间版本号：YYYYMMDD-HHmm，同分钟冲突加 -2、-3。 */
function nextVersionName(store, def) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  let candidate = base
  let suffix = 2
  while (existsSync(path.join(versionDirOf(store, def), `${candidate}.md`))) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

/** 注入里的固定文档清单（含缺失 / 陈旧提示，不列历史版本）。 */
function renderDocsText(store, agentId, enforce = true) {
  const settings = readSettings()
  const { docs, experiences } = docsState(store)
  const state = agentId === undefined || !enforce ? undefined : engineStates.get(agentId)
  const lines = ['固定文档（引擎管理，不允许删除，可手改）：']
  for (const def of DOC_DEFS) {
    const doc = docs.find((item) => item.doc === def.doc)
    if (def.doc === 'brief') {
      if (doc.missing) lines.push(`- 说明及目标 ${BRIEF_PATH} 未创建 ⚠ 必须创建`)
      else lines.push(`- 说明及目标 ${BRIEF_PATH}（当前 ${doc.chars}/${BRIEF_CHAR_LIMIT} 字）`)
      continue
    }
    if (doc.missing) {
      lines.push(`- ${def.name} 未创建 ⚠ 必须创建`)
      continue
    }
    const history = doc.versions > 1 ? `，另有 ${doc.versions - 1} 个历史版本` : ''
    const staleCount =
      def.doc === 'status'
        ? (state?.changesSinceStatus ?? 0)
        : def.doc === 'handover'
          ? (state?.changesSinceHandover ?? 0)
          : 0
    // 状态：每次实质变化都该更新；交接：达到 handoverChanges 才提示（否则只是进度）。
    const stale =
      def.doc === 'handover'
        ? staleCount >= settings.handoverChanges
          ? `，已 ${staleCount}/${settings.handoverChanges} 次实质变化 ⚠ 需要更新`
          : staleCount > 0
            ? `，已 ${staleCount}/${settings.handoverChanges} 次实质变化`
            : ''
        : staleCount >= 1
          ? `，已 ${staleCount} 次实质变化未更新 ⚠ 需要更新`
          : ''
    lines.push(`- ${def.name} 最新 ${doc.latestPath}${history}${stale}`)
  }
  if (experiences.length === 0) {
    lines.push('- 项目经验 未创建 ⚠ 建议把踩过的坑写成经验页')
  } else {
    lines.push(`- 项目经验 ${experiences.length} 个类型：${experiences.map((item) => item.path).join('、')}`)
  }
  lines.push('旧版本不列索引：用 memory action=history 查看，再 memory read 读取。')
  if (state !== undefined && settings.autoFollowup) {
    lines.push('引擎会在检测到实质变化后强制追加一轮补更，请按提示更新对应文档。')
  }
  return lines.join('\n')
}

/** 缺失的固定文档（给引擎触发补更用；项目经验不算“必须创建”）。 */
function missingFixedDocLabels(store) {
  if (store === undefined) return []
  const { docs } = docsState(store)
  const labels = []
  for (const doc of docs) {
    if (doc.missing) labels.push(doc.label)
  }
  return labels
}

// ── 注入内容 ─────────────────────────────────────────────────────────────────

/** 实例是否提供了自定义工具卡（TOOL.md）：有则参数说明走精简版。 */
function hasToolOverride() {
  try {
    return existsSync(path.join(GLOBAL_ROOT, 'TOOL.md'))
  } catch {
    return false
  }
}

/** 模型可见的 memory 工具说明：实例可用 <全局库>/TOOL.md 覆盖，不存在则用默认。 */
function toolDescription() {
  try {
    const file = path.join(GLOBAL_ROOT, 'TOOL.md')
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim()
      if (text !== '') return text
    }
  } catch {
    // 读失败用默认。
  }
  return [
    '管理按项目独立的本地长期记忆（全局库 + 主项目库 + 临时项目库），页面路径不是文件路径。',
    '每个库都分三层：core/核心记忆（单文件，每轮全文注入）、wiki/ 知识层（每轮只注入目录索引）、raw/ 来源凭证。',
    `action 必填，取值为 ${ACTION_LIST}；brief 必填，一句话说明本次操作目的。`,
    '普通页：read 读整页（返回 frontmatter 与 updated）；add 新建（content 传整页含 frontmatter，不覆盖已有页面）；',
    'patch 局部替换（old_string 须非空且唯一匹配）；remove 删除整页；search 按主题词检索（多词需同时命中，可退回部分命中）。',
    '固定文档（项目库 project/ 下）：put 全量覆盖「说明及目标」或「项目经验/<类型>」；版本化文档（策划/计划/状态/交接/决策历史）用 record 新增版本',
    '（doc 必填，必须带 based_on=上一版本路径，首个版本传空字符串）；history 列版本（新→旧）。参数与路径请严格按 actions 说明填写。',
    'scope 选库：current（默认，当前项目：有临时项目就是临时项目，否则主项目）、main（主项目，不受 cd 影响）、global（全局库）。',
    '先读再写（引擎强制）：patch / put / record 前必须在本次会话 read 过目标页（record 要读过最新版本），',
    '读取后页面又被改过（mtime 变了）会被拒绝；record 的 based_on 不是最新版会被拒绝（防并发覆盖）。',
    '固定文档不允许删除；历史版本只读；add/remove 不能用于固定页。说明及目标正文上限 2000 字，超限会被拒绝并回报字数。',
    '固定文档只有 Lead 能写；队友写项目经验页与普通页，完成后把路径回报 Lead。',
    '写入纪律：更新时删掉过时内容（旧方案、旧结论、失效路径直接删除）；不写临时状态、未验证猜测、敏感凭证。',
    '用户说「沉淀/整理记忆」时：用 session_event_search / session_event_read 回取本次会话的关键片段（用户纠正、关键决策、失败原因），提炼 0–3 条后按分层写入（短规则→core，主题知识→wiki，外部来源→raw，固定文档按维护规则写），不要生成中间证据文件。',
    '记忆候选：用户的偏好与纠正、外部资料的结论、多轮试错后找到的方案、可复用的流程与配置；不写流水账。',
  ].join('')
}

/** 组装注入文本；全空返回空串（零注入）。 */
function renderInjection({ primary, transient, agentId, notice }) {
  const settings = readSettings()
  const globalStore = makeGlobalStore()
  const globalPages = snapshotFor(globalStore).pages
  const primaryPages = primary === undefined ? [] : snapshotFor(primary).pages
  const transientPages = transient === undefined ? [] : snapshotFor(transient).pages
  const globalEmpty = globalPages.length === 0
  const primaryEmpty = primaryPages.length === 0 && primary !== undefined
  if (globalEmpty && primary === undefined && transient === undefined && textOf(notice) === '') return ''

  const lines = []
  lines.push('<memory_system>')
  lines.push('<memory_layers>')
  lines.push('重要：本地记忆按项目独立分三层，定位与访问方式不同。')
  lines.push('- 全局记忆库：跨项目内容（用户画像、通用经验、跨项目规则），任何会话都注入。')
  lines.push('- 主项目库：会话所属工作区文件夹下的 .memory-book/，任何情况下都注入；core 每轮全文、知识层只注入索引。')
  lines.push('- 临时项目库：当前工作目录属于另一个项目时追加注入（只提示，不强制更新），cd 回主项目后消失。')
  lines.push('</memory_layers>')
  lines.push('<memory_scope>')
  lines.push(`全局记忆库：${globalStore.memoryRoot}（scope=global）`)
  if (primary === undefined) {
    lines.push('主项目：无（本会话不属于任何工作区，只能使用全局记忆库；写项目记忆请用 scope=global）')
  } else {
    lines.push(`主项目：${primary.title}（${primary.folder}）记忆根：${primary.memoryRoot}（scope=main，current 默认指向它）`)
    if (!existsSync(primary.root)) lines.push('（主项目记忆库尚未创建：首次写入时自动创建）')
  }
  if (transient !== undefined) {
    lines.push(`临时项目：${transient.title}（${transient.folder}）记忆根：${transient.memoryRoot}（当前工作目录属于它，scope=current 默认指向它）`)
  }
  lines.push('</memory_scope>')

  if (primary !== undefined) {
    lines.push('<core_memory>')
    lines.push(`以下是主项目「${primary.title}」的 core/核心记忆 正文（每轮全文注入）。`)
    lines.push('<content>')
    lines.push(renderCoreText(primaryPages, settings.mainCoreChars))
    lines.push('</content>')
    lines.push('</core_memory>')
    lines.push('<memory_index>')
    lines.push(`以下是主项目「${primary.title}」的目录索引（页面路径 — 标题：一句话摘要）。`)
    lines.push(renderIndexText(primaryPages, settings.mainIndexChars))
    lines.push('</memory_index>')
    lines.push('<project_docs>')
    lines.push(renderDocsText(primary, agentId))
    lines.push('</project_docs>')
  }

  lines.push('<global_memory>')
  lines.push(`全局记忆库路径：${globalStore.memoryRoot}（scope=global）。`)
  lines.push('全局 core 正文：')
  lines.push(renderCoreText(globalPages, settings.coreChars))
  lines.push('全局目录索引：')
  lines.push(renderIndexText(globalPages, settings.indexChars))
  lines.push('</global_memory>')

  if (transient !== undefined) {
    lines.push('<transient_memory>')
    lines.push(`临时项目「${transient.title}」：读/写用 scope=current（本项目不是主项目，只提示，不做强制更新）。`)
    if (settings.transientCoreChars > 0) {
      lines.push('临时项目 core 正文：')
      lines.push(renderCoreText(transientPages, settings.transientCoreChars))
    }
    lines.push('临时项目目录索引：')
    lines.push(renderIndexText(transientPages, settings.transientIndexChars))
    lines.push('临时项目固定文档清单：')
    lines.push(renderDocsText(transient, undefined, false))
    lines.push('</transient_memory>')
  }

  lines.push('<memory_use>')
  lines.push('- 当前对话或核心记忆已经足够时直接完成任务，不额外检索。')
  lines.push('- 索引每行开头的就是页面路径，判断相关后直接 memory read，不必先 search。')
  lines.push('- 写当前项目用默认 scope=current；写主项目用 scope=main；跨项目内容写 scope=global。')
  lines.push('- 记忆里的路径、配置、版本可能已变化；涉及可能变化的事实时回到现场核验。')
  lines.push('</memory_use>')
  lines.push('<memory_write>')
  lines.push('- 先读再写（引擎强制）：patch/put/record 前先 read 目标页；record 还要带 based_on=最新版本路径。')
  lines.push('- 用户明确要求记住、记录或沉淀时直接写入；未明确要求但有长期价值时先征得同意。')
  lines.push('- **更新时删掉过时内容**：旧方案、旧结论、已失效路径直接删除，不保留“历史包袱”；只有决策历史与项目经验里可以保留“旧做法为什么错”。')
  lines.push('- 用户说「沉淀/整理记忆」：用 session_event_search / session_event_read 回取本次会话关键片段，提炼 0–3 条；短规则→core，主题知识→wiki，外部来源→raw，固定文档按维护规则写；不生成中间证据文件。')
  lines.push('- 记忆候选：用户的偏好与纠正、外部资料的结论、多轮试错后的方案、可复用流程；不写流水账。')
  lines.push('- core 放每轮必用的精炼规则；长期背景、决策与经验写 wiki；原始资料凭证写 raw；本项目状态写 project/ 固定文档。')
  lines.push('- 不写：普通闲聊、一次性安排、进度流水、未验证猜测、敏感凭证（密码、令牌、密钥）。')
  lines.push('</memory_write>')
  lines.push('<memory_maintenance>')
  lines.push('- 固定文档是引擎管理的项目文档：说明及目标、策划、计划、状态、交接、决策历史、项目经验。')
  lines.push('- 判断规则（语义由你判断，引擎只负责在观测到实质变化后强制提醒）：')
  lines.push('  用户表达了决策 → 记「决策历史」；阶段收尾/换会话 → 记「交接」；踩到可复用的坑 → 记「项目经验」；')
  lines.push('  计划或目标有变化 → 记「计划」+「状态」；工作区有代码/文档改动 → 更新「状态」。')
  lines.push('- 说明及目标正文 ≤2000 字；固定文档不允许删除；历史版本只读。')
  lines.push('- 队友只写项目经验页与普通页；固定文档由 Lead 写。')
  lines.push('</memory_maintenance>')
  if (textOf(notice) !== '') {
    lines.push('<memory_maintenance_notice>')
    lines.push(textOf(notice))
    lines.push('</memory_maintenance_notice>')
  }
  lines.push('</memory_system>')
  return lines.filter((line) => line !== '').join('\n')
}

/** 注入用时取出并清空当前 agent 的降级提醒（followup 不可用时只做强制提醒）。 */
function takeReminder(agentId) {
  const state = engineStates.get(agentId)
  if (state === undefined || textOf(state.reminder) === '') return ''
  const text = state.reminder
  state.reminder = ''
  return text
}

function renderSystem(agent) {
  try {
    const primary = livePrimary(agent)
    const transient = primary === undefined ? undefined : liveTransient(agent)
    return renderInjection({ primary, transient, agentId: agent?.id, notice: agent ? takeReminder(agent.id) : '' })
  } catch {
    // 注入永远不能抛错（否则会毁掉整轮系统提示词）。
    return ''
  }
}

/** 面板用：按某个库渲染注入预览（全局库只算全局段）。 */
function renderForStore(store) {
  if (store.kind === 'project') return renderInjection({ primary: store, transient: undefined })
  return renderInjection({ primary: undefined, transient: undefined })
}

// ── 读取记录与写保护 ─────────────────────────────────────────────────────────

/** 本会话读过的页面：sessionId -> Map<文件小写路径, mtime>（先读再写的乐观锁）。 */
const readStates = new Map()

function sessionKeyOf(session, agent) {
  if (session !== undefined && session !== null && session.id !== undefined) return String(session.id)
  if (agent !== undefined && agent !== null && agent.id !== undefined) return String(agent.id)
  return undefined
}

function recordRead(session, agent, page) {
  const key = sessionKeyOf(session, agent)
  if (key === undefined) return
  let map = readStates.get(key)
  if (map === undefined) {
    map = new Map()
    readStates.set(key, map)
  }
  map.set(page.file.toLowerCase(), page.mtime)
}

/** 强校验：本会话必须 read 过目标页，且读取后文件 mtime 没变。 */
function requireFreshRead(session, agent, page, actionLabel) {
  const key = sessionKeyOf(session, agent)
  if (key === undefined) return
  const map = readStates.get(key)
  const recorded = map === undefined ? undefined : map.get(page.file.toLowerCase())
  if (recorded === undefined) {
    throw new Error(`${actionLabel}：本会话还没有 read 过这个页面。引擎强制先读再写，请先 memory read 再重试。`)
  }
  let current
  try {
    current = statSync(page.file).mtimeMs
  } catch {
    throw new Error(`${actionLabel}：页面在读取后消失了，请先重新 read。`)
  }
  if (current !== recorded) {
    throw new Error(`${actionLabel}：页面在读取后被改过（mtime 变了），请先重新 read 再写，避免覆盖别人的修改。`)
  }
}

/** 判断 agent 的角色：子代理、Agent Teams 队友、或 owner（非团队会话按 owner 处理）。 */
function roleOf(agent) {
  const session = sessionOf(agent)
  const header = session?.header
  if (header !== undefined && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) {
    return { role: 'subagent' }
  }
  const teams = safeGet('agentTeams')
  if (teams === undefined || typeof teams.tryMembership !== 'function' || agent === undefined || agent === null) {
    return { role: 'owner' }
  }
  let membership
  try {
    membership = teams.tryMembership(agent)
  } catch {
    membership = undefined
  }
  if (membership === undefined || membership === null) return { role: 'owner' }
  return { role: textOf(membership.role) || 'owner', name: textOf(membership.name) }
}

/** 固定文档写者限制：只有 Lead 能写说明及目标与版本化文档。 */
function assertLead(agent, what) {
  const role = roleOf(agent)
  if (role.role === 'teammate') {
    throw new Error(`${what}：固定文档只有 Lead 能写；队友请写项目经验页或普通页，完成后把路径回报 Lead。`)
  }
  if (role.role === 'subagent') {
    throw new Error(`${what}：固定文档只有 Lead 能写；子代理请把结论交回父代理，不要直接写项目固定文档。`)
  }
}

function agentMarkOf(agent) {
  const role = roleOf(agent)
  if (textOf(role.name) !== '') return role.name
  if (agent !== undefined && agent !== null && agent.id !== undefined) return String(agent.id)
  return 'panel'
}

// ── 工具动作实现 ─────────────────────────────────────────────────────────────

function requirePath(input, action) {
  const rel = normalizePagePath(input)
  if (rel === undefined) {
    throw new Error(
      `${action} 需要的 path 不合法。允许的路径：core/核心记忆、wiki/{projects,concepts,lessons,profile,entities}/页面名、raw/页面名、` +
        'project/说明及目标、project/经验/<类型>、project/<策划|计划|状态|交接|决策历史>/<YYYYMMDD-HHmm>' +
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

/** 固定页正文：剥掉可能自带的 frontmatter，只留正文。 */
function bodyOfContent(content) {
  return splitFrontmatter(content).body.trim()
}

/** 组装固定页文本：引擎生成 frontmatter（title/summary，版本页另记 by/session）。 */
function composeFixedPage({ title, body, extra }) {
  const fields = { title, summary: firstLineSummary(body), ...(extra || {}) }
  return `${frontmatterText(fields)}\n\n${body.trimEnd()}\n`
}

function writeNewFile(store, rel, text, actionLabel) {
  const file = fileOf(rel, store)
  if (existsSync(file)) throw new Error(`${actionLabel}：页面已存在: ${rel}`)
  withWriteLock(file, () => {
    if (store.kind === 'project') ensureProjectRoot(store)
    else mkdirSync(path.dirname(file), { recursive: true })
    atomicWriteFile(file, text)
  })
  invalidate(store.root)
  return file
}

function overwriteFile(store, rel, text, actionLabel) {
  const file = fileOf(rel, store)
  withWriteLock(file, () => atomicWriteFile(file, text))
  invalidate(store.root)
  return file
}

function doRead(args, env) {
  const rel = requirePath(args.path, 'read')
  assertPathAllowed(rel, env.store)
  const page = loadPage(rel, env.store)
  if (page === undefined) throw new Error(`读取记忆失败：页面不存在: ${rel}`)
  recordRead(env.session, env.agent, page)
  return `<read_only>\npath: ${rel}\nstore: ${storeLabel(env.store).trim()}\nupdated: ${page.updated}\n</read_only>\n<page_content>\n${page.text}\n</page_content>`
}

function doAdd(args, env) {
  const rel = requirePath(args.path, 'add')
  const fixed = fixedKindOf(rel)
  if (fixed !== undefined) {
    throw new Error(
      fixed.kind === 'version' || fixed.kind === 'brief'
        ? `新增记忆失败：固定文档不能用 add，说明及目标用 action=put，版本化文档用 action=record。`
        : `新增记忆失败：项目经验页不能用 add，请用 action=put（path=${rel}）。`,
    )
  }
  const content = textOf(args.content)
  if (content.trim() === '') throw new Error('新增记忆失败：需要 content，传入完整页面内容（含 frontmatter）。')
  const invalid = pageFormatError(content)
  if (invalid !== undefined) throw new Error(`新增记忆失败：${invalid}`)
  const text = content.replace(/\r\n/g, '\n').trimEnd() + '\n'
  writeNewFile(env.store, rel, text, '新增记忆失败')
  return `已新增页面: ${rel}`
}

function doPatch(args, env) {
  const rel = requirePath(args.path, 'patch')
  assertPathAllowed(rel, env.store)
  const fixed = fixedKindOf(rel)
  if (fixed !== undefined && fixed.kind === 'version') {
    const def = DOC_BY_KEY.get(fixed.doc)
    const latest = def === undefined ? undefined : latestVersionOf(env.store, def)
    if (latest === undefined || latest.rel !== rel) {
      throw new Error(`修改记忆失败：历史版本只读（${rel}），只允许改最新版本；最新版是 ${latest?.rel ?? '（无）'}。`)
    }
    assertLead(env.agent, '修改固定文档')
  }
  if (fixed !== undefined && fixed.kind === 'brief') assertLead(env.agent, '修改说明及目标')
  const page = loadPage(rel, env.store)
  if (page === undefined) throw new Error(`修改记忆失败：页面不存在: ${rel}`)
  requireFreshRead(env.session, env.agent, page, '修改记忆失败')
  const oldText = textOf(args.old_string)
  if (oldText === '') throw new Error('修改记忆失败：需要非空的 old_string，传入页面中待替换的原文片段。')
  if (args.new_string === undefined || args.new_string === null) {
    throw new Error('修改记忆失败：需要 new_string；传入空字符串表示删除该片段。')
  }
  const newText = textOf(args.new_string)
  const count = occurrences(page.text, oldText)
  if (count === 0) throw new Error('修改记忆失败：old_string 在页面中未找到匹配。请先 read 页面确认原文，再用准确片段重试。')
  if (count > 1) throw new Error(`修改记忆失败：old_string 在页面中匹配到 ${count} 处，需要唯一匹配。请带上更多上下文后重试。`)
  const index = page.text.indexOf(oldText)
  const next = page.text.slice(0, index) + newText + page.text.slice(index + oldText.length)
  overwriteFile(env.store, rel, next.replace(/\r\n/g, '\n'), '修改记忆失败')
  return `已修改页面: ${rel}`
}

function doRemove(args, env) {
  const rel = requirePath(args.path, 'remove')
  assertPathAllowed(rel, env.store)
  if (fixedKindOf(rel) !== undefined) {
    throw new Error(`删除记忆失败：固定文档不允许删除: ${rel}（说明及目标、经验页、版本页都受保护）。`)
  }
  const file = fileOf(rel, env.store)
  if (!existsSync(file)) throw new Error(`删除记忆失败：页面不存在: ${rel}`)
  rmSync(file, { force: true })
  invalidate(env.store.root)
  return `已删除页面: ${rel}`
}

/** 把 query 切成主题词：空白与常见中英文标点都是分隔符，去重去空。 */
function tokenizeQuery(query) {
  const parts = query.toLowerCase().split(/[\s,，、。;；:：\/\\|()（）\[\]【】「」“”"']+/)
  return [...new Set(parts.filter((part) => part !== ''))]
}

function doSearch(args, env) {
  const query = textOf(args.query).trim()
  if (query === '') throw new Error('搜索记忆失败：需要 query（主题词，不要用路径字符串）。')
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) throw new Error('搜索记忆失败：query 里没有可检索的主题词。')

  // 一页要同时命中所有词才算命中；标题命中权重最高，其次 summary，最后正文。
  const collect = (requireAll) => {
    const hits = []
    for (const entry of pageEntries(env.store)) {
      const page = loadPage(entry.rel, env.store)
      if (page === undefined) continue
      const text = page.text.toLowerCase()
      const title = titleOfPage(page)
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

/** put：全量覆盖固定页（说明及目标 或 项目经验/<类型>）。 */
function doPut(args, env) {
  const rel = requirePath(args.path, 'put')
  assertPathAllowed(rel, env.store)
  const fixed = fixedKindOf(rel)
  if (fixed === undefined || (fixed.kind !== 'brief' && fixed.kind !== 'experience')) {
    throw new Error('保存固定页失败：put 只接受 project/说明及目标 或 project/经验/<类型>；其他路径用 add/patch。')
  }
  if (fixed.kind === 'brief') assertLead(env.agent, '保存说明及目标')
  const content = textOf(args.content)
  if (content.trim() === '') throw new Error('保存固定页失败：需要 content（正文内容）。')
  const body = bodyOfContent(content)
  if (body === '') throw new Error('保存固定页失败：正文不能为空。')
  if (fixed.kind === 'brief') {
    const count = charCount(body)
    if (count > BRIEF_CHAR_LIMIT) {
      throw new Error(`保存固定页失败：说明及目标正文 ${count} 字，超过上限 ${BRIEF_CHAR_LIMIT} 字，请精简后重试。`)
    }
  }
  const file = fileOf(rel, env.store)
  if (existsSync(file)) {
    const page = loadPage(rel, env.store)
    if (page === undefined) throw new Error(`保存固定页失败：页面读取失败: ${rel}`)
    requireFreshRead(env.session, env.agent, page, '保存固定页失败')
  }
  const title = fixed.kind === 'brief' ? '说明及目标' : fixed.type
  const text = composeFixedPage({ title, body })
  withWriteLock(file, () => {
    ensureProjectRoot(env.store)
    atomicWriteFile(file, text)
  })
  invalidate(env.store.root)
  const count = charCount(body)
  return fixed.kind === 'brief'
    ? `已保存固定页: ${rel}（${count}/${BRIEF_CHAR_LIMIT} 字）`
    : `已保存项目经验页: ${rel}（${count} 字）`
}

/** record：给版本化文档追加一个新版本（旧版本永远不动）。 */
function doRecord(args, env) {
  const docName = textOf(args.doc).trim()
  const def = DOC_BY_NAME.get(docName)
  if (def === undefined || !def.versioned) {
    throw new Error(`追加版本失败：doc 必须是 ${VERSIONED_DOC_NAMES.join(' / ')} 之一。`)
  }
  const content = textOf(args.content)
  if (content.trim() === '') throw new Error('追加版本失败：需要 content（本轮完整内容）。')
  if (typeof args.based_on !== 'string') {
    throw new Error('追加版本失败：需要 based_on（上一版本路径；还没有历史版本时传空字符串）。')
  }
  const basedOn = args.based_on.trim()
  assertLead(env.agent, `追加${def.name}`)

  const latest = latestVersionOf(env.store, def)
  if (latest === undefined) {
    if (basedOn !== '') {
      throw new Error(`追加版本失败：${def.name}还没有历史版本，based_on 应为空字符串（收到 ${basedOn}）。请先 read 或 history 确认。`)
    }
  } else {
    if (basedOn !== latest.rel) {
      throw new Error(
        `追加版本失败：based_on 与最新版本不一致（可能是并发覆盖）。最新版本是 ${latest.rel}，请先 read 它再用 based_on=${latest.rel} 重试。`,
      )
    }
    const latestPage = loadPage(latest.rel, env.store)
    if (latestPage === undefined) throw new Error(`追加版本失败：最新版本读取失败: ${latest.rel}`)
    requireFreshRead(env.session, env.agent, latestPage, '追加版本失败')
  }

  const body = bodyOfContent(content)
  if (body === '') throw new Error('追加版本失败：正文不能为空。')
  const version = nextVersionName(env.store, def)
  const rel = `project/${def.name}/${version}`
  const title = `${def.name} ${version}`
  const role = roleOf(env.agent)
  const text = composeFixedPage({
    title,
    body,
    extra: { by: agentMarkOf(env.agent), session: textOf(env.session?.id) },
  })
  const file = fileOf(rel, env.store)
  withWriteLock(file, () => {
    ensureProjectRoot(env.store)
    atomicWriteFile(file, text)
  })
  invalidate(env.store.root)
  const previous = latest === undefined ? '（首个版本）' : latest.rel
  return `已新增版本: ${rel}（上一版本: ${previous}）`
}

/** history：列出某版本化文档的全部版本（新→旧）。 */
function doHistory(args, env) {
  const docName = textOf(args.doc).trim()
  const def = DOC_BY_NAME.get(docName)
  if (def === undefined || !def.versioned) {
    throw new Error(`列版本失败：doc 必须是 ${VERSIONED_DOC_NAMES.join(' / ')} 之一。`)
  }
  const versions = listVersionEntries(env.store, def)
  if (versions.length === 0) return `${def.name} 还没有任何版本（用 action=record 创建第一个版本）。`
  const lines = versions.map(
    (item, index) =>
      `${index + 1}. ${item.rel}「${item.title}」\n   更新时间: ${item.updated}\n   summary: ${item.summary || '（无摘要）'}`,
  )
  return `${def.name} 共 ${versions.length} 个版本（新→旧）：\n${lines.join('\n')}`
}

ACTIONS.read = doRead
ACTIONS.add = doAdd
ACTIONS.patch = doPatch
ACTIONS.remove = doRemove
ACTIONS.search = doSearch
ACTIONS.put = doPut
ACTIONS.record = doRecord
ACTIONS.history = doHistory

// ── 引擎强制维护 ─────────────────────────────────────────────────────────────

/** 每个 agent 的维护状态：回合计数、实质变化计数、补更轮防重。 */
const engineStates = new Map()
/** 新消息工厂：@deepseek-ai/dsh-llm 的 createUserMessage（不可用时用最小 UserMessage 兜底）。 */
let userMessageFactory
let userMessageFactoryTried = false

function emptyPerTurn() {
  return {
    substantive: false,
    fileChange: false,
    planChanged: false,
    memoryWrite: false,
    failureHit: false,
    recordedPlanish: false,
    recordedStatus: false,
  }
}

function engineStateFor(agent) {
  const id = agent?.id
  if (id === undefined || id === null) return undefined
  let state = engineStates.get(String(id))
  if (state === undefined) {
    const session = sessionOf(agent)
    const header = session?.header
    const skip = header !== undefined && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
    state = {
      agentId: String(id),
      sessionId: session?.id === undefined ? undefined : String(session.id),
      skip,
      lastUserSummary: '',
      noChangeTurns: 0,
      changesSinceStatus: 0,
      changesSinceHandover: 0,
      failureStreak: 0,
      followupIds: new Set(),
      followupFired: false,
      inFollowup: false,
      pending: null,
      reminder: '',
      perTurn: emptyPerTurn(),
      initialized: false,
    }
    engineStates.set(String(id), state)
  }
  if (!state.initialized) {
    state.initialized = true
    state.skip = engineStateSkip(agent, state)
  }
  return state
}

/** 子代理会话不触发维护；拿不到 header 时按非子代理处理。 */
function engineStateSkip(agent, state) {
  if (state.skip) return true
  const session = sessionOf(agent)
  const header = session?.header
  return header !== undefined && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)
}

function userMessageSummary(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content
    .filter((block) => block?.type === 'text')
    .map((block) => textOf(block.text))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return ''
  return text.length > 80 ? `${text.slice(0, 79)}…` : text
}

function isRealUserMessage(message) {
  if (message === undefined || message === null) return false
  if (message.role !== undefined && message.role !== 'user') return false
  const source = message.source
  if (source === undefined || source === null) return true
  const kind = textOf(source.kind)
  return kind === 'user' || kind === 'memory-maintenance'
}

/** 打开一个用户回合：重置每回合标志与补更轮令牌。 */
function startUserTurn(state, message) {
  state.perTurn = emptyPerTurn()
  state.followupFired = false
  state.inFollowup = false
  state.lastUserSummary = userMessageSummary(message)
}

/** 记一次实质变化：累计交接到期与状态陈旧计数。 */
function markSubstantive(state, kind) {
  if (state.perTurn !== undefined && state.perTurn !== null) state.perTurn.substantive = true
  // 写记忆本身只算“产出了长期结论”：不推进状态/交接的陈旧计数，
  // 否则 record 状态之后再记录决策历史，会把刚写好的状态又标成陈旧。
  if (kind !== 'memory') {
    state.changesSinceHandover += 1
    state.changesSinceStatus += 1
  }
  state.noChangeTurns = 0
  if (kind === 'files' && state.perTurn !== undefined) state.perTurn.fileChange = true
  if (kind === 'plan' && state.perTurn !== undefined) state.perTurn.planChanged = true
  if (kind === 'memory' && state.perTurn !== undefined) state.perTurn.memoryWrite = true
}

function hasWorkspaceChangesService() {
  const service = safeGet('workspaceChanges')
  return service !== undefined && typeof service.summary === 'function'
}

function isMemoryBookPath(candidate) {
  return textOf(candidate).toLowerCase().includes('.memory-book')
}

function markFileChange(state) {
  const perTurn = state.perTurn
  if (perTurn !== undefined && perTurn !== null && perTurn.fileChange) return
  markSubstantive(state, 'files')
}

function markToolFailure(state) {
  state.failureStreak += 1
  if (state.failureStreak >= 2 && state.perTurn !== undefined && state.perTurn !== null) state.perTurn.failureHit = true
}

/** session/event：用户消息开回合、workspace/changes 记实质变化、turn/end 评估触发。 */
function handleSessionEvent(session, event) {
  if (event === undefined || event === null) return
  const agents = safeGet('agents')
  let agent
  if (agents !== undefined && typeof agents.get === 'function') {
    try {
      agent = agents.get(session.id)
    } catch {
      agent = undefined
    }
  }
  if (agent === undefined) return
  let agentSession
  try {
    agentSession = agent.session
  } catch {
    agentSession = undefined
  }
  if (agentSession !== undefined && agentSession !== session) return
  const state = engineStateFor(agent)
  if (state === undefined) return
  if (state.skip || engineStateSkip(agent, state)) return

  if (event.type === 'user/message') {
    const message = event.data
    if (message !== undefined && state.followupIds.has(message.id)) {
      // 补更轮自身的用户消息：不当作新的用户回合，也不重复触发。
      state.inFollowup = true
      return
    }
    if (isRealUserMessage(message)) startUserTurn(state, message)
    return
  }
  if (event.type === 'workspace/changes') {
    if (!hasWorkspaceChangesService()) return
    const service = safeGet('workspaceChanges')
    let summary
    try {
      summary = service.summary(session.id, event.seq)
    } catch {
      summary = undefined
    }
    if (summary === undefined || Number(summary.total) <= 0) return
    const files = Array.isArray(summary.files) ? summary.files : []
    const memoryFiles = files.filter((file) => isMemoryBookPath(file?.path) || isMemoryBookPath(file?.display))
    const relevant = Number(summary.total) - memoryFiles.length
    if (relevant > 0) markFileChange(state)
    return
  }
  if (event.type === 'turn/end') {
    const reason = event.data?.reason
    const kind = textOf(reason?.kind)
    if (kind === 'aborted' || kind === 'error' || kind === 'interrupted') {
      state.pending = null
      state.perTurn = emptyPerTurn()
      state.inFollowup = false
      return
    }
    finishTurn(state, agent)
  }
}

/** tools/result：文件改动、计划/目标、记忆写入、连续失败等实质变化信号。 */
function handleToolResult(exec, result) {
  const agent = exec?.agent
  if (agent === undefined || agent === null) return
  const state = engineStateFor(agent)
  if (state === undefined || state.skip || engineStateSkip(agent, state)) return

  if (result !== undefined && result !== null && result.isError === true) {
    markToolFailure(state)
    return
  }
  state.failureStreak = 0
  const toolName = textOf(exec.name)
  const args = exec.arguments !== undefined && exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {}
  const settings = readSettings()

  if (toolName === 'memory') {
    const action = textOf(args.action)
    if (!MEMORY_WRITE_ACTIONS.has(action)) return
    markSubstantive(state, 'memory')
    if (action === 'record' && state.perTurn !== undefined && state.perTurn !== null) {
      const doc = textOf(args.doc)
      if (doc === '状态') {
        state.perTurn.recordedStatus = true
        state.changesSinceStatus = 0
      } else if (PLANISH_DOCS.has(doc)) {
        state.perTurn.recordedPlanish = true
        if (doc === '交接') state.changesSinceHandover = 0
      }
    }
    return
  }
  if (toolName === 'todo_write' || toolName === 'create_goal' || toolName === 'update_goal') {
    if (state.perTurn !== undefined && state.perTurn !== null) state.perTurn.planChanged = true
    markSubstantive(state, 'plan')
    return
  }
  if (hasWorkspaceChangesService()) return
  if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch' || toolName === 'patch') {
    markFileChange(state)
    return
  }
  if (toolName === 'pwsh' || toolName === 'bash') {
    // 只在拿不到 workspaceChanges 数据时才把 shell 计入，避免只读命令误判。
    if (settings.autoFollowup) markFileChange(state)
  }
}

/** 回合结束：按“实质变化 + 缺失/陈旧”计算本轮要强制补更的文档。 */
function finishTurn(state, agent) {
  const perTurn = state.perTurn === undefined || state.perTurn === null ? emptyPerTurn() : state.perTurn
  if (state.inFollowup) {
    // 补更轮自身不重复触发。
    state.inFollowup = false
    state.perTurn = emptyPerTurn()
    return
  }
  if (!perTurn.substantive) state.noChangeTurns += 1

  const settings = readSettings()
  const docs = []
  if (perTurn.fileChange) docs.push('状态')
  if (perTurn.planChanged) docs.push('计划', '状态')
  if (perTurn.failureHit || state.failureStreak >= 2) {
    docs.push('经验')
    state.failureStreak = 0
  }
  const primary = livePrimary(agent) || primaryProject(agent)
  for (const label of missingFixedDocLabels(primary)) docs.push(label)
  if (state.changesSinceHandover >= settings.handoverChanges) docs.push('交接')
  if (perTurn.recordedPlanish && !perTurn.recordedStatus) docs.push('状态')
  const uniqueDocs = [...new Set(docs)]
  const fallback = state.noChangeTurns >= settings.fallbackRounds
  state.perTurn = emptyPerTurn()
  if (uniqueDocs.length === 0 && !fallback) return
  state.pending = { docs: uniqueDocs, fallback, summary: state.lastUserSummary }
  if (agent?.status === 'idle') void fireFollowup(state, agent)
}

function buildMaintenanceText(state, agent, pending) {
  const store = livePrimary(agent) || primaryProject(agent)
  const lines = ['<memory_maintenance>']
  if (pending.fallback) {
    state.noChangeTurns = 0
    lines.push('连续多个用户回合都没有检测到实质变化（文件、计划、记忆都没动）。')
    lines.push('请用一两句话询问用户：是否需要更新项目状态或交接、或把本轮值得长期保留的结论沉淀进记忆。不要自动写入。')
  } else {
    lines.push('引擎检测到本轮有实质变化，需要补更项目固定文档。')
    if (store !== undefined) lines.push(`项目：${store.title}（记忆根：${store.memoryRoot}）`)
    else lines.push('（本会话没有项目工作区：无法写项目固定文档，请在回复里说明。）')
    lines.push('本轮必须更新的文档（先 read 再写）：')
    for (const label of pending.docs) lines.push(`- ${label}`)
    lines.push('用 memory action=record 写版本化文档（doc=策划/计划/状态/交接/决策历史，必须带 based_on=上一版本路径；首个版本传空字符串）；')
    lines.push('用 action=put 写说明及目标或项目经验。不要用 add/patch/remove 写固定文档。')
    lines.push('只写确实有变化的内容；若某项与本次变化无关，在回复里说明原因即可。')
  }
  if (pending.summary !== '') lines.push(`用户最近一条消息摘要：${pending.summary}`)
  lines.push('</memory_maintenance>')
  return lines.join('\n')
}

/** 加载 createUserMessage（裸导入在 DSH 插件里可解析；失败时用最小 UserMessage 兜底）。 */
async function getUserMessageFactory() {
  if (userMessageFactoryTried) return userMessageFactory
  userMessageFactoryTried = true
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    if (module !== undefined && module !== null && typeof module.createUserMessage === 'function') {
      userMessageFactory = module.createUserMessage
    }
  } catch {
    userMessageFactory = undefined
  }
  return userMessageFactory
}

function fallbackUserMessage(input) {
  return {
    id: `memory-maintenance-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    role: 'user',
    content: input.content,
    source: input.source,
  }
}

/** 追加一轮补更：每用户回合最多 1 次；失败降级为下一轮注入里的强制提醒。 */
async function fireFollowup(state, agent) {
  const pending = state.pending
  if (pending === undefined || pending === null) return
  if (state.followupFired) {
    state.pending = null
    return
  }
  state.followupFired = true
  state.pending = null
  if (!readSettings().autoFollowup) return
  const text = buildMaintenanceText(state, agent, pending)
  if (typeof agent?.followup !== 'function') {
    state.reminder = text
    return
  }
  let message
  try {
    const factory = await getUserMessageFactory()
    const input = { content: [{ type: 'text', text }], source: { kind: 'memory-maintenance' } }
    message = typeof factory === 'function' ? factory(input) : fallbackUserMessage(input)
  } catch {
    state.reminder = text
    return
  }
  try {
    agent.followup(message)
    if (message !== undefined && message !== null && message.id !== undefined) state.followupIds.add(message.id)
  } catch {
    state.reminder = text
  }
}

function handleAgentStatus(agent, status) {
  if (agent === undefined || agent === null) return
  const state = engineStateFor(agent)
  if (state === undefined || state.skip) return
  if (status === 'idle' && state.pending !== null) void fireFollowup(state, agent)
}

/** 遗忘一个 agent 的全部内存状态（agent/disposed 时调用）。 */
function forgetAgent(agentId) {
  if (agentId === undefined || agentId === null) return
  const key = String(agentId)
  primaryCache.delete(key)
  engineStates.delete(key)
  readStates.delete(key)
}

// ── 面板接口 ─────────────────────────────────────────────────────────────────

function writePageContent(store, rel, content, actionLabel) {
  assertPathAllowed(rel, store)
  const fixed = fixedKindOf(rel)
  if (fixed !== undefined && fixed.kind === 'version') {
    const def = DOC_BY_KEY.get(fixed.doc)
    const latest = def === undefined ? undefined : latestVersionOf(store, def)
    if (latest === undefined || latest.rel !== rel) throw new Error(`历史版本只读: ${rel}（最新版：${latest?.rel ?? '（无）'}）`)
  }
  const text = textOf(content)
  if (text.trim() === '') throw new Error('保存失败：内容不能为空')
  let payload
  if (fixed !== undefined) {
    const body = bodyOfContent(text)
    if (body === '') throw new Error('保存失败：正文不能为空')
    if (fixed.kind === 'brief') {
      const count = charCount(body)
      if (count > BRIEF_CHAR_LIMIT) throw new Error(`保存失败：说明及目标正文 ${count} 字，超过上限 ${BRIEF_CHAR_LIMIT} 字`)
    }
    const title = fixed.kind === 'brief' ? '说明及目标' : fixed.kind === 'experience' ? fixed.type : `${fixed.name} ${fixed.version}`
    // 面板编辑最新版本页时保留引擎写入的 by / session 追责信息。
    const existing = fixed.kind === 'version' ? loadPage(rel, store) : undefined
    const extra = {}
    if (existing !== undefined) {
      if (textOf(existing.fields.by) !== '') extra.by = textOf(existing.fields.by)
      if (textOf(existing.fields.session) !== '') extra.session = textOf(existing.fields.session)
    }
    payload = composeFixedPage({ title, body, extra })
  } else {
    const invalid = pageFormatError(text)
    if (invalid !== undefined) throw new Error(`保存失败：${invalid}`)
    payload = text.replace(/\r\n/g, '\n').trimEnd() + '\n'
  }
  const file = fileOf(rel, store)
  withWriteLock(file, () => {
    if (store.kind === 'project') ensureProjectRoot(store)
    else mkdirSync(path.dirname(file), { recursive: true })
    atomicWriteFile(file, payload)
  })
  invalidate(store.root)
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

function pagePayload(store, rel) {
  const page = loadPage(rel, store)
  if (page === undefined) throw new Error(`页面不存在: ${rel}`)
  const fixed = fixedKindOf(rel)
  let readOnly = false
  if (fixed !== undefined && fixed.kind === 'version') {
    const def = DOC_BY_KEY.get(fixed.doc)
    const latest = def === undefined ? undefined : latestVersionOf(store, def)
    readOnly = latest === undefined || latest.rel !== rel
  }
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
    meta: {
      fixed: fixed !== undefined,
      versioned: fixed?.kind === 'version',
      ...(fixed?.kind === 'version' ? { doc: fixed.doc } : {}),
      readOnly,
    },
  }
}

function libraryView(store, transient) {
  const settings = readSettings()
  const pages = snapshotFor(store)
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
      chars: page.bodyChars,
      updated: new Date(page.mtime).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      core: page.isCore,
    }))
  const docs = docsState(store)
  const injected = renderForStore(store)
  const countOf = (category) => pages.filter((page) => page.category === category).length
  const categories = ['projects', 'concepts', 'lessons', 'profile', 'entities', 'raw'].map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    count: countOf(key),
  }))
  const coreLimit = store.kind === 'global' ? settings.coreChars : settings.mainCoreChars
  const indexLimit = store.kind === 'global' ? settings.indexChars : settings.mainIndexChars
  return {
    ok: true,
    root: store.root,
    scope: scopePayloadOf(store),
    ...(transient === undefined ? {} : { transient: scopePayloadOf(transient) }),
    settings,
    defaults: { ...DEFAULT_SETTINGS },
    limits: SETTINGS_LIMITS,
    pages,
    categories,
    docs: docs.docs,
    experiences: docs.experiences,
    injected: { totalChars: injected.length, coreLimit, indexLimit },
    counts: {
      all: pages.filter((page) => !page.core).length,
      core: countOf('core'),
      wiki: pages.filter((page) => page.path.startsWith('wiki/')).length,
      raw: countOf('raw'),
    },
  }
}

/** 把 scope 参数解析成真实库目录（Host 内部映射；不接受任意绝对路径）。 */
function scopeStore(ref) {
  const scope = textOf(ref?.scope).trim()
  const workspaceId = textOf(ref?.workspaceId).trim()
  const sessionId = textOf(ref?.sessionId).trim()
  const looksLikePath = (value) => value.includes('/') || value.includes('\\') || value.includes('..') || /^[A-Za-z]:/.test(value)

  if (scope === 'global') return makeGlobalStore()
  if (workspaceId !== '') {
    if (looksLikePath(workspaceId)) throw new Error('不接受任意路径作为 workspaceId；请传工作区 id。')
    const workspace = workspaceById(workspaceId)
    if (workspace === undefined) throw new Error(`未知的工作区: ${workspaceId}`)
    return storeOfWorkspace(workspace)
  }
  if (sessionId !== '') {
    if (looksLikePath(sessionId)) throw new Error('不接受任意路径作为 sessionId；请传会话 id。')
    const workspace = workspaceBySession(sessionId)
    if (workspace !== undefined) return storeOfWorkspace(workspace)
    const sessions = safeGet('sessions')
    let session
    if (sessions !== undefined && typeof sessions.get === 'function') {
      try {
        session = sessions.get(sessionId)
      } catch {
        session = undefined
      }
    }
    const cwd = currentDirOf(session)
    if (textOf(cwd) !== '') {
      const byPath = workspaceForPath(cwd)
      if (byPath !== undefined) return storeOfWorkspace(byPath)
    }
    throw new Error(`会话没有项目工作区: ${sessionId}`)
  }
  if (scope !== '' && scope !== 'current' && scope !== 'main') {
    // 兼容旧写法：scope=<工作区 id>。
    return scopeStore({ workspaceId: scope })
  }
  return makeGlobalStore()
}

/** 请求里的 scope 参数（GET 查询串或 POST 请求体都能带）。 */
function scopeRefOf({ url, body }) {
  const params = url?.searchParams
  const pick = (key) => {
    if (body !== undefined && body !== null && body[key] !== undefined && body[key] !== null) return body[key]
    return params === undefined ? undefined : params.get(key)
  }
  return {
    scope: pick('scope'),
    workspaceId: pick('workspaceId') || pick('workspace'),
    sessionId: pick('sessionId'),
  }
}

function projectsView() {
  const globalStore = makeGlobalStore()
  const globalPages = snapshotFor(globalStore).pages
  const projectRows = []
  for (const workspace of listWorkspaces()) {
    if (workspace === undefined || workspace === null) continue
    const store = storeOfWorkspace(workspace)
    let exists = false
    try {
      exists = statSync(store.folder).isDirectory()
    } catch {
      exists = false
    }
    const pages = snapshotFor(store).pages
    projectRows.push({
      workspaceId: workspace.id,
      path: store.folder,
      title: store.title,
      exists,
      hasMemory: existsSync(store.root),
      pages: pages.length,
      chars: pages.reduce((sum, page) => sum + page.bodyChars, 0),
    })
  }
  return {
    global: {
      path: globalStore.root,
      memoryRoot: globalStore.root,
      pages: globalPages.length,
      chars: globalPages.reduce((sum, page) => sum + page.bodyChars, 0),
    },
    projects: projectRows,
  }
}

function docOfInput(input) {
  const raw = textOf(input).trim()
  if (raw === '') return undefined
  const byKey = DOC_BY_KEY.get(raw)
  if (byKey !== undefined) return byKey
  const byName = DOC_BY_NAME.get(raw)
  if (byName !== undefined) return byName
  return undefined
}

/** 跨库解析一个页面路径：全局 + 各工作区库（供引用跳转）。 */
function resolvePageCandidates(rel) {
  const candidates = []
  const globalStore = makeGlobalStore()
  const globalPage = loadPage(rel, globalStore)
  if (globalPage !== undefined) {
    candidates.push({ kind: 'global', title: titleOfPage(globalPage), path: rel })
  }
  for (const workspace of listWorkspaces()) {
    if (workspace === undefined || workspace === null) continue
    const store = storeOfWorkspace(workspace)
    const page = loadPage(rel, store)
    if (page === undefined) continue
    candidates.push({
      kind: 'project',
      workspaceId: workspace.id,
      title: titleOfPage(page),
      path: rel,
      workspaceTitle: store.title,
    })
  }
  return candidates
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

  register('/memory-book/projects', async () => projectsView())

  register('/memory-book/library', async ({ url, body }) => {
    const ref = scopeRefOf({ url, body })
    const store = scopeStore(ref)
    // 临时项目只跟当前会话的当前工作目录有关；没有 sessionId 时不返回该字段。
    const transient = textOf(ref.sessionId).trim() === '' ? undefined : transientForSessionId(ref.sessionId)
    const visible = transient !== undefined && !sameDir(transient.root, store.root) ? transient : undefined
    return libraryView(store, visible)
  })

  register('/memory-book/page', async ({ url, body }) => {
    const store = scopeStore(scopeRefOf({ url, body }))
    if (body.path !== undefined) {
      const rel = requirePath(body.path, 'write')
      if (body.content !== undefined) {
        writePageContent(store, rel, body.content, 'save')
        return { path: rel, message: `已保存: ${rel}` }
      }
      return pagePayload(store, rel)
    }
    return pagePayload(store, requirePath(url.searchParams.get('path') || '', 'read'))
  })

  register('/memory-book/settings', async ({ body }) => {
    if (body.reset === true) {
      resetSettings()
      return { ...settingsPayload(), message: '已恢复默认' }
    }
    const changed = Object.keys(DEFAULT_SETTINGS).some((key) => body[key] !== undefined)
    if (changed) {
      saveSettings(body)
      return { ...settingsPayload(), message: '已保存' }
    }
    return settingsPayload()
  })

  register('/memory-book/delete', async ({ url, body }) => {
    const store = scopeStore(scopeRefOf({ url, body }))
    const rel = requirePath(body.path, 'remove')
    assertPathAllowed(rel, store)
    if (fixedKindOf(rel) !== undefined) throw new Error(`固定文档不允许删除: ${rel}`)
    if (!existsSync(fileOf(rel, store))) throw new Error(`页面不存在: ${rel}`)
    rmSync(fileOf(rel, store), { force: true })
    invalidate(store.root)
    return { path: rel, message: `已删除: ${rel}` }
  })

  register('/memory-book/search', async ({ url }) => {
    const store = scopeStore(scopeRefOf({ url, body: {} }))
    const query = (url.searchParams.get('q') || '').trim()
    if (query === '') throw new Error('需要检索词')
    const needle = query.toLowerCase()
    const hits = []
    for (const entry of pageEntries(store)) {
      const page = loadPage(entry.rel, store)
      if (page === undefined) continue
      const index = page.text.toLowerCase().indexOf(needle)
      if (index < 0) continue
      hits.push({
        path: page.rel,
        title: titleOfPage(page),
        summary: textOf(page.fields.summary).trim(),
        snippet: snippetAround(page.text, index, query.length),
      })
    }
    return { hits: hits.slice(0, 30), total: hits.length }
  })

  register('/memory-book/history', async ({ url, body }) => {
    const store = scopeStore(scopeRefOf({ url, body }))
    const def = docOfInput(url.searchParams.get('doc') || body.doc)
    if (def === undefined || !def.versioned) {
      throw new Error(`doc 必须是 ${VERSIONED_DOC_NAMES.join(' / ')} 之一`)
    }
    const versions = listVersionEntries(store, def)
    return {
      doc: def.doc,
      label: def.name,
      versions: versions.map((item) => ({
        path: item.rel,
        title: item.title,
        updated: item.updated,
        summary: item.summary,
      })),
    }
  })

  register('/memory-book/resolve', async ({ url }) => {
    const raw = (url.searchParams.get('path') || '').trim()
    const rel = normalizePagePath(raw)
    if (rel === undefined) throw new Error('需要合法的页面路径（例如 wiki/projects/某项目）')
    return { candidates: resolvePageCandidates(rel) }
  })
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  HOST = ctx
  const attached = new Map()
  // 程序化创建的 agent 可能没有 agent.ctx；此时退回根作用域的注入段（只注入全局）。
  let rootSection = null
  let rootUsers = 0

  const attach = (agent) => {
    const id = agent?.id
    if (!id || attached.has(id)) return
    // 主项目在 agent 创建时算一次并缓存，之后不随 cd 变化。
    primaryProject(agent)
    engineStateFor(agent)
    const agentCtx = agent?.ctx
    const scoped = agentCtx && agentCtx.systemPrompt
    const text = () => renderSystem(agent)
    if (scoped !== undefined && scoped !== null && typeof scoped.section === 'function') {
      let dispose
      try {
        dispose = scoped.section({ name: 'memory:system', order: 700, text })
      } catch {
        return
      }
      attached.set(id, dispose)
      return
    }
    if (ctx.systemPrompt === undefined || typeof ctx.systemPrompt.section !== 'function') return
    if (rootSection === null) {
      try {
        rootSection = ctx.systemPrompt.section({ name: 'memory:system', order: 700, text: () => renderSystem(undefined) })
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
    engineStates.clear()
    primaryCache.clear()
    readStates.clear()
  })

  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    forgetAgent(agent?.id)
    detach(agent?.id)
  })
  ctx.on('agent/status', ({ agent, status }) => handleAgentStatus(agent, status))
  ctx.on('session/event', (session, event) => handleSessionEvent(session, event))
  ctx.on('tools/result', (exec, result) => handleToolResult(exec, result))
  ctx.on('agent/error', ({ agent }) => {
    const state = engineStateFor(agent)
    if (state !== undefined) {
      state.pending = null
      state.perTurn = emptyPerTurn()
    }
  })
  for (const agent of ctx.agents.list()) attach(agent)

  registerRoutes(ctx)

  // 参数定义只有这一份：注册 schema 与「拒绝未知参数」共用，避免两处不同步。
  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'brief'],
    properties: {
      action: { type: 'string', enum: ACTION_LIST.split(' / '), description: terseTool() ? '动作' : `操作类型：${ACTION_LIST}。` },
      brief: { type: 'string', description: terseTool() ? '一句话目的（必填）' : '一句话描述此次操作的目的。' },
      path: {
        type: 'string',
        description: terseTool()
          ? '记忆页路径，不带 .md；例如 wiki/concepts/记忆工具用法、project/状态/20261106-2210'
          : '页面路径，不含 .md 后缀。普通页形如 core/核心记忆、wiki/projects/某项目、raw/某来源；'
            + '固定页形如 project/说明及目标、project/经验/<类型>、project/<策划|计划|状态|交接|决策历史>/<版本>。'
            + 'add / read / patch / remove / put 必填。',
      },
      content: {
        type: 'string',
        description: terseTool() ? '' : 'add 时传含 frontmatter 的完整页面；put/record 时传正文（引擎自动生成 frontmatter）。',
      },
      old_string: {
        type: 'string',
        description: terseTool() ? '' : 'patch 时必填：待替换的原文片段，须与页面中的内容完全一致且唯一匹配。',
      },
      new_string: {
        type: 'string',
        description: terseTool() ? '' : 'patch 时必填：替换文本；传空字符串表示删除该片段。',
      },
      query: {
        type: 'string',
        description: terseTool() ? '' : 'search 时的检索关键词，用主题词（项目名、功能名、术语），不要用路径字符串。',
      },
      scope: {
        type: 'string',
        enum: ['current', 'main', 'global'],
        description: terseTool()
          ? '选库：current（默认）/main/global'
          : '选哪个库：current（默认，当前项目：有临时项目就是临时项目，否则主项目）、main（主项目，不受 cd 影响）、global（全局库）。',
      },
      doc: {
        type: 'string',
        enum: ['策划', '计划', '状态', '交接', '决策历史'],
        description: terseTool() ? 'record/history 用：文档名' : 'record / history 用：版本化文档名（策划 / 计划 / 状态 / 交接 / 决策历史）。',
      },
      based_on: {
        type: 'string',
        description: terseTool()
          ? 'record 用：上一版本路径（首个版本传空串）'
          : 'record 必填：上一版本路径（最新版本），用于并发冲突检测；该文档还没有版本时传空字符串。',
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
    async execute(callArgs, exec) {
      const args = callArgs === undefined || callArgs === null ? {} : callArgs
      // 严格校验：不认识参数名就拒，不静默忽略。
      const unknown = Object.keys(args).filter((key) => !Object.hasOwn(parameters.properties, key))
      if (unknown.length > 0) {
        throw new Error(`未知参数：${unknown.map((key) => `「${key}」`).join('')}。可用参数：${allowedParams.join('、')}。`)
      }
      const action = textOf(args.action)
      const handler = ACTIONS[action]
      if (handler === undefined) throw new Error(`未知的 action: ${action}。合法值为 ${ACTION_LIST}。`)
      const agent = exec?.agent
      const session = sessionOf(agent)
      const scope = textOf(args.scope).trim() || 'current'
      let store
      if (scope === 'global') {
        store = makeGlobalStore()
      } else if (scope === 'current' || scope === 'main') {
        const primary = primaryProject(agent)
        if (scope === 'main') {
          if (primary === undefined) throw new Error('本会话没有项目工作区，请用 scope=global。')
          store = primary
        } else {
          const transient = primary === undefined ? undefined : transientProject(agent)
          store = transient ?? primary
          if (store === undefined) throw new Error('本会话没有项目工作区，请用 scope=global。')
        }
        try {
          if (!statSync(store.folder).isDirectory()) throw new Error('项目文件夹不存在')
        } catch {
          throw new Error(`项目目录不存在或不可访问：${store.folder}（请用 scope=global，或先确认工作区目录还在）`)
        }
      } else {
        throw new Error(`未知的 scope: ${scope}。合法值为 current / main / global。`)
      }
      const env = { store, agent, session }
      try {
        const result = handler(args, env)
        return { message: action === 'read' ? result : storeLabel(store) + result }
      } catch (error) {
        const message = String(error?.message || error)
        throw new Error(storeLabel(store) + message)
      }
    },
  })
}

/** 实例是否提供自定义工具卡：参数说明走精简版。 */
function terseTool() {
  try {
    return hasToolOverride()
  } catch {
    return false
  }
}
