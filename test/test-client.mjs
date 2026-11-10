/**
 * memory-book 客户端半边的离线自测：不启动浏览器，只验证模块契约、slot 注册、
 * 会话页眉「本项目记忆」按钮、记忆范围下拉与各接口的定位参数（scope/workspaceId/sessionId）。
 *
 * 用法：node test-client.mjs <插件目录>
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const pluginDir = process.argv[2]
if (!pluginDir) {
  console.error('用法: node test-client.mjs <插件目录>')
  process.exit(2)
}

const failures = []
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ── 最小 React 运行时（只需 hooks，足以驱动组件里的状态与副作用） ─────────────
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
  // 取最深的一个：父节点也可点击时，优先点里面的按钮/子项。
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
        // 副作用里的错误由断言暴露，不在这里吞掉流程
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

// ── 伪造浏览器环境 ──────────────────────────────────────────────────────────
let loaded
const memoryStore = new Map()
const localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.window = {
  confirm: () => true,
  localStorage,
  __ModuleLoader__: {
    load: (definition) => {
      loaded = definition
    },
  },
}

// 接口桩：记录每次请求的 URL，并按路径返回设计稿 §8.1 形状的数据。
const calls = []
const CORE_PAGE = {
  ok: true,
  path: 'core/核心记忆',
  content: '---\ntitle: 核心记忆\nsummary: 每轮必守\n---\n\n# 铁律\n',
  body: '# 铁律\n',
  fields: { title: '核心记忆', summary: '每轮必守', sources: [], related: [] },
  category: 'core',
  categoryLabel: '核心记忆',
  updated: '2026-11-06T10:00:00Z',
}
const DOC_PAGE = {
  ok: true,
  path: 'project/状态/20261106-2210',
  content: '---\ntitle: 状态\nsummary: 已完成\n---\n\n# 状态\n',
  body: '# 状态\n',
  fields: { title: '状态 20261106-2210', summary: '已完成', sources: [], related: [] },
  category: 'fixed',
  categoryLabel: '固定文档',
  updated: '2026-11-06T14:10:00Z',
  meta: { fixed: true, versioned: true, doc: 'status', readOnly: false },
}
function projectLibrary() {
  return {
    ok: true,
    scope: { kind: 'project', title: '项目A', path: 'C:\\work\\A', memoryRoot: 'C:\\work\\A\\.memory-book' },
    settings: { coreChars: 1200, mainCoreChars: 3000, transientCoreChars: 800, indexChars: 1000, mainIndexChars: 2500, transientIndexChars: 1200, pagesPerDir: 8, fallbackRounds: 5, handoverChanges: 5, autoFollowup: true },
    defaults: { coreChars: 1200, mainCoreChars: 3000, transientCoreChars: 800, indexChars: 1000, mainIndexChars: 2500, transientIndexChars: 1200, pagesPerDir: 8, fallbackRounds: 5, handoverChanges: 5, autoFollowup: true },
    limits: { coreChars: [300, 8000], mainCoreChars: [300, 12000], transientCoreChars: [0, 4000], indexChars: [200, 6000], mainIndexChars: [200, 8000], transientIndexChars: [0, 6000], pagesPerDir: [1, 50], fallbackRounds: [1, 50], handoverChanges: [1, 50] },
    pages: [
      { path: 'core/核心记忆', category: 'core', categoryLabel: '核心记忆', title: '核心记忆', summary: '每轮必守', sources: [], related: [], chars: 120, updated: '2026-11-06T10:00:00Z', core: true },
      { path: 'wiki/projects/甲', category: 'projects', categoryLabel: '项目', title: '甲页', summary: '项目页面', sources: [], related: [], chars: 300, updated: '2026-11-05T10:00:00Z', core: false },
    ],
    categories: [{ key: 'projects', label: '项目', count: 1 }],
    docs: [
      { doc: 'brief', label: '说明及目标', missing: false, latestPath: 'project/说明及目标', latestTitle: '说明及目标', updated: '2026-11-06T10:00:00Z', versions: 0, chars: 800 },
      { doc: 'planning', label: '策划', missing: true, latestPath: '', latestTitle: '', updated: '', versions: 0, chars: 0 },
      { doc: 'plan', label: '计划', missing: true, latestPath: '', latestTitle: '', updated: '', versions: 0, chars: 0 },
      { doc: 'status', label: '状态', missing: false, latestPath: 'project/状态/20261106-2210', latestTitle: '状态 20261106-2210', updated: '2026-11-06T14:10:00Z', versions: 3, chars: 600 },
      { doc: 'handover', label: '交接', missing: true, latestPath: '', latestTitle: '', updated: '', versions: 0, chars: 0 },
      { doc: 'decisions', label: '决策历史', missing: true, latestPath: '', latestTitle: '', updated: '', versions: 0, chars: 0 },
    ],
    experiences: [{ type: '构建坑', path: 'project/经验/构建坑', title: '构建坑', updated: '2026-11-06T09:00:00Z' }],
    injected: { totalChars: 900, coreLimit: 1200, indexLimit: 1000 },
    counts: { all: 1, core: 1, wiki: 1, raw: 0 },
  }
}
function globalLibrary() {
  const data = projectLibrary()
  data.scope = { kind: 'global', title: '全局记忆库', path: 'C:\\Users\\x\\.dsh\\memory', memoryRoot: 'C:\\Users\\x\\.dsh\\memory' }
  data.pages = []
  data.docs = []
  data.experiences = []
  data.counts = { all: 0, core: 0, wiki: 0, raw: 0 }
  return data
}
globalThis.fetch = async (url) => {
  const target = String(url)
  calls.push(target)
  let payload = { ok: false, message: 'unexpected ' + target }
  if (target === '/memory-book/projects') {
    payload = {
      ok: true,
      global: { path: 'C:\\Users\\x\\.dsh\\memory', memoryRoot: 'C:\\Users\\x\\.dsh\\memory', pages: 3, chars: 400 },
      projects: [
        { workspaceId: 'ws-a', path: 'C:\\work\\A', title: '项目A', exists: true, hasMemory: true, pages: 5, chars: 900 },
        { workspaceId: 'ws-b', path: 'C:\\work\\B', title: '项目B', exists: true, hasMemory: false, pages: 0, chars: 0 },
      ],
    }
  } else if (target.startsWith('/memory-book/library')) {
    // 全局库与「无记忆的项目 B」都返回空库，方便校验空态与定位参数
    const empty = target.includes('scope=global') || target.includes('workspaceId=ws-b')
    payload = empty ? globalLibrary() : projectLibrary()
  } else if (target.startsWith('/memory-book/page')) {
    payload = target.includes(encodeURIComponent('core/核心记忆')) ? CORE_PAGE : DOC_PAGE
  } else if (target.startsWith('/memory-book/search')) {
    // Host 的 /search 返回 hits（不是 pages），面板要兼容
    payload = { ok: true, hits: [{ path: 'wiki/projects/甲', title: '甲页', summary: '项目页面' }], total: 1 }
  } else if (target.startsWith('/memory-book/history')) {
    payload = { ok: true, doc: 'status', versions: [{ path: 'project/状态/20261106-2210', title: '状态 20261106-2210', updated: '2026-11-06T14:10:00Z', summary: '已完成' }] }
  } else if (target.startsWith('/memory-book/resolve')) {
    payload = { ok: true, candidates: [] }
  } else if (target === '/memory-book/settings') {
    payload = { ok: true }
  }
  return { json: async () => payload }
}

// ── 加载客户端模块 ───────────────────────────────────────────────────────────
await import(pathToFileURL(path.join(pluginDir, 'client.js')).href)

check('调用 __ModuleLoader__.load', loaded !== undefined)
check('模块 id 与包名一致', loaded?.id === '@local/dsh-memory-book', String(loaded?.id))
check('factory 是函数', typeof loaded?.factory === 'function')

const exportsObject = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`意外的 require: ${name}`)
})

check('inject 声明了 slots', Array.isArray(exportsObject?.inject) && exportsObject.inject.includes('slots'), JSON.stringify(exportsObject?.inject))
check('inject 声明了 layout（布局服务）', Array.isArray(exportsObject?.inject) && exportsObject.inject.includes('layout'), JSON.stringify(exportsObject?.inject))

const registered = []
const selectedPanels = []
const fakeCtx = {
  slots: {
    // 真实 API 是先 inject 再 register；测试里直接执行回调。
    inject: (_slotName, callback) => callback(),
    register: (spec, component) => {
      registered.push({ spec, component })
      return () => {}
    },
  },
  layout: {
    selectPanel: (id) => selectedPanels.push(id),
  },
}
exportsObject.apply(fakeCtx)

const sidebar = registered.find((item) => item.spec?.name === 'sidebar.panellist')
const main = registered.find((item) => item.spec?.name === 'main')
const header = registered.find((item) => item.spec?.name === 'conversation.session.header.utilities')

check('注册了 sidebar.panellist 图标', sidebar !== undefined)
check('sidebar 的 id 是 memory-book', sidebar?.spec?.id === 'memory-book', String(sidebar?.spec?.id))
check('sidebar 有 label', typeof sidebar?.spec?.label === 'string' && sidebar.spec.label.length > 0, String(sidebar?.spec?.label))
check('注册了 main 面板', main !== undefined)
check('main 的 key 与侧栏 id 对应', main?.spec?.key === 'memory-book', String(main?.spec?.key))
check('两个入口都带了组件', typeof sidebar?.component === 'function' && typeof main?.component === 'function')
check('注册了会话页眉插槽 conversation.session.header.utilities', header !== undefined)
check('页眉注册项有 id', header?.spec?.id === 'memory-book', String(header?.spec?.id))
check('页眉注册项有 label', typeof header?.spec?.label === 'string' && header.spec.label.includes('本项目记忆'), String(header?.spec?.label))

// ── 场景 0：优先使用 localStorage 里的上次选择 ──────────────────────────────
const Panel = main?.component
memoryStore.set('dsh.memory-book.scope', JSON.stringify({ kind: 'project', workspaceId: 'ws-b' }))
calls.length = 0
await mountComponent(Panel, {}, 4)
check(
  '优先使用 localStorage 上次选择的项目（ws-b，即使它没有记忆）',
  calls.some((url) => url.startsWith('/memory-book/library') && url.includes('workspaceId=ws-b')),
  calls.filter((url) => url.includes('/library')).join(', '),
)
memoryStore.clear()

// ── 场景 1：面板默认范围 = 第一个有记忆的项目，接口带 workspaceId ──────────────
calls.length = 0
let tree = await mountComponent(Panel, {}, 5)
let text = textOfTree(tree).join(' | ')

check('拉取了 /projects', calls.some((url) => url === '/memory-book/projects'), calls.slice(0, 4).join(', '))
check(
  '默认选第一个有记忆的项目（library 带 workspaceId）',
  calls.some((url) => url.startsWith('/memory-book/library') && url.includes('workspaceId=ws-a')),
  calls.filter((url) => url.includes('/library')).join(', '),
)
check(
  '核心记忆读取带 workspaceId',
  calls.some((url) => url.includes('/page?path=') && url.includes(encodeURIComponent('core/核心记忆')) && url.includes('workspaceId=ws-a')),
  calls.filter((url) => url.includes('/page?')).join(', '),
)
check('渲染「记忆范围」下拉', text.includes('记忆范围') && text.includes('全局记忆库'))
check('下拉包含各工作区（标题+有无记忆）', text.includes('项目A') && text.includes('有记忆') && text.includes('项目B') && text.includes('无记忆'))
check('渲染四个页签', text.includes('项目文档') && text.includes('核心记忆') && text.includes('知识库') && text.includes('配置'))

// 打开「状态」固定文档：页面请求要带当前库定位参数
const docRow = findClickable(tree, '状态')
check('项目文档页签有可点击的固定文档行', docRow !== undefined)
if (docRow !== undefined) {
  docRow.props.onClick({})
  await settle(Panel, {}, 3)
  check(
    '打开固定文档的 /page 请求带 workspaceId',
    calls.some((url) => url.includes('/page?path=') && url.includes(encodeURIComponent('project/状态/20261106-2210')) && url.includes('workspaceId=ws-a')),
    calls.filter((url) => url.includes('/page?')).join(', '),
  )
}

// ── 场景 2：切换下拉到全局 → library 用 scope=global ─────────────────────────
tree = await settle(Panel, {}, 3)
const selectNode = findAll(tree, (node) => node.type === 'select')[0]
check('面板顶部有 select 下拉', selectNode !== undefined)
if (selectNode !== undefined) {
  selectNode.props.onChange({ target: { value: 'global' } })
  calls.length = 0
  tree = await settle(Panel, {}, 4)
  check(
    '切到全局后 library 带 scope=global',
    calls.some((url) => url.startsWith('/memory-book/library') && url.includes('scope=global')),
    calls.filter((url) => url.includes('/library')).join(', '),
  )
  check(
    '切到全局后核心记忆读取带 scope=global',
    calls.some((url) => url.includes('/page?path=') && url.includes(encodeURIComponent('core/核心记忆')) && url.includes('scope=global')),
    calls.filter((url) => url.includes('/page?')).join(', '),
  )
}

// ── 场景 2.5：知识库搜索走 /search（Host 返回 hits，不是 pages） ─────────────
try {
  tree = await clickAndRender(tree, '知识库')
  const searchInput = findAll(tree, (node) => node.type === 'input' && node.props.placeholder === '请输入内容')[0]
  check('知识库有搜索框', searchInput !== undefined)
  if (searchInput !== undefined) {
    calls.length = 0
    searchInput.props.onChange({ target: { value: '甲' } })
    tree = await settle(Panel, {}, 4)
    check(
      '搜索请求带 q 与 scope=global',
      calls.some((url) => url.startsWith('/memory-book/search') && url.includes('q=') && url.includes('scope=global')),
      calls.filter((url) => url.includes('/search')).join(', '),
    )
    check('兼容 Host 的 hits 返回并渲染命中页', textOfTree(tree).join(' ').includes('甲页'))
  }
} catch (error) {
  check('知识库搜索不抛错', false, String(error?.message || error))
}

// ── 场景 3：页眉按钮 → 定位会话主项目 + 打开面板 ─────────────────────────────
check('页眉组件是函数', typeof header?.component === 'function')
if (header?.component) {
  calls.length = 0
  selectedPanels.length = 0
  const headerTree = await mountComponent(header.component, { sessionId: 'sess-1' }, 2)
  const headerText = textOfTree(headerTree).join(' | ')
  check('页眉按钮显示「本项目记忆」', headerText.includes('本项目记忆'))
  const button = findClickable(headerTree, '本项目记忆')
  check('页眉按钮可点击', button !== undefined)
  if (button !== undefined) {
    button.props.onClick({})
    for (let index = 0; index < 4; index += 1) await tick()
    check(
      '页眉按钮用 sessionId 定位主项目（library 带 sessionId）',
      calls.some((url) => url.startsWith('/memory-book/library') && url.includes('sessionId=sess-1')),
      calls.join(', '),
    )
    check('页眉按钮调用 layout.selectPanel("memory-book")', selectedPanels.includes('memory-book'), JSON.stringify(selectedPanels))
  }

  // 焦点写进 store 后，面板挂载时会按 sessionId 定位
  calls.length = 0
  await mountComponent(Panel, {}, 4)
  check(
    '面板按页眉焦点用 sessionId 加载',
    calls.some((url) => url.startsWith('/memory-book/library') && url.includes('sessionId=sess-1')),
    calls.filter((url) => url.includes('/library')).join(', '),
  )
}

if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\nOK: 客户端模块契约、slot 注册、页眉按钮与新接口参数全部通过（${failures.length} 失败）`)
