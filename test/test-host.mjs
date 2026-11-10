/**
 * memory-book 宿主半边的离线自测（v0.13.0：按项目独立 + 固定文档 + 引擎强制维护）。
 * 用法：node test-host.mjs <插件目录>
 *
 * 全程使用临时 DSH_HOME + 临时项目目录，不读写真实记忆库。
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'

const pluginDir = process.argv[2]
if (!pluginDir) {
  console.error('用法: node test-host.mjs <插件目录>')
  process.exit(2)
}

const home = mkdtempSync(path.join(os.tmpdir(), 'memory-host-'))
process.env.USERPROFILE = home
process.env.HOME = home
// 记忆库根目录优先取 DSH_HOME；不清掉的话会读写真实记忆库，测试就不是隔离的。
process.env.DSH_HOME = path.join(home, '.dsh')
const dshHome = path.join(home, '.dsh')
const globalRoot = path.join(dshHome, 'memory')

// ── 临时目录布局 ─────────────────────────────────────────────────────────────
const projects = path.join(home, 'projects')
const projA = path.join(projects, 'projA') // 主项目（项目甲），初始没有 .memory-book
const projB = path.join(projects, 'projB') // 另一个项目（项目乙），已有 .memory-book → 临时项目
const projEmpty = path.join(projects, 'projEmpty') // 空项目（工作区存在、记忆库不存在）
const projSub = path.join(projA, 'src') // 主项目子目录 → 不应产生临时项目
const projNested = path.join(projA, 'nested') // 主项目里嵌套的项目 → 临时项目
const outside = path.join(home, 'temp-outside') // 任何工作区之外 → 无临时项目

for (const dir of [globalRoot, projects, projA, projB, projEmpty, projSub, projNested, outside]) {
  mkdirSync(dir, { recursive: true })
}

// 全局库预置 2 页（兼容旧全局库的读写断言）。
mkdirSync(path.join(globalRoot, 'core'), { recursive: true })
mkdirSync(path.join(globalRoot, 'wiki', 'projects'), { recursive: true })
mkdirSync(path.join(globalRoot, 'raw'), { recursive: true })
writeFileSync(
  path.join(globalRoot, 'core', '核心记忆.md'),
  '---\ntitle: 核心记忆\nsummary: 全局测试用\n---\n\n# 全局规则\n\n1. 跨项目通用。\n',
  'utf8',
)
writeFileSync(
  path.join(globalRoot, 'wiki', 'projects', '全局项目.md'),
  '---\ntitle: 全局项目\nsummary: 跨项目测试页\n---\n\n# 正文\n\n全局内容。\n',
  'utf8',
)

// 项目乙的库：core + 普通页（用于临时项目注入与预算测试）。
mkdirSync(path.join(projB, '.memory-book', 'core'), { recursive: true })
mkdirSync(path.join(projB, '.memory-book', 'wiki', 'projects'), { recursive: true })
writeFileSync(
  path.join(projB, '.memory-book', 'core', '核心记忆.md'),
  '---\ntitle: 核心记忆\nsummary: 项目乙规则\n---\n\n# 乙规则\n\n只在项目乙里有效。\n',
  'utf8',
)
writeFileSync(
  path.join(projB, '.memory-book', 'wiki', 'projects', '乙项目页.md'),
  '---\ntitle: 乙项目页\nsummary: 项目乙的普通页\n---\n\n# 正文\n\n乙内容。\n',
  'utf8',
)

// 嵌套项目的库。
mkdirSync(path.join(projNested, '.memory-book', 'core'), { recursive: true })
writeFileSync(
  path.join(projNested, '.memory-book', 'core', '核心记忆.md'),
  '---\ntitle: 核心记忆\nsummary: 嵌套项目规则\n---\n\n# 嵌套规则\n',
  'utf8',
)

const failures = []
let total = 0
const check = (name, ok, detail) => {
  total += 1
  if (ok) console.log(`  ok   ${name}`)
  else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 假宿主 ctx ───────────────────────────────────────────────────────────────
const workspaces = [
  { id: 'ws-a', path: projA, title: '项目甲', sessionIds: ['a1'] },
  { id: 'ws-b', path: projB, title: '项目乙', sessionIds: ['b1'] },
  { id: 'ws-empty', path: projEmpty, title: '空项目', sessionIds: ['e1'] },
]
const agents = new Map()
const handlers = new Map()
const routes = new Map()
const captured = { tool: undefined }
const services = {
  workspaceRegistry: {
    list: () => workspaces,
    get: (id) => workspaces.find((workspace) => workspace.id === id),
  },
  sessions: { get: (id) => agents.get(id)?.session },
  workingDirectory: { get: (session) => session.cwd, ensure: async (agent) => agent.session.cwd },
  agents: { list: () => [...agents.values()], get: (id) => agents.get(id) },
}
let teamMembership
let workspaceChangesService

const ctx = {
  tools: { register: (definition) => { captured.tool = definition; return () => {} } },
  systemPrompt: { section: () => () => {} },
  agents: services.agents,
  webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
  effect: (fn) => fn(),
  get: (name) => {
    if (name === 'agentTeams') return { tryMembership: () => teamMembership }
    if (name === 'workspaceChanges') return workspaceChangesService
    return services[name]
  },
  on: (name, fn) => {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
    return () => {}
  },
}

function emit(name, ...args) {
  for (const fn of handlers.get(name) ?? []) fn(...args)
}

function makeAgent(id, { creationCwd, cwd, origin, delegationDepth } = {}) {
  const session = {
    id,
    cwd: cwd ?? creationCwd,
    header: {
      cwd: creationCwd,
      isSeeded: false,
      ...(origin === undefined ? {} : { origin }),
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
    },
  }
  const sections = []
  const agent = {
    id,
    status: 'idle',
    session,
    followups: [],
    sections,
    followup(message) {
      this.followups.push(message)
    },
    ctx: {
      systemPrompt: {
        section: (spec) => {
          sections.push(spec)
          return () => {}
        },
      },
    },
  }
  agents.set(id, agent)
  return agent
}

function addAgent(id, options) {
  const agent = makeAgent(id, options)
  emit('agent/created', { agent })
  return agent
}

function sectionText(agent) {
  const section = agent.sections.find((item) => item.name === 'memory:system')
  return typeof section?.text === 'function' ? section.text() : undefined
}

// 先建 a1（工作区会话），apply 时通过 agents.list() 挂载。
const a1 = makeAgent('a1', { creationCwd: projA, cwd: projA })

const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)
mod.apply(ctx)

async function call(args, agent) {
  return captured.tool.execute(args, { agent, signal: { aborted: false } })
}
async function callMessage(args, agent = a1) {
  return (await call(args, agent)).message
}
async function callError(args, agent = a1) {
  try {
    await call(args, agent)
  } catch (error) {
    return String(error?.message || error)
  }
  return ''
}

function userTurn(agent, text) {
  agent.status = 'running'
  emit('session/event', agent.session, {
    type: 'user/message',
    seq: 1,
    data: { role: 'user', id: `user-${Math.random().toString(36).slice(2)}`, content: [{ type: 'text', text }], source: { kind: 'user' } },
  })
}
function endTurn(agent, kind = 'completed') {
  emit('session/event', agent.session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind } } })
}
function goIdle(agent) {
  agent.status = 'idle'
  emit('agent/status', { agent, status: 'idle' })
}
function toolResult(agent, name, args, isError = false) {
  emit('tools/result', { name, agent, arguments: args }, { isError })
}
async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** 递归找临时文件（验证原子写不留垃圾）。 */
function findTempFiles(dir) {
  const out = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...findTempFiles(file))
      else if (entry.name.endsWith('.tmp')) out.push(file)
    }
  } catch {
    return out
  }
  return out
}

