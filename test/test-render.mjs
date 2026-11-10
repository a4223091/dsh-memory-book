/**
 * 记忆面板渲染冒烟测试：最小 React 运行时真跑组件树。
 * 覆盖：记忆范围下拉、项目文档页签（6 类固定文档 + 项目经验）、历史版本只读、
 * 固定页可编辑但无删除按钮、核心记忆/知识库、配置 10 项、全局/项目空态、临时项目提示条、
 * 引用跨库跳转。接口全部按设计稿 §8.1 用桩数据返回。
 *
 * 用法：node test-render.mjs <插件目录>
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const pluginDir = process.argv[2]
if (!pluginDir) {
  console.error('用法: node test-render.mjs <插件目录>')
  process.exit(2)
}

const failures = []
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── 最小 React 运行时 ────────────────────────────────────────────────────────
let slots = []
let slotIndex = 0
let effects = []
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }),
  useState: (initial) => {
    const index = slotIndex++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  },
  useEffect: (fn) => {
    slotIndex += 1
    effects.push(fn)
  },
  useCallback: (fn) => {
    slotIndex += 1
    return fn
  },
  useMemo: (fn) => {
    slotIndex += 1
    return fn()
  },
  useRef: (value) => {
    const index = slotIndex++
    if (!(index in slots)) slots[index] = { current: value }
    return slots[index]
  },
}

function renderTree(element, depth = 0) {
  if (depth > 80) throw new Error('渲染层级过深')
  if (element === null || element === undefined || element === false) return null
  if (typeof element === 'string' || typeof element === 'number') return element
  if (Array.isArray(element)) return element.map((child) => renderTree(child, depth + 1))
  if (typeof (element && element.type) === 'function') {
    return renderTree(element.type({ ...element.props, children: element.children }), depth + 1)
  }
  return { type: element.type, props: element.props || {}, children: (element.children || []).map((child) => renderTree(child, depth + 1)) }
}

function textOfTree(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOfTree(child, out)
    return out
  }
  if (typeof node === 'object') {
    const { props, children } = node
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key !== 'children' && (typeof value === 'string' || typeof value === 'number')) out.push(String(value))
      }
    }
    if (Array.isArray(children)) textOfTree(children, out)
  }
  return out
}

function findAll(tree, predicate, out = []) {
  if (tree === null || tree === undefined || tree === false) return out
  if (Array.isArray(tree)) {
    for (const child of tree) findAll(child, predicate, out)
    return out
  }
  if (typeof tree !== 'object') return out
  if (predicate(tree)) out.push(tree)
  if (Array.isArray(tree.children)) for (const child of tree.children) findAll(child, predicate, out)
  return out
}

function findClickable(tree, needle) {
  const matches = findAll(tree, (node) => typeof node.props?.onClick === 'function' && textOfTree(node).join('').includes(needle))
  // 取最深的一个：父节点也可点击时（如文档行里套着「历史版本」按钮），点击里面的按钮。
  return matches.length > 0 ? matches[matches.length - 1] : undefined
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function settle(component, props, rounds = 5) {
  let tree = null
  for (let index = 0; index < rounds; index += 1) {
    slotIndex = 0
    effects = []
    tree = renderTree(React.createElement(component, props || {}))
    for (const effect of effects) {
      try {
        effect()
      } catch (error) {
        // 副作用里的错误交由断言暴露
      }
    }
    await tick()
    await tick()
  }
  return tree
}
async function mountComponent(component, props, rounds = 5) {
  slots = []
  return settle(component, props, rounds)
}
async function clickAndRender(tree, needle, rounds = 4) {
  const target = findClickable(tree, needle)
  if (target === undefined) throw new Error(`找不到可点击的「${needle}」`)
  target.props.onClick({})
  return settle(Panel, {}, rounds)
}
async function selectScope(tree, value, rounds = 5) {
  const selectNode = findAll(tree, (node) => node.type === 'select')[0]
  if (selectNode === undefined) throw new Error('找不到记忆范围下拉')
  selectNode.props.onChange({ target: { value } })
  return settle(Panel, {}, rounds)
}

// ── 伪造浏览器环境 ──────────────────────────────────────────────────────────
let loaded
const memoryStore = new Map()
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.window = {
  confirm: () => false,
  localStorage: {
    getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, String(value)),
    removeItem: (key) => memoryStore.delete(key),
  },
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}

// ── 桩数据（按设计稿 §8.1 的字段） ──────────────────────────────────────────
const calls = []
const state = { transient: false, resolve: [] }

const settingDefaults = {
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
const settingLimits = {
  coreChars: [300, 8000],
  mainCoreChars: [300, 12000],
  transientCoreChars: [0, 4000],
  indexChars: [200, 6000],
  mainIndexChars: [200, 8000],
  transientIndexChars: [0, 6000],
  pagesPerDir: [1, 50],
  fallbackRounds: [1, 50],
  handoverChanges: [1, 50],
}
const categories = [
  { key: 'projects', label: '项目', count: 1 },
  { key: 'concepts', label: '概念', count: 0 },
  { key: 'lessons', label: '经验', count: 0 },
  { key: 'profile', label: '用户画像', count: 0 },
  { key: 'entities', label: '实体', count: 0 },
  { key: 'raw', label: '源文件', count: 0 },
]
function docsOf(created) {
  const base = [
    ['brief', '说明及目标'],
    ['planning', '策划'],
    ['plan', '计划'],
    ['status', '状态'],
    ['handover', '交接'],
    ['decisions', '决策历史'],
  ]
  return base.map(([doc, label]) => {
    if (doc === 'status') {
      return { doc, label, missing: false, latestPath: 'project/状态/20261106-2210', latestTitle: '状态 20261106-2210', updated: '2026-11-06T14:10:00Z', versions: 3, chars: 600 }
    }
    if (doc === 'brief' && created) {
      return { doc, label, missing: false, latestPath: 'project/说明及目标', latestTitle: '说明及目标', updated: '2026-11-06T10:00:00Z', versions: 0, chars: 860 }
    }
    if (doc === 'brief') return { doc, label, missing: true, latestPath: '', latestTitle: '', updated: '', versions: 0, chars: 0 }
    return { doc, label, missing: true, latestPath: '', latestTitle: '', updated: '', versions: 0, chars: 0 }
  })
}

function projectLibrary(scopePath, scopeTitle, created, empty) {
  const data = {
    ok: true,
    scope: { kind: 'project', title: scopeTitle, path: scopePath, memoryRoot: scopePath + '\\.memory-book' },
    settings: { ...settingDefaults },
    defaults: { ...settingDefaults },
    limits: settingLimits,
    pages: empty
      ? []
      : [
          { path: 'core/核心记忆', category: 'core', categoryLabel: '核心记忆', title: '核心记忆', summary: '每轮必守', sources: [], related: [], chars: 120, updated: '2026-11-06T10:00:00Z', core: true },
          { path: 'wiki/projects/甲', category: 'projects', categoryLabel: '项目', title: '甲页', summary: '项目页面', sources: ['raw/缺失引用'], related: ['wiki/projects/乙'], chars: 300, updated: '2026-11-05T10:00:00Z', core: false },
        ],
    categories,
    docs: docsOf(created),
    experiences: empty ? [] : [{ type: '构建坑', path: 'project/经验/构建坑', title: '构建坑', updated: '2026-11-06T09:00:00Z' }],
    injected: { totalChars: empty ? 0 : 900, coreLimit: 1200, indexLimit: 1000 },
    counts: { all: empty ? 0 : 1, core: empty ? 0 : 1, wiki: empty ? 0 : 1, raw: 0 },
  }
  if (state.transient) {
    data.transient = { kind: 'project', title: '临时项目X', path: 'C:\\work\\T', memoryRoot: 'C:\\work\\T\\.memory-book' }
  }
  return data
}

function globalLibrary() {
  return {
    ok: true,
    scope: { kind: 'global', title: '全局记忆库', path: 'C:\\Users\\x\\.dsh\\memory', memoryRoot: 'C:\\Users\\x\\.dsh\\memory' },
    settings: { ...settingDefaults },
    defaults: { ...settingDefaults },
    limits: settingLimits,
    pages: [
      { path: 'core/核心记忆', category: 'core', categoryLabel: '核心记忆', title: '核心记忆', summary: '每轮必守', sources: [], related: [], chars: 120, updated: '2026-11-06T10:00:00Z', core: true },
      { path: 'wiki/profile/用户画像', category: 'profile', categoryLabel: '用户画像', title: '用户画像', summary: '使用者是谁', sources: [], related: [], chars: 500, updated: '2026-10-25T10:00:00Z', core: false },
    ],
    categories,
    docs: [],
    experiences: [],
    injected: { totalChars: 620, coreLimit: 1200, indexLimit: 1000 },
    counts: { all: 1, core: 1, wiki: 1, raw: 0 },
  }
}

function libraryFor(target) {
  if (target.includes('scope=global')) return globalLibrary()
  if (target.includes('workspaceId=ws-empty')) return projectLibrary('C:\\work\\空项目', '空项目', false, true)
  if (target.includes('workspaceId=ws-temp')) return projectLibrary('C:\\work\\T', '临时项目', false, false)
  return projectLibrary('C:\\work\\示例项目', '示例项目', true, false)
}

const pageCore = {
  ok: true,
  path: 'core/核心记忆',
  content: '---\ntitle: 核心记忆\nsummary: 每轮必守\n---\n\n# 工作区路由\n\n先按 cwd 判断。\n',
  body: '# 工作区路由\n\n先按 cwd 判断。\n',
  fields: { title: '核心记忆', summary: '每轮必守的短规则', sources: [], related: [] },
  category: 'core',
  categoryLabel: '核心记忆',
  updated: '2026-11-06T10:00:00Z',
}
const pageBrief = {
  ok: true,
  path: 'project/说明及目标',
  content: '---\ntitle: 说明及目标\nsummary: 这个项目要做什么\n---\n\n# 目标\n\n把记忆按项目分开。\n',
  body: '# 目标\n\n把记忆按项目分开。\n',
  fields: { title: '说明及目标', summary: '这个项目要做什么', sources: [], related: [] },
  category: 'fixed',
  categoryLabel: '固定文档',
  updated: '2026-11-06T10:00:00Z',
  meta: { fixed: true, versioned: false, doc: 'brief', readOnly: false },
}
function statusPage(pathValue, readOnly) {
  return {
    ok: true,
    path: pathValue,
    content: '---\ntitle: 状态\nsummary: 已完成\n---\n\n# 状态\n\n已完成。\n',
    body: '# 状态\n\n已完成。\n',
    fields: { title: pathValue, summary: '已完成', sources: [], related: [] },
    category: 'fixed',
    categoryLabel: '固定文档',
    updated: '2026-11-06T14:10:00Z',
    meta: { fixed: true, versioned: true, doc: 'status', readOnly },
  }
}
const pageWiki = {
  ok: true,
  path: 'wiki/projects/甲',
  content: '---\ntitle: 甲页\nsummary: 项目页面\n---\n\n# 甲页\n',
  body: '# 甲页\n',
  fields: { title: '甲页', summary: '项目页面', sources: ['raw/缺失引用'], related: ['wiki/projects/乙'] },
  category: 'projects',
  categoryLabel: '项目',
  updated: '2026-11-05T10:00:00Z',
  meta: { fixed: false, versioned: false, readOnly: false },
}
const pageWikiB = {
  ok: true,
  path: 'wiki/projects/乙',
  content: '---\ntitle: 乙页\nsummary: 另一个库里的页\n---\n\n# 乙页\n',
  body: '# 乙页\n',
  fields: { title: '乙页', summary: '另一个库里的页', sources: [], related: [] },
  category: 'projects',
  categoryLabel: '项目',
  updated: '2026-11-01T10:00:00Z',
  meta: { fixed: false, versioned: false, readOnly: false },
}
const pageMap = {
  'core/核心记忆': pageCore,
  'project/说明及目标': pageBrief,
  'project/状态/20261106-2210': statusPage('project/状态/20261106-2210', false),
  'project/状态/20261105-1200': statusPage('project/状态/20261105-1200', true),
  'project/状态/20261104-0900': statusPage('project/状态/20261104-0900', true),
  'wiki/projects/甲': pageWiki,
  'wiki/projects/乙': pageWikiB,
}

globalThis.fetch = async (url) => {
  const target = String(url)
  calls.push(target)
  let payload = { ok: false, message: '页面不存在' }
  if (target === '/memory-book/projects') {
    payload = {
      ok: true,
      global: { path: 'C:\\Users\\x\\.dsh\\memory', memoryRoot: 'C:\\Users\\x\\.dsh\\memory', pages: 2, chars: 620 },
      projects: [
        { workspaceId: 'ws-main', path: 'C:\\work\\示例项目', title: '示例项目', exists: true, hasMemory: true, pages: 2, chars: 900 },
        { workspaceId: 'ws-empty', path: 'C:\\work\\空项目', title: '空项目', exists: true, hasMemory: false, pages: 0, chars: 0 },
        { workspaceId: 'ws-temp', path: 'C:\\work\\T', title: '临时项目', exists: true, hasMemory: false, pages: 0, chars: 0 },
      ],
    }
  } else if (target.startsWith('/memory-book/library')) {
    payload = libraryFor(target)
  } else if (target.startsWith('/memory-book/page')) {
    const parsed = new URL(target, 'http://local')
    const pagePath = parsed.searchParams.get('path') || ''
    payload = pageMap[pagePath] || { ok: false, message: '页面不存在' }
  } else if (target.startsWith('/memory-book/history')) {
    const parsed = new URL(target, 'http://local')
    const doc = parsed.searchParams.get('doc')
    payload = {
      ok: true,
      doc,
      versions:
        doc === 'status'
          ? [
              { path: 'project/状态/20261106-2210', title: '状态 20261106-2210', updated: '2026-11-06T14:10:00Z', summary: '已完成' },
              { path: 'project/状态/20261105-1200', title: '状态 20261105-1200', updated: '2026-11-05T12:00:00Z', summary: '进行中' },
              { path: 'project/状态/20261104-0900', title: '状态 20261104-0900', updated: '2026-11-04T09:00:00Z', summary: '刚起步' },
            ]
          : [],
    }
  } else if (target.startsWith('/memory-book/resolve')) {
    payload = { ok: true, candidates: state.resolve }
  } else if (target === '/memory-book/settings') {
    payload = { ok: true, settings: { ...settingDefaults } }
  }
  return { json: async () => payload }
}

// ── 加载客户端模块并取出主面板 ───────────────────────────────────────────────
await import(pathToFileURL(path.join(pluginDir, 'client.js')).href)
const moduleExports = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`意外的 require: ${name}`)
})
const registered = []
moduleExports.apply({
  slots: {
    inject: (_slotName, callback) => callback(),
    register: (spec, component) => {
      registered.push({ spec, component })
      return () => {}
    },
  },
  layout: { selectPanel: () => {} },
})
const Panel = registered.find((item) => item.spec?.name === 'main')?.component
check('找到 main 面板组件', typeof Panel === 'function')

// ── 场景 A：项目库默认（项目文档页签） ───────────────────────────────────────
let tree = await mountComponent(Panel, {}, 5)
let text = textOfTree(tree).join(' | ')

check('渲染「记忆范围」下拉', text.includes('记忆范围'))
check('下拉包含全局记忆库', text.includes('全局记忆库'))
check('下拉包含工作区标题与路径', text.includes('示例项目') && text.includes('C:\\work\\示例项目'))
check('下拉标注是否有记忆', text.includes('有记忆') && text.includes('无记忆'))
check('默认选中第一个有记忆的项目（ws:ws-main）', text.includes('ws:ws-main'), '未出现 ws:ws-main')
check('四个页签齐全', text.includes('项目文档') && text.includes('核心记忆') && text.includes('知识库') && text.includes('配置'))
check('默认打开项目文档页签', text.includes('固定文档'))
check(
  '固定文档 6 类齐全',
  ['说明及目标', '策划', '计划', '状态', '交接', '决策历史'].every((label) => text.includes(label)),
)
check('项目经验区显示类型页', text.includes('项目经验') && text.includes('构建坑'))
check('版本化文档显示历史版本数量', text.includes('历史版本（3）'))
check('缺失的固定文档提示必须创建', text.includes('未创建'))

// 历史版本：点「历史版本（3）」→ 列表（新→旧）
let historyView
try {
  historyView = await clickAndRender(tree, '历史版本（3）')
} catch (error) {
  check('打开历史版本列表不抛错', false, String(error?.message || error))
}
if (historyView !== undefined) {
  const historyText = textOfTree(historyView).join(' | ')
  check('历史版本列表按新→旧列出 3 个版本', ['20261106-2210', '20261105-1200', '20261104-0900'].every((item) => historyText.includes(item)))
  check('历史版本提示只读', historyText.includes('只读'))

  // 点开一个旧版本：只读，没有编辑/删除按钮
  let oldVersion
  try {
    oldVersion = await clickAndRender(historyView, '状态 20261105-1200')
  } catch (error) {
    check('打开历史版本不抛错', false, String(error?.message || error))
  }
  if (oldVersion !== undefined) {
    const oldText = textOfTree(oldVersion).join(' | ')
    check('历史版本详情标出只读', oldText.includes('只读'))
    check('历史版本没有编辑按钮', !oldText.includes('编辑'))
    check('历史版本没有删除按钮', !oldText.includes('删除'))
    // 返回：详情 → 历史版本 → 文档列表
    tree = await clickAndRender(oldVersion, '返回')
    tree = await clickAndRender(tree, '返回文档')
  }
}
if (historyView === undefined) tree = await settle(Panel, {}, 3)

// 固定页（说明及目标）：可编辑、无删除按钮
try {
  const brief = await clickAndRender(tree, '说明及目标')
  const briefText = textOfTree(brief).join(' | ')
  check('固定页显示编辑入口', briefText.includes('编辑'))
  check('固定页不显示删除按钮', !briefText.includes('删除'))
  check('固定页标记「固定文档」', briefText.includes('固定文档'))
  tree = await clickAndRender(brief, '返回')
} catch (error) {
  check('打开固定页不抛错', false, String(error?.message || error))
}

// ── 场景 B：核心记忆页签 ────────────────────────────────────────────────────
try {
  tree = await clickAndRender(tree, '核心记忆')
  const coreText = textOfTree(tree).join(' | ')
  check('核心页签显示正文', coreText.includes('工作区路由'))
  check('核心页签有编辑入口', coreText.includes('编辑'))
} catch (error) {
  check('切核心页签不抛错', false, String(error?.message || error))
}

// ── 场景 C：知识库 + 引用跨库跳转 ───────────────────────────────────────────
try {
  tree = await clickAndRender(tree, '知识库')
  let libraryText = textOfTree(tree).join(' | ')
  check('知识库显示分类与卡片', libraryText.includes('全部') && libraryText.includes('甲页'))
  check('知识库显示每轮注入字符数', libraryText.includes('900'))

  const detail = await clickAndRender(tree, '甲页')
  const detailText = textOfTree(detail).join(' | ')
  check('知识详情有摘要/正文/来源/关联', detailText.includes('摘要') && detailText.includes('正文') && detailText.includes('来源') && detailText.includes('关联'))

  // 本库找不到的引用 → /resolve 跨库；单条命中直接跳转
  state.resolve = [
    { kind: 'project', workspaceId: 'ws-empty', title: '乙页', path: 'wiki/projects/乙', workspaceTitle: '空项目' },
  ]
  calls.length = 0
  const afterResolve = await clickAndRender(detail, '缺失引用')
  const resolveText = textOfTree(afterResolve).join(' | ')
  check('引用解析后打开目标页', resolveText.includes('乙页'))
  check(
    '引用跳转切到目标库（library 带 workspaceId=ws-empty）',
    calls.some((url) => url.startsWith('/memory-book/library') && url.includes('workspaceId=ws-empty')),
    calls.join(', '),
  )
  state.resolve = []
} catch (error) {
  check('知识库与引用跳转不抛错', false, String(error?.message || error))
}

// ── 场景 D：空项目空态 ──────────────────────────────────────────────────────
try {
  tree = await selectScope(tree, 'ws:ws-empty')
  tree = await clickAndRender(tree, '知识库')
  const emptyText = textOfTree(tree).join(' | ')
  check('空项目提示首次写入自动创建', emptyText.includes('这个项目还没有记忆，首次写入时自动创建'))
} catch (error) {
  check('切空项目不抛错', false, String(error?.message || error))
}

// ── 场景 E：临时项目提示条 + 跳转 ───────────────────────────────────────────
state.transient = true
try {
  tree = await selectScope(tree, 'ws:ws-main')
  const bannerText = textOfTree(tree).join(' | ')
  check('显示临时项目提示条', bannerText.includes('当前工作目录属于：') && bannerText.includes('临时项目X'))
  calls.length = 0
  tree = await clickAndRender(tree, '跳转到该项目')
  const jumpedText = textOfTree(tree).join(' | ')
  check('临时项目跳转后下拉切到该项目', jumpedText.includes('ws:ws-temp'), '未出现 ws:ws-temp')
  check(
    '临时项目跳转按 workspaceId 加载',
    calls.some((url) => url.startsWith('/memory-book/library') && url.includes('workspaceId=ws-temp')),
    calls.join(', '),
  )
} catch (error) {
  check('临时项目提示条不抛错', false, String(error?.message || error))
}
state.transient = false

// ── 场景 F：配置 10 项 ─────────────────────────────────────────────────────
try {
  tree = await clickAndRender(tree, '配置')
  const settingsText = textOfTree(tree).join(' | ')
  const labels = [
    '全局核心记忆上限（字符）',
    '主项目核心记忆上限（字符）',
    '临时项目核心记忆上限（字符）',
    '全局索引上限（字符）',
    '主项目索引上限（字符）',
    '临时项目索引上限（字符）',
    '每个目录最多显示页数',
    '兜底提醒间隔（轮）',
    '交接间隔（次实质变化）',
    '自动补更轮（触发即强制跑）',
  ]
  check('配置页显示 10 项设置', labels.every((label) => settingsText.includes(label)), labels.filter((label) => !settingsText.includes(label)).join(', '))
  check('配置显示默认值', settingsText.includes('1200') && settingsText.includes('3000') && settingsText.includes('2500'))
  check('配置有保存与恢复默认', settingsText.includes('保存') && settingsText.includes('恢复默认'))
  check('配置有 9 个数字输入框', findAll(tree, (node) => node.type === 'input' && node.props.type === 'number').length === 9)
  check('配置有 1 个自动补更开关', findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox').length === 1)
} catch (error) {
  check('打开配置页不抛错', false, String(error?.message || error))
}

if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nOK: 面板渲染冒烟测试通过（0 失败）')