// ── 1. 模块与工具注册 ────────────────────────────────────────────────────────
check('导出 name', mod.name === 'memory-book', String(mod.name))
check(
  'inject 只含 tools/systemPrompt/agents/webServer',
  JSON.stringify(mod.inject) === JSON.stringify(['tools', 'systemPrompt', 'agents', 'webServer']),
  JSON.stringify(mod.inject),
)
check('导出 apply 是函数', typeof mod.apply === 'function')
check('注册了 memory 工具', captured.tool?.name === 'memory', String(captured.tool?.name))
check(
  'action 枚举 8 值',
  JSON.stringify(captured.tool?.parameters?.properties?.action?.enum) ===
    JSON.stringify(['read', 'add', 'patch', 'remove', 'search', 'put', 'record', 'history']),
  JSON.stringify(captured.tool?.parameters?.properties?.action?.enum),
)
check(
  'required 含 action 与 brief',
  JSON.stringify(captured.tool?.parameters?.required) === JSON.stringify(['action', 'brief']),
)
check(
  '新增 scope 枚举 current/main/global',
  JSON.stringify(captured.tool?.parameters?.properties?.scope?.enum) === JSON.stringify(['current', 'main', 'global']),
)
check(
  '新增 doc 枚举 5 个版本化文档',
  JSON.stringify(captured.tool?.parameters?.properties?.doc?.enum) ===
    JSON.stringify(['策划', '计划', '状态', '交接', '决策历史']),
)
check('新增 based_on 参数', captured.tool?.parameters?.properties?.based_on?.type === 'string')
check('注册了 memory:system 段', a1.sections.some((item) => item.name === 'memory:system'))
check('段 order = 700', a1.sections.find((item) => item.name === 'memory:system')?.order === 700)
check('注册 8 个面板接口', routes.size === 8, `实际 ${routes.size}`)
check(
  '未知参数被拒并列出全部合法参数',
  (await callError({ action: 'read', brief: 't', file_path: 'C:\\x.md' })).includes(
    '可用参数：action、brief、path、content、old_string、new_string、query、scope、doc、based_on',
  ),
)
check(
  '未知 action 报错列出 8 个动作',
  (await callError({ action: 'bogus', brief: 't' })).includes('read / add / patch / remove / search / put / record / history'),
)
check('路径穿越被拒绝', (await callError({ action: 'read', brief: 't', path: '../../etc/passwd' })).includes('不合法'))

// ── 2. 项目判定与三层注入 ────────────────────────────────────────────────────
await sleep(20)
const injectedA = sectionText(a1)
check('注入含 memory_scope 段', typeof injectedA === 'string' && injectedA.includes('<memory_scope>'))
check('注入含主项目与记忆根', injectedA.includes('主项目：项目甲') && injectedA.includes(path.join(projA, '.memory-book')))
check('注入含全局库路径', injectedA.includes(globalRoot))
check('注入含固定文档清单', injectedA.includes('<project_docs>'))
check('注入含全局记忆段', injectedA.includes('<global_memory>'))
check('首轮注入不含时间戳', !/20\d\d-\d\d-\d\dT\d\d:\d\d/.test(injectedA))
check(
  '项目库未创建时列出缺失固定文档',
  injectedA.includes('未创建 ⚠ 必须创建'),
  injectedA.split('\n').filter((line) => line.includes('未创建')).join(' | '),
)

// 主项目回退：不在工作区 sessionIds，用创建目录归属判定。
const d1 = addAgent('d1', { creationCwd: projSub, cwd: projSub })
await sleep(20)
check('创建目录回退判定主项目', sectionText(d1)?.includes('主项目：项目甲'), sectionText(d1)?.slice(0, 200))

// 无项目：只注入全局。
const x1 = addAgent('x1', { creationCwd: outside, cwd: outside })
await sleep(20)
const injectedX = sectionText(x1)
check('无项目时只注入全局（无 core_memory）', !injectedX.includes('<core_memory>') && injectedX.includes('<global_memory>'))
check('无项目时说明只能用全局', injectedX.includes('主项目：无'))

// 空项目：工作区存在但记忆库没有 → 注入全局 + 缺失提示。
const e1 = addAgent('e1', { creationCwd: projEmpty, cwd: projEmpty })
await sleep(20)
const injectedE = sectionText(e1)
check('空主项目仍注入全局并说明', injectedE.includes('主项目：空项目') && injectedE.includes('<global_memory>'))
check('空主项目提示记忆库未创建', injectedE.includes('记忆库尚未创建'))

// 临时项目：cd 到项目乙。
a1.session.cwd = projB
await sleep(20)
const injectedTransient = sectionText(a1)
check('cd 到别的项目出现临时项目段', injectedTransient.includes('<transient_memory>'))
check('临时项目标题正确', injectedTransient.includes('临时项目：项目乙'))
check('临时项目后主项目不变', injectedTransient.includes('主项目：项目甲'))
check('临时项目注入 core 与索引', injectedTransient.includes('只在项目乙里有效') && injectedTransient.includes('乙项目页'))

// cd 到主项目子目录 → 祖先匹配，不产生临时项目。
a1.session.cwd = projSub
await sleep(20)
check('主项目子目录不产生临时项目', !sectionText(a1).includes('<transient_memory>'))

// cd 到工作区之外 → 不产生临时项目。
a1.session.cwd = outside
await sleep(20)
check('工作区之外不产生临时项目', !sectionText(a1).includes('<transient_memory>'))

// 主项目里嵌套的 .memory-book → 临时项目。
a1.session.cwd = projNested
await sleep(20)
check('嵌套项目产生临时项目', sectionText(a1).includes('临时项目：nested'))

a1.session.cwd = projA

// ── 3. scope 三值（current / main / global） ────────────────────────────────
const addDefault = await callMessage({ action: 'add', brief: 't', path: 'wiki/concepts/当前项目页', content: '---\ntitle: 当前项目页\nsummary: 默认 current\n---\n\n正文。\n' })
check('默认 scope=current 写进主项目', addDefault.includes('[项目 项目甲]') && existsSync(path.join(projA, '.memory-book', 'wiki', 'concepts', '当前项目页.md')))
check('项目库首次写入自动建 .gitignore', readFileSync(path.join(projA, '.memory-book', '.gitignore'), 'utf8').includes('*'))

a1.session.cwd = projB
const addTransient = await callMessage({ action: 'add', brief: 't', path: 'wiki/concepts/临时页', content: '---\ntitle: 临时页\nsummary: 临时项目\n---\n\n正文。\n' })
check('有临时项目时 current 写进临时项目', existsSync(path.join(projB, '.memory-book', 'wiki', 'concepts', '临时页.md')))
const addMain = await callMessage({ action: 'add', scope: 'main', brief: 't', path: 'wiki/concepts/主项目页', content: '---\ntitle: 主项目页\nsummary: scope=main\n---\n\n正文。\n' })
check('scope=main 不受 cd 影响', existsSync(path.join(projA, '.memory-book', 'wiki', 'concepts', '主项目页.md')))
const addGlobal = await callMessage({ action: 'add', scope: 'global', brief: 't', path: 'wiki/projects/全局新增', content: '---\ntitle: 全局新增\nsummary: 全局测试\n---\n\n全局正文。\n' })
check('scope=global 写进全局库', addGlobal.includes('[全局]') && existsSync(path.join(globalRoot, 'wiki', 'projects', '全局新增.md')))
a1.session.cwd = projA

// 无项目会话：current/main 报错，global 可用。
check('无项目时 current 报错', (await callError({ action: 'add', brief: 't', path: 'wiki/concepts/x', content: '---\ntitle: x\nsummary: y\n---\n' }, x1)).includes('没有项目工作区'))
check('无项目时 main 报错', (await callError({ action: 'read', scope: 'main', brief: 't', path: 'wiki/projects/全局项目' }, x1)).includes('没有项目工作区'))
const globalReadX = await callMessage({ action: 'read', scope: 'global', brief: 't', path: 'wiki/projects/全局项目' }, x1)
check('无项目时 global 可读全局页', globalReadX.includes('title: 全局项目') && globalReadX.includes('[全局]'))

// ── 4. 全局库兼容（旧断言保留，改成 scope=global） ─────────────────────────
const globalCore = await callMessage({ action: 'read', scope: 'global', brief: 't', path: 'core/核心记忆' })
check('全局 read 返回 frontmatter', globalCore.includes('title: 核心记忆') && globalCore.includes('updated'))
check('全局 read 标注所属库', globalCore.includes('store: [全局]'))
await callMessage({ action: 'read', scope: 'global', brief: 't', path: 'wiki/projects/全局新增' })
const patchedGlobal = await callMessage({ action: 'patch', scope: 'global', brief: 't', path: 'wiki/projects/全局新增', old_string: '全局正文。', new_string: '改过的全局正文。' })
check('全局 patch 成功', patchedGlobal.includes('已修改页面'))
check('全局 patch 落盘', readFileSync(path.join(globalRoot, 'wiki', 'projects', '全局新增.md'), 'utf8').includes('改过的全局正文'))
await callMessage({ action: 'read', scope: 'global', brief: 't', path: 'wiki/projects/全局项目' })
check('patch 未找到匹配会报错', (await callError({ action: 'patch', scope: 'global', brief: 't', path: 'wiki/projects/全局项目', old_string: '不存在的片段', new_string: 'x' })).includes('未找到匹配'))
check('patch 多处匹配会报错', (await callMessage({ action: 'add', scope: 'global', brief: 't', path: 'wiki/concepts/重复片段', content: '---\ntitle: 重复片段\nsummary: 多处匹配\n---\n\n同一行\n\n同一行\n' })).includes('已新增页面'))
await callMessage({ action: 'read', scope: 'global', brief: 't', path: 'wiki/concepts/重复片段' })
check('patch 多处匹配拒绝', (await callError({ action: 'patch', scope: 'global', brief: 't', path: 'wiki/concepts/重复片段', old_string: '同一行', new_string: 'x' })).includes('匹配到'))

const searched = await callMessage({ action: 'search', scope: 'global', brief: 't', query: '全局 正文' })
check('search 多词同时命中', searched.includes('wiki/projects/全局项目') && searched.includes('命中 2/2 词'), searched.split('\n')[0])
const partial = await callMessage({ action: 'search', scope: 'global', brief: 't', query: '正文 不存在的词' })
check('search 全词不命中退回部分命中', partial.includes('命中部分关键词'))
const noneHit = await callMessage({ action: 'search', scope: 'global', brief: 't', query: '完全不存在的词' })
check('search 无命中返回提示', noneHit.includes('未找到匹配'))
const scopedMiss = await callMessage({ action: 'search', scope: 'global', brief: 't', query: '当前项目页' })
check('search 只在所选库内检索', scopedMiss.includes('未找到匹配'), scopedMiss.split('\n')[0])
const removedGlobal = await callMessage({ action: 'remove', scope: 'global', brief: 't', path: 'wiki/concepts/重复片段' })
check('全局 remove 成功', removedGlobal.includes('已删除页面'))
check('add 不覆盖已有页', (await callError({ action: 'add', scope: 'global', brief: 't', path: 'wiki/projects/全局新增', content: '---\ntitle: x\nsummary: y\n---\n' })).includes('页面已存在'))
check('add 校验 frontmatter', (await callError({ action: 'add', scope: 'global', brief: 't', path: 'wiki/concepts/坏页', content: '没有 frontmatter' })).includes('页面格式错误'))

// ── 5. 预算与截断 ────────────────────────────────────────────────────────────
await callMessage({ action: 'add', scope: 'main', brief: 't', path: 'core/核心记忆', content: `---\ntitle: 核心记忆\nsummary: 项目甲规则\n---\n\n${'规则字'.repeat(200)}` })
writeFileSync(path.join(globalRoot, 'settings.json'), JSON.stringify({ mainCoreChars: 300, mainIndexChars: 200, pagesPerDir: 1 }), 'utf8')
const injectedBudget = sectionText(a1)
check(
  '主项目 core 超预算被截断',
  injectedBudget.includes('超出预算，已截断'),
  `file=${existsSync(path.join(projA, '.memory-book', 'core', '核心记忆.md'))} coreBlock=${injectedBudget.split('<core_memory>')[1]?.slice(0, 160)}`,
)
check('主项目索引超预算被截断', injectedBudget.includes('索引超出预算已截断'))
writeFileSync(path.join(globalRoot, 'settings.json'), JSON.stringify({ transientCoreChars: 0 }), 'utf8')
a1.session.cwd = projB
const injectedNoTransientCore = sectionText(a1)
check('transientCoreChars=0 只注入临时项目索引', !injectedNoTransientCore.includes('临时项目 core 正文') && injectedNoTransientCore.includes('临时项目目录索引'))
a1.session.cwd = projA
rmSync(path.join(globalRoot, 'settings.json'), { force: true })

// ── 6. 固定文档（put / record / history / 2000 字 / 删除保护） ───────────────
const putBrief = await callMessage({ action: 'put', scope: 'main', brief: 't', path: 'project/说明及目标', content: '# 项目甲\n\n目标：验证项目独立记忆。\n' })
check('put 说明及目标成功', putBrief.includes('已保存固定页') && putBrief.includes('/2000 字'), putBrief)
check('说明及目标自动生成 frontmatter', readFileSync(path.join(projA, '.memory-book', 'project', '说明及目标.md'), 'utf8').includes('title: 说明及目标'))
const briefTooLong = await callError({ action: 'put', scope: 'main', brief: 't', path: 'project/说明及目标', content: `${'字'.repeat(2001)}` })
check('说明及目标超 2000 字被拒并回报字数', briefTooLong.includes('2001') && briefTooLong.includes('2000'), briefTooLong)
check('put 已有页前必须先 read', (await callError({ action: 'put', scope: 'main', brief: 't', path: 'project/说明及目标', content: '# 新目标\n' })).includes('先读再写'))
await callMessage({ action: 'read', scope: 'main', brief: 't', path: 'project/说明及目标' })
check('read 后 put 成功覆盖', (await callMessage({ action: 'put', scope: 'main', brief: 't', path: 'project/说明及目标', content: '# 项目甲\n\n目标：验证项目独立记忆（已覆盖）。\n' })).includes('已保存固定页'))
check('put 只接受固定页路径', (await callError({ action: 'put', scope: 'main', brief: 't', path: 'wiki/concepts/当前项目页', content: '正文' })).includes('只接受'))

const putExperience = await callMessage({ action: 'put', scope: 'main', brief: 't', path: 'project/经验/构建坑', content: '### 构建坑\n\n临时文件 + rename 才是原子写。\n' })
check('put 项目经验页成功', putExperience.includes('已保存项目经验页'))
check('经验页标题=类型名', readFileSync(path.join(projA, '.memory-book', 'project', '经验', '构建坑.md'), 'utf8').includes('title: 构建坑'))

// 建立完整固定文档骨架（避免“缺失”干扰后续引擎断言）。
const skeleton = [
  ['策划', '本轮策划正文。'],
  ['计划', '本轮计划正文。'],
  ['状态', '本轮状态正文。'],
  ['交接', '本轮交接正文。'],
  ['决策历史', '本轮决策正文。'],
]
for (const [doc, body] of skeleton) {
  const message = await callMessage({ action: 'record', scope: 'main', brief: 't', doc, content: body, based_on: '' })
  check(`record 首个${doc}版本`, message.includes('已新增版本') && message.includes('首个版本'), message)
}
const statusHistory = await callMessage({ action: 'history', scope: 'main', brief: 't', doc: '状态' })
check('history 列出 1 个状态版本', statusHistory.includes('共 1 个版本'))
const statusLatestPath = /project\/状态\/\d{8}-\d{4}/.exec(statusHistory)?.[0]
check('版本页文件名符合 YYYYMMDD-HHmm', statusLatestPath !== undefined, statusLatestPath)

// record 未读最新版 → 拒绝。
check(
  'record 未读最新版被拒',
  (await callError({ action: 'record', scope: 'main', brief: 't', doc: '状态', content: '第二次状态。', based_on: statusLatestPath })).includes('先读再写'),
)
await callMessage({ action: 'read', scope: 'main', brief: 't', path: statusLatestPath })
const casMismatch = await callError({ action: 'record', scope: 'main', brief: 't', doc: '状态', content: '第二次状态。', based_on: 'project/状态/20200101-0000' })
check('record based_on 不是最新版被拒（CAS）', casMismatch.includes('不一致') && casMismatch.includes('based_on'), casMismatch)
const secondStatus = await callMessage({ action: 'record', scope: 'main', brief: 't', doc: '状态', content: '第二次状态正文。\n\n补充：测试历史版本。', based_on: statusLatestPath })
check('record 新版本成功并返回上一版', secondStatus.includes('上一版本: ' + statusLatestPath), secondStatus)
const statusFiles = readdirSync(path.join(projA, '.memory-book', 'project', '状态'))
check('旧版本保留、新版本追加', statusFiles.length === 2, String(statusFiles.length))
const history2 = await callMessage({ action: 'history', scope: 'main', brief: 't', doc: '状态' })
const versionPaths = [...history2.matchAll(/project\/状态\/\d{8}-\d{4}(?:-\d+)?/g)].map((match) => match[0])
check('history 新→旧列出 2 个版本', versionPaths.length === 2 && versionPaths[0] > versionPaths[1], versionPaths.join(', '))
const latestStatusPath = versionPaths[0]
const oldStatusPath = versionPaths[1]

// 最新版本可 patch；历史版本只读。
await callMessage({ action: 'read', scope: 'main', brief: 't', path: latestStatusPath })
check(
  '最新版本可以 patch',
  (await callMessage({ action: 'patch', scope: 'main', brief: 't', path: latestStatusPath, old_string: '补充：测试历史版本。', new_string: '补充：测试历史版本（已改）。' })).includes('已修改页面'),
)
check(
  '历史版本只读',
  (await callError({ action: 'patch', scope: 'main', brief: 't', path: oldStatusPath, old_string: '本轮状态正文。', new_string: 'x' })).includes('历史版本只读'),
)

// 删除 / add 保护。
check('固定版本页不允许删除', (await callError({ action: 'remove', scope: 'main', brief: 't', path: latestStatusPath })).includes('固定文档不允许删除'))
check('说明及目标不允许删除', (await callError({ action: 'remove', scope: 'main', brief: 't', path: 'project/说明及目标' })).includes('固定文档不允许删除'))
check('add 不能用于固定页', (await callError({ action: 'add', scope: 'main', brief: 't', path: 'project/说明及目标', content: '---\ntitle: x\nsummary: y\n---\n' })).includes('固定文档不能用 add'))
check('record 拒绝未知 doc', (await callError({ action: 'record', scope: 'main', brief: 't', doc: '不存在的文档', content: 'x', based_on: '' })).includes('doc 必须是'))
check('record 缺少 based_on 被拒', (await callError({ action: 'record', scope: 'main', brief: 't', doc: '状态', content: 'x' })).includes('based_on'))

// 注入里的固定文档清单：最新版路径 + 历史数量 + 不列旧版本。
a1.session.cwd = projA
await sleep(20)
const injectedDocs = sectionText(a1)
check('注入列出状态最新版本路径', injectedDocs.includes(latestStatusPath))
check('注入标注历史版本数量', injectedDocs.includes('另有 1 个历史版本'))
const docsBlock = injectedDocs.split('<project_docs>')[1]?.split('</project_docs>')[0] ?? ''
check('注入不列历史版本路径（状态只出现最新版一次）', (docsBlock.match(/project\/状态\/\d{8}-\d{4}/g) ?? []).length === 1, (docsBlock.match(/project\/状态\/[^\n]*/g) ?? []).join(' | '))
check('注入列出项目经验类型', injectedDocs.includes('project/经验/构建坑'))
check('注入显示说明及目标字数', /说明及目标 project\/说明及目标（当前 \d+\/2000 字）/.test(injectedDocs), injectedDocs.split('\n').find((line) => line.includes('说明及目标')))

// 原子写不留临时文件。
check('原子写不留 .tmp 垃圾', findTempFiles(path.join(projA, '.memory-book')).length === 0)

// 角色限制：teammate 不能写固定文档，但能写经验页与普通页。
teamMembership = { role: 'teammate', name: 'host-dev' }
await callMessage({ action: 'read', scope: 'main', brief: 't', path: 'project/说明及目标' })
check('teammate 不能写说明及目标', (await callError({ action: 'put', scope: 'main', brief: 't', path: 'project/说明及目标', content: '# x\n' })).includes('只有 Lead'))
await callMessage({ action: 'read', scope: 'main', brief: 't', path: statusLatestPath })
check('teammate 不能写版本化文档', (await callError({ action: 'record', scope: 'main', brief: 't', doc: '状态', content: 'x', based_on: latestStatusPath })).includes('只有 Lead'))
check('teammate 可以写项目经验', (await callMessage({ action: 'put', scope: 'main', brief: 't', path: 'project/经验/WSL坑', content: 'WSL 需要换行符处理。\n' })).includes('已保存项目经验页'))
check('teammate 可以写普通页', (await callMessage({ action: 'add', scope: 'main', brief: 't', path: 'wiki/concepts/队友页', content: '---\ntitle: 队友页\nsummary: 队友可写\n---\n\n正文。\n' })).includes('已新增页面'))
teamMembership = undefined

// 子代理也不能写固定文档（即使不在团队里）。
const subAgent = addAgent('sub-agent-1', { creationCwd: projA, cwd: projA, origin: 'subagent' })
await callMessage({ action: 'read', scope: 'main', brief: 't', path: 'project/说明及目标' }, subAgent)
check('子代理不能写说明及目标', (await callError({ action: 'put', scope: 'main', brief: 't', path: 'project/说明及目标', content: '# x\n' }, subAgent)).includes('子代理'))
check('子代理可以写项目经验', (await callMessage({ action: 'put', scope: 'main', brief: 't', path: 'project/经验/子代理坑', content: '子代理踩的坑。\n' }, subAgent)).includes('已保存项目经验页'))

// 乐观锁：read 后文件被外部改过 → 写被拒。
const lockPagePath = 'wiki/concepts/锁测试'
await callMessage({ action: 'add', brief: 't', path: lockPagePath, content: '---\ntitle: 锁测试\nsummary: 乐观锁\n---\n\n原始正文。\n' })
await callMessage({ action: 'read', brief: 't', path: lockPagePath })
await sleep(15)
writeFileSync(path.join(projA, '.memory-book', 'wiki', 'concepts', '锁测试.md'), '---\ntitle: 锁测试\nsummary: 被外部改了\n---\n\n外部正文。\n', 'utf8')
check('读后被外部修改的写入被拒', (await callError({ action: 'patch', brief: 't', path: lockPagePath, old_string: '原始正文。', new_string: 'x' })).includes('读取后被改过'))

// ── 7. 引擎强制维护 ──────────────────────────────────────────────────────────
const engine1 = addAgent('engine1', { creationCwd: projA, cwd: projA })
userTurn(engine1, '帮我实现登录功能')
toolResult(engine1, 'write', { file_path: 'src/login.js' })
endTurn(engine1)
goIdle(engine1)
await settle()
check('文件改动触发补更轮', engine1.followups.length === 1, String(engine1.followups.length))
const followup1 = engine1.followups[0]
check('补更消息含 memory_maintenance', String(followup1?.content?.[0]?.text).includes('<memory_maintenance>'))
check('补更消息要求更新状态', String(followup1?.content?.[0]?.text).includes('状态'))
check('补更消息带项目名', String(followup1?.content?.[0]?.text).includes('项目甲'))
check('补更消息带用户消息摘要', String(followup1?.content?.[0]?.text).includes('实现登录功能'))
check('补更消息记录 source 便于识别', followup1?.source?.kind === 'memory-maintenance')
goIdle(engine1)
await settle()
check('同一回合最多补更 1 次', engine1.followups.length === 1, String(engine1.followups.length))

// 补更轮自身不重复触发。
emit('session/event', engine1.session, { type: 'user/message', seq: 3, data: followup1 })
toolResult(engine1, 'write', { file_path: 'src/login.js' })
endTurn(engine1)
goIdle(engine1)
await settle()
check('补更轮自身不重复触发', engine1.followups.length === 1, String(engine1.followups.length))

// 取消/报错不触发。
const engine2 = addAgent('engine2', { creationCwd: projA, cwd: projA })
userTurn(engine2, '看看这个')
toolResult(engine2, 'write', { file_path: 'x' })
endTurn(engine2, 'aborted')
goIdle(engine2)
await settle()
check('用户取消的回合不触发补更', engine2.followups.length === 0)
const engine3 = addAgent('engine3', { creationCwd: projA, cwd: projA })
userTurn(engine3, '看看那个')
toolResult(engine3, 'write', { file_path: 'y' })
endTurn(engine3)
emit('agent/error', { agent: engine3 })
goIdle(engine3)
await settle()
check('报错的回合不触发补更', engine3.followups.length === 0)

// 计划 / 目标工具变化 → 计划 + 状态。
const engine4 = addAgent('engine4', { creationCwd: projA, cwd: projA })
userTurn(engine4, '排一下计划')
toolResult(engine4, 'todo_write', { todos: [] })
endTurn(engine4)
goIdle(engine4)
await settle()
const followup4 = String(engine4.followups[0]?.content?.[0]?.text)
check('todo_write 触发补更并要求计划+状态', engine4.followups.length === 1 && followup4.includes('计划') && followup4.includes('状态'), followup4.slice(0, 160))

// 连续失败 ≥2 次 → 经验。
const engine5 = addAgent('engine5', { creationCwd: projA, cwd: projA })
userTurn(engine5, '跑构建')
toolResult(engine5, 'pwsh', {}, true)
toolResult(engine5, 'pwsh', {}, true)
endTurn(engine5)
goIdle(engine5)
await settle()
const followup5 = String(engine5.followups[0]?.content?.[0]?.text)
check('连续失败触发经验补更', engine5.followups.length === 1 && followup5.includes('经验'), followup5.slice(0, 160))

// 交接到期：5 次实质变化。
const engine6 = addAgent('engine6', { creationCwd: projA, cwd: projA })
for (let round = 0; round < 5; round += 1) {
  userTurn(engine6, `第 ${round + 1} 轮改动`)
  toolResult(engine6, 'edit', { file_path: 'src/a.js' })
  endTurn(engine6)
  goIdle(engine6)
  await settle()
}
const followup6 = String(engine6.followups.at(-1)?.content?.[0]?.text)
check('累计 5 次实质变化触发交接', engine6.followups.length === 5 && followup6.includes('交接'), followup6.slice(0, 200))

// 联动：本轮 record 了计划但没 record 状态 → 状态。
const engine7 = addAgent('engine7', { creationCwd: projA, cwd: projA })
userTurn(engine7, '更新计划')
toolResult(engine7, 'memory', { action: 'record', doc: '计划' })
endTurn(engine7)
goIdle(engine7)
await settle()
const followup7 = String(engine7.followups[0]?.content?.[0]?.text)
check('记录计划但未记录状态触发状态补更', engine7.followups.length === 1 && followup7.includes('状态'), followup7.slice(0, 160))

// 失败兜底：连续 5 个用户回合没有实质变化 → 追问用户。
const engine8 = addAgent('engine8', { creationCwd: projA, cwd: projA })
for (let round = 0; round < 5; round += 1) {
  userTurn(engine8, `随便聊聊 ${round + 1}`)
  endTurn(engine8)
  goIdle(engine8)
  await settle()
}
const followup8 = String(engine8.followups.at(-1)?.content?.[0]?.text)
check('连续 5 轮无变化触发兜底追问', engine8.followups.length >= 1 && followup8.includes('询问用户'), followup8.slice(0, 160))

// 子代理会话不触发。
const engine9 = addAgent('engine9', { creationCwd: projA, cwd: projA, origin: 'subagent' })
userTurn(engine9, '子任务')
toolResult(engine9, 'write', { file_path: 'x' })
endTurn(engine9)
goIdle(engine9)
await settle()
check('子代理会话不触发补更', engine9.followups.length === 0)

// followup 失败 → 降级为下一轮注入里的强制提醒。
const engine10 = addAgent('engine10', { creationCwd: projA, cwd: projA })
engine10.followup = () => {
  throw new Error('followup 不可用')
}
userTurn(engine10, '补更测试')
toolResult(engine10, 'write', { file_path: 'x' })
endTurn(engine10)
goIdle(engine10)
await settle()
check('followup 失败降级为注入提醒', sectionText(engine10)?.includes('<memory_maintenance_notice>'), sectionText(engine10)?.slice(0, 120))

// agent 没有 followup 方法 → 同样降级为提醒。
const engine11 = addAgent('engine11', { creationCwd: projA, cwd: projA })
delete engine11.followup
userTurn(engine11, '没有 followup')
toolResult(engine11, 'write', { file_path: 'x' })
endTurn(engine11)
goIdle(engine11)
await settle()
check('缺少 followup 时降级为提醒', sectionText(engine11)?.includes('<memory_maintenance_notice>'))

// autoFollowup 关闭 → 不追加补更轮。
writeFileSync(path.join(globalRoot, 'settings.json'), JSON.stringify({ autoFollowup: false }), 'utf8')
const engine12 = addAgent('engine12', { creationCwd: projA, cwd: projA })
userTurn(engine12, '关闭补更')
toolResult(engine12, 'write', { file_path: 'x' })
endTurn(engine12)
goIdle(engine12)
await settle()
check('autoFollowup=false 不触发补更', engine12.followups.length === 0, String(engine12.followups.length))
rmSync(path.join(globalRoot, 'settings.json'), { force: true })

// workspaceChanges 服务优先：有服务时按 summary 计变化，并过滤 .memory-book 自身写入。
workspaceChangesService = {
  summary: (sessionId, seq) => {
    if (seq === 11) return { turn: 1, total: 2, files: [{ path: path.join(projA, '.memory-book', 'a.md'), display: '.memory-book/a.md' }, { path: 'src/app.js', display: 'src/app.js' }] }
    if (seq === 12) return { turn: 1, total: 1, files: [{ path: path.join(projA, '.memory-book', 'b.md'), display: '.memory-book/b.md' }] }
    return undefined
  },
}
const engine13 = addAgent('engine13', { creationCwd: projA, cwd: projA })
userTurn(engine13, '改了代码')
emit('session/event', engine13.session, { type: 'workspace/changes', seq: 11, data: { turn: 1 } })
endTurn(engine13)
goIdle(engine13)
await settle()
check('workspaceChanges 服务触发补更（过滤记忆库自身写入）', engine13.followups.length === 1, String(engine13.followups.length))
const engine14 = addAgent('engine14', { creationCwd: projA, cwd: projA })
userTurn(engine14, '只写了记忆')
emit('session/event', engine14.session, { type: 'workspace/changes', seq: 12, data: { turn: 1 } })
endTurn(engine14)
goIdle(engine14)
await settle()
check('只有记忆库写入不算实质变化', engine14.followups.length === 0, String(engine14.followups.length))
workspaceChangesService = undefined

// 固定文档缺失 → 强制补更（空项目里还没有任何固定文档）。
const engine15 = addAgent('engine15', { creationCwd: projEmpty, cwd: projEmpty })
userTurn(engine15, '开始这个项目')
endTurn(engine15)
goIdle(engine15)
await settle()
const followup15 = String(engine15.followups[0]?.content?.[0]?.text)
check('固定文档缺失触发补更', engine15.followups.length === 1 && followup15.includes('说明及目标'), followup15.slice(0, 160))

// 注入显示陈旧标记（engine6 已有多次实质变化未更新状态）。
check('注入显示状态陈旧提示', sectionText(engine6)?.includes('次实质变化未更新') === true, sectionText(engine6)?.split('\n').filter((line) => line.includes('状态')).join(' | '))

// agent/disposed 清理状态：dispose 后再挂载不报错、注入仍可用。
emit('agent/disposed', { agent: engine1 })
check('agent/disposed 后注入仍可渲染', typeof sectionText(engine1) === 'string')

// ── 8. 全空零注入（最后做：会删掉临时全局库） ───────────────────────────────
rmSync(globalRoot, { recursive: true, force: true })
await sleep(1100)
check('全空时零注入', sectionText(x1) === '', JSON.stringify(sectionText(x1)?.slice(0, 80)))

if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\nOK: 宿主半边 ${total} 项断言全部通过`)
