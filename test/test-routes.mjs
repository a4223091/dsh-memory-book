/**
 * 面板 HTTP 接口端到端测试（v0.13.0：按项目 scope 定位 + 固定文档 + 历史 + 跨库解析）。
 * 用法：node test-routes.mjs <插件目录>
 *
 * 全程使用临时 DSH_HOME + 临时项目目录，不读写真实记忆库。
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'

const pluginDir = process.argv[2]
if (!pluginDir) {
  console.error('用法: node test-routes.mjs <插件目录>')
  process.exit(2)
}

const home = mkdtempSync(path.join(os.tmpdir(), 'memory-routes-'))
process.env.USERPROFILE = home
process.env.HOME = home
// 记忆库根目录优先取 DSH_HOME；不清掉的话会读写真实记忆库，测试就不是隔离的。
process.env.DSH_HOME = path.join(home, '.dsh')
const globalRoot = path.join(home, '.dsh', 'memory')
const projectsDir = path.join(home, 'projects')
const projA = path.join(projectsDir, 'projA')
const projB = path.join(projectsDir, 'projB')
const projMissing = path.join(projectsDir, 'gone')

for (const dir of [globalRoot, projectsDir, projA, projB]) mkdirSync(dir, { recursive: true })

// 全局库：2 页（其中“共享页”用于跨库 resolve）。
mkdirSync(path.join(globalRoot, 'core'), { recursive: true })
mkdirSync(path.join(globalRoot, 'wiki', 'projects'), { recursive: true })
writeFileSync(path.join(globalRoot, 'core', '核心记忆.md'), '---\ntitle: 核心记忆\nsummary: 全局规则\n---\n\n# 规则\n\n全局条目。\n', 'utf8')
writeFileSync(
  path.join(globalRoot, 'wiki', 'projects', '共享页.md'),
  '---\ntitle: 全局共享页\nsummary: 全局里的共享页\n---\n\n# 正文\n\n全局共享内容。\n',
  'utf8',
)

// 项目甲库：core + 普通页 + 固定文档（说明及目标、两个状态版本、一个经验页）。
const rootA = path.join(projA, '.memory-book')
mkdirSync(path.join(rootA, 'core'), { recursive: true })
mkdirSync(path.join(rootA, 'wiki', 'projects'), { recursive: true })
mkdirSync(path.join(rootA, 'project', '状态'), { recursive: true })
mkdirSync(path.join(rootA, 'project', '经验'), { recursive: true })
writeFileSync(path.join(rootA, 'core', '核心记忆.md'), '---\ntitle: 核心记忆\nsummary: 项目甲规则\n---\n\n# 项目甲规则\n\n只在本项目有效。\n', 'utf8')
writeFileSync(
  path.join(rootA, 'wiki', 'projects', '共享页.md'),
  '---\ntitle: 项目甲共享页\nsummary: 项目里的共享页\n---\n\n# 正文\n\n项目甲共享内容。\n',
  'utf8',
)
writeFileSync(
  path.join(rootA, 'project', '说明及目标.md'),
  '---\ntitle: 说明及目标\nsummary: 项目甲的目标\n---\n\n# 项目甲\n\n目标：测试面板接口。\n',
  'utf8',
)
writeFileSync(
  path.join(rootA, 'project', '状态', '20260101-1000.md'),
  '---\ntitle: 状态 20260101-1000\nsummary: 第一次状态\nby: lead\n---\n\n第一次状态正文。\n',
  'utf8',
)
writeFileSync(
  path.join(rootA, 'project', '状态', '20260102-1000.md'),
  '---\ntitle: 状态 20260102-1000\nsummary: 第二次状态\nby: lead\n---\n\n第二次状态正文。\n',
  'utf8',
)
writeFileSync(
  path.join(rootA, 'project', '经验', '构建坑.md'),
  '---\ntitle: 构建坑\nsummary: 构建踩坑经验\n---\n\n构建坑正文。\n',
  'utf8',
)

// 项目乙库：core 一页。
mkdirSync(path.join(projB, '.memory-book', 'core'), { recursive: true })
writeFileSync(path.join(projB, '.memory-book', 'core', '核心记忆.md'), '---\ntitle: 核心记忆\nsummary: 项目乙规则\n---\n\n乙规则。\n', 'utf8')

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

// ── 假宿主 ctx ───────────────────────────────────────────────────────────────
const workspaces = [
  { id: 'ws-a', path: projA, title: '项目甲', sessionIds: ['s-a'] },
  { id: 'ws-b', path: projB, title: '项目乙', sessionIds: ['s-b'] },
  { id: 'ws-gone', path: projMissing, title: '已删除项目', sessionIds: ['s-gone'] },
]
const sessions = new Map([
  ['s-a', { id: 's-a', cwd: projA, header: { cwd: projA } }],
  ['s-b', { id: 's-b', cwd: projB, header: { cwd: projB } }],
])
let rejectionStatus
const routes = new Map()
const services = {
  workspaceRegistry: { list: () => workspaces, get: (id) => workspaces.find((workspace) => workspace.id === id) },
  sessions: { get: (id) => sessions.get(id) },
  workingDirectory: { get: (session) => session.cwd },
}
const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)
mod.apply({
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  agents: { list: () => [] },
  webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
  effect: (fn) => fn(),
  get: (name) => {
    if (name === 'connection') return { requestRejection: () => rejectionStatus }
    return services[name]
  },
  on: () => {},
})

check('注册了 8 个面板接口', routes.size === 8, `实际 ${routes.size}`)
for (const pathName of ['/memory-book/projects', '/memory-book/library', '/memory-book/page', '/memory-book/delete', '/memory-book/search', '/memory-book/settings', '/memory-book/history', '/memory-book/resolve']) {
  check(`存在接口 ${pathName}`, routes.has(pathName))
}

function fakeReq(url, method, body) {
  const listeners = { data: [], end: [], error: [] }
  const req = { url, method, headers: {}, on: (name, fn) => { if (listeners[name]) listeners[name].push(fn); return req } }
  if (method === 'POST') {
    const payload = body === undefined ? '' : JSON.stringify(body)
    process.nextTick(() => { for (const fn of listeners.data) fn(payload); for (const fn of listeners.end) fn() })
  }
  return req
}
function fakeRes() {
  return { statusCode: 0, headers: {}, body: '', setHeader(n, v) { this.headers[n] = v }, end(chunk) { this.body = chunk === undefined ? '' : String(chunk) } }
}
async function call(pathName, { url, method = 'GET', body } = {}) {
  const route = routes.get(pathName)
  if (!route) throw new Error(`没有路由 ${pathName}`)
  const res = fakeRes()
  await route.handler(fakeReq(url || pathName, method, body), res)
  return { status: res.statusCode, json: res.body === '' ? undefined : JSON.parse(res.body) }
}
const q = (params) => '?' + new URLSearchParams(params).toString()

// ── /projects ────────────────────────────────────────────────────────────────
const projectsRes = await call('/memory-book/projects')
const projectsJson = projectsRes.json
check('/projects ok', projectsJson.ok === true)
check('/projects 全局字段', projectsJson.global.path === globalRoot && projectsJson.global.memoryRoot === globalRoot && projectsJson.global.pages === 2, JSON.stringify(projectsJson.global))
check('/projects 列出全部工作区', projectsJson.projects.length === 3, String(projectsJson.projects.length))
const rowA = projectsJson.projects.find((row) => row.workspaceId === 'ws-a')
check(
  '/projects 项目行字段',
  rowA.path === projA && rowA.title === '项目甲' && rowA.exists === true && rowA.hasMemory === true && rowA.pages === 2,
  JSON.stringify(rowA),
)
const rowGone = projectsJson.projects.find((row) => row.workspaceId === 'ws-gone')
check('/projects 目录不存在时 exists=false', rowGone.exists === false && rowGone.hasMemory === false, JSON.stringify(rowGone))

// ── /library：默认 scope=global + 10 项配置 ──────────────────────────────────
const libraryGlobal = (await call('/memory-book/library')).json
check('/library 默认 scope 为全局', libraryGlobal.scope.kind === 'global' && libraryGlobal.scope.title === '全局记忆库')
check('/library 带 memoryRoot', libraryGlobal.scope.memoryRoot === globalRoot)
const settings = libraryGlobal.settings
check(
  'settings 10 项默认值',
  settings.coreChars === 1200 &&
    settings.mainCoreChars === 3000 &&
    settings.transientCoreChars === 800 &&
    settings.indexChars === 1000 &&
    settings.mainIndexChars === 2500 &&
    settings.transientIndexChars === 1200 &&
    settings.pagesPerDir === 8 &&
    settings.fallbackRounds === 5 &&
    settings.handoverChanges === 5 &&
    settings.autoFollowup === true,
  JSON.stringify(settings),
)
check('limits 为区间数组', Array.isArray(libraryGlobal.limits.coreChars) && libraryGlobal.limits.coreChars[0] === 300)
check('defaults 与 settings 同构', JSON.stringify(libraryGlobal.defaults) === JSON.stringify(settings))
check('/library 分类 6 项', libraryGlobal.categories.length === 6)
check('/library 不再有 evidence/pending', libraryGlobal.evidence === undefined && libraryGlobal.pending === undefined)
check('/library 注入字符数 > 0', libraryGlobal.injected.totalChars > 0, String(libraryGlobal.injected.totalChars))
check('/library docs 6 类', libraryGlobal.docs.length === 6)
check(
  'docs 枚举正确',
  JSON.stringify(libraryGlobal.docs.map((doc) => doc.doc)) === JSON.stringify(['brief', 'planning', 'plan', 'status', 'handover', 'decisions']),
  JSON.stringify(libraryGlobal.docs.map((doc) => doc.doc)),
)
check('全局库没有固定文档（全部 missing）', libraryGlobal.docs.every((doc) => doc.missing === true))
check('全局库 experiences 为空数组', Array.isArray(libraryGlobal.experiences) && libraryGlobal.experiences.length === 0)
check('/library 没有 transient 字段（未带 sessionId）', libraryGlobal.transient === undefined)

// ── /library：scope 定位 ────────────────────────────────────────────────────
const libraryA = (await call('/memory-book/library', { url: '/memory-book/library' + q({ workspaceId: 'ws-a' }) })).json
check('/library workspaceId 定位项目库', libraryA.scope.kind === 'project' && libraryA.scope.title === '项目甲' && libraryA.scope.memoryRoot === rootA)
check('/library 项目库 scope 带 workspaceId', libraryA.scope.workspaceId === 'ws-a')
check('/library 项目库列出普通页 2 个', libraryA.pages.length === 2, String(libraryA.pages.length))
check('/library 项目库 categories 计数', libraryA.categories.find((item) => item.key === 'projects').count === 1)
const briefDoc = libraryA.docs.find((doc) => doc.doc === 'brief')
check('docs brief 有最新路径与字数', briefDoc.missing === false && briefDoc.latestPath === 'project/说明及目标' && briefDoc.chars > 0, JSON.stringify(briefDoc))
const statusDoc = libraryA.docs.find((doc) => doc.doc === 'status')
check('docs status 统计版本数', statusDoc.versions === 2 && statusDoc.latestPath === 'project/状态/20260102-1000', JSON.stringify(statusDoc))
check('experiences 列经验页', libraryA.experiences.length === 1 && libraryA.experiences[0].path === 'project/经验/构建坑', JSON.stringify(libraryA.experiences))
check('项目库注入字符数 > 0', libraryA.injected.totalChars > 0)

const libraryBySession = (await call('/memory-book/library', { url: '/memory-book/library' + q({ sessionId: 's-a' }) })).json
check('/library sessionId 映射到主项目', libraryBySession.scope.kind === 'project' && libraryBySession.scope.title === '项目甲')
const libraryByScopeValue = (await call('/memory-book/library', { url: '/memory-book/library' + q({ scope: 'ws-b' }) })).json
check('/library scope=<工作区id> 兼容写法', libraryByScopeValue.scope.title === '项目乙')

// 临时项目字段：会话当前目录属于项目乙时返回 transient。
sessions.get('s-a').cwd = projB
const libraryTransient = (await call('/memory-book/library', { url: '/memory-book/library' + q({ sessionId: 's-a' }) })).json
check('/library 返回 transient 字段', libraryTransient.transient?.kind === 'project' && libraryTransient.transient.title === '项目乙', JSON.stringify(libraryTransient.transient))
check('/library transient 带记忆根', libraryTransient.transient.memoryRoot === path.join(projB, '.memory-book'))
sessions.get('s-a').cwd = projA
const libraryNoTransient = (await call('/memory-book/library', { url: '/memory-book/library' + q({ sessionId: 's-a' }) })).json
check('/library 无临时项目时省略 transient', libraryNoTransient.transient === undefined)

// 非法 / 未知定位参数。
const badWorkspace = (await call('/memory-book/library', { url: '/memory-book/library' + q({ workspaceId: '../etc' }) })).json
check('workspaceId 拒绝路径穿越', badWorkspace.ok === false && String(badWorkspace.message).includes('不接受任意路径'), String(badWorkspace.message))
const unknownWorkspace = (await call('/memory-book/library', { url: '/memory-book/library' + q({ workspaceId: 'nope' }) })).json
check('未知工作区返回 ok:false', unknownWorkspace.ok === false && String(unknownWorkspace.message).includes('未知的工作区'))
const unknownSession = (await call('/memory-book/library', { url: '/memory-book/library' + q({ sessionId: 'nope' }) })).json
check('未知会话返回 ok:false', unknownSession.ok === false && String(unknownSession.message).includes('会话没有项目工作区'))

// ── /page：读、写、meta ─────────────────────────────────────────────────────
const pageGlobal = (await call('/memory-book/page', { url: '/memory-book/page' + q({ path: 'wiki/projects/共享页', scope: 'global' }) })).json
check('/page 读整页', pageGlobal.ok === true && pageGlobal.content.includes('title: 全局共享页'))
check('/page body 去掉 frontmatter', pageGlobal.body.includes('全局共享内容') && !pageGlobal.body.includes('title:'))
check('/page 普通页 meta 不是固定文档', pageGlobal.meta.fixed === false && pageGlobal.meta.versioned === false && pageGlobal.meta.readOnly === false)

const created = (await call('/memory-book/page', {
  url: '/memory-book/page',
  method: 'POST',
  body: { path: 'wiki/projects/新建页', content: '---\ntitle: 新建页\nsummary: 测试新建\n---\n\n正文。\n' },
})).json
check('POST /page 默认写全局库', created.ok === true && existsSync(path.join(globalRoot, 'wiki', 'projects', '新建页.md')))
const overwritten = (await call('/memory-book/page', {
  url: '/memory-book/page',
  method: 'POST',
  body: { path: 'wiki/projects/新建页', content: '---\ntitle: 新建页\nsummary: 覆盖后\n---\n\n新正文。\n' },
})).json
check('POST /page 覆盖', overwritten.ok === true)
const missing = (await call('/memory-book/page', { url: '/memory-book/page' + q({ path: 'wiki/projects/不存在', scope: 'global' }) })).json
check('读不存在返回 ok:false', missing.ok === false && String(missing.message).includes('页面不存在'))
const badPath = (await call('/memory-book/page', { url: '/memory-book/page', method: 'POST', body: { path: '../x', content: 'x' } })).json
check('非法路径返回 ok:false', badPath.ok === false)
const badFormat = (await call('/memory-book/page', { url: '/memory-book/page', method: 'POST', body: { path: 'wiki/projects/无格式', content: '没有 frontmatter' } })).json
check('缺 frontmatter 返回 ok:false', badFormat.ok === false && String(badFormat.message).includes('页面格式错误'))

// 项目页：POST 带 workspaceId 查询参数（POST 也带定位参数）。
const createdProject = (await call('/memory-book/page', {
  url: '/memory-book/page' + q({ workspaceId: 'ws-a' }),
  method: 'POST',
  body: { path: 'wiki/projects/项目新页', content: '---\ntitle: 项目新页\nsummary: 项目里新建\n---\n\n项目正文。\n' },
})).json
check('POST /page 按 workspaceId 写项目库', createdProject.ok === true && existsSync(path.join(rootA, 'wiki', 'projects', '项目新页.md')))

// ── 固定文档：面板读 / 写 / 历史 / 删除保护 ──────────────────────────────────
const briefPage = (await call('/memory-book/page', { url: '/memory-book/page' + q({ path: 'project/说明及目标', workspaceId: 'ws-a' }) })).json
check('固定页 meta.fixed', briefPage.ok === true && briefPage.meta.fixed === true && briefPage.meta.versioned === false && briefPage.meta.readOnly === false)
const latestStatus = (await call('/memory-book/page', { url: '/memory-book/page' + q({ path: 'project/状态/20260102-1000', workspaceId: 'ws-a' }) })).json
check('最新版本页 meta.versioned 且非只读', latestStatus.ok === true && latestStatus.meta.versioned === true && latestStatus.meta.doc === 'status' && latestStatus.meta.readOnly === false)
const oldStatus = (await call('/memory-book/page', { url: '/memory-book/page' + q({ path: 'project/状态/20260101-1000', workspaceId: 'ws-a' }) })).json
check('历史版本页 meta.readOnly=true', oldStatus.ok === true && oldStatus.meta.readOnly === true)
const writeOldVersion = (await call('/memory-book/page', {
  url: '/memory-book/page' + q({ workspaceId: 'ws-a' }),
  method: 'POST',
  body: { path: 'project/状态/20260101-1000', content: '改历史版本' },
})).json
check('面板写历史版本被拒', writeOldVersion.ok === false && String(writeOldVersion.message).includes('历史版本只读'), String(writeOldVersion.message))

// 面板写固定页：自动生成 frontmatter + 2000 字上限。
const writeBrief = (await call('/memory-book/page', {
  url: '/memory-book/page' + q({ workspaceId: 'ws-a' }),
  method: 'POST',
  body: { path: 'project/说明及目标', content: '# 项目甲\n\n面板编辑的目标。\n' },
})).json
check('面板写固定页成功并自动生成 frontmatter', writeBrief.ok === true && readFileSync(path.join(rootA, 'project', '说明及目标.md'), 'utf8').includes('title: 说明及目标'))
const briefTooLong = (await call('/memory-book/page', {
  url: '/memory-book/page' + q({ workspaceId: 'ws-a' }),
  method: 'POST',
  body: { path: 'project/说明及目标', content: '字'.repeat(2001) },
})).json
check('面板写说明及目标超 2000 字被拒', briefTooLong.ok === false && String(briefTooLong.message).includes('2001'), String(briefTooLong.message))

// 面板写经验页。
const writeExperience = (await call('/memory-book/page', {
  url: '/memory-book/page' + q({ workspaceId: 'ws-a' }),
  method: 'POST',
  body: { path: 'project/经验/新坑', content: '新经验正文。\n' },
})).json
check('面板写项目经验页成功', writeExperience.ok === true && existsSync(path.join(rootA, 'project', '经验', '新坑.md')))

// /history：版本列表（新→旧）。
const history = (await call('/memory-book/history', { url: '/memory-book/history' + q({ doc: 'status', workspaceId: 'ws-a' }) })).json
check('/history 返回版本列表', history.ok === true && history.doc === 'status' && history.versions.length === 2)
check('/history 新→旧排序', history.versions[0].path === 'project/状态/20260102-1000' && history.versions[1].path === 'project/状态/20260101-1000')
check('/history 版本带 title/updated/summary', history.versions[0].title === '状态 20260102-1000' && typeof history.versions[0].updated === 'string' && history.versions[0].summary === '第二次状态')
const historyZh = (await call('/memory-book/history', { url: '/memory-book/history' + q({ doc: '状态', scope: 'ws-a' }) })).json
check('/history 接受中文 doc 名', historyZh.ok === true && historyZh.versions.length === 2)
const historyBad = (await call('/memory-book/history', { url: '/memory-book/history' + q({ doc: 'nope', workspaceId: 'ws-a' }) })).json
check('/history 拒绝非法 doc', historyBad.ok === false && String(historyBad.message).includes('doc 必须是'))
const historyGlobal = (await call('/memory-book/history', { url: '/memory-book/history' + q({ doc: 'planning', scope: 'global' }) })).json
check('/history 全局库没有版本时返回空数组', historyGlobal.ok === true && historyGlobal.versions.length === 0)

// /delete：固定页拒绝，普通页通过。
const deleteFixed = (await call('/memory-book/delete', {
  url: '/memory-book/delete',
  method: 'POST',
  body: { path: 'project/说明及目标', workspaceId: 'ws-a' },
})).json
check('/delete 固定页返回 ok:false', deleteFixed.ok === false && String(deleteFixed.message).includes('固定文档不允许删除'))
const deleteVersion = (await call('/memory-book/delete', {
  url: '/memory-book/delete',
  method: 'POST',
  body: { path: 'project/状态/20260102-1000', workspaceId: 'ws-a' },
})).json
check('/delete 版本页返回 ok:false', deleteVersion.ok === false)
const deleteNormal = (await call('/memory-book/delete', {
  url: '/memory-book/delete',
  method: 'POST',
  body: { path: 'wiki/projects/项目新页', workspaceId: 'ws-a' },
})).json
check('/delete 普通页成功', deleteNormal.ok === true && !existsSync(path.join(rootA, 'wiki', 'projects', '项目新页.md')))
const deleteMissing = (await call('/memory-book/delete', {
  url: '/memory-book/delete',
  method: 'POST',
  body: { path: 'wiki/projects/不存在页', workspaceId: 'ws-a' },
})).json
check('/delete 不存在返回 ok:false', deleteMissing.ok === false)

// ── /search ─────────────────────────────────────────────────────────────────
const searchGlobal = (await call('/memory-book/search', { url: '/memory-book/search' + q({ q: '全局', scope: 'global' }) })).json
check('/search 全局命中', searchGlobal.ok === true && searchGlobal.hits.length > 0)
check('/search 不跨库（项目页不出现在全局搜索结果）', searchGlobal.hits.every((hit) => !String(hit.path).includes('共享页') || String(hit.title).includes('全局')), JSON.stringify(searchGlobal.hits.map((hit) => hit.path)))
const searchProject = (await call('/memory-book/search', { url: '/memory-book/search' + q({ q: '项目甲', workspaceId: 'ws-a' }) })).json
check('/search 项目库命中', searchProject.ok === true && searchProject.hits.some((hit) => hit.path === 'wiki/projects/共享页'))
const searchEmpty = (await call('/memory-book/search', { url: '/memory-book/search' })).json
check('/search 缺少 q 返回 ok:false', searchEmpty.ok === false)

// ── /settings ───────────────────────────────────────────────────────────────
const settings0 = (await call('/memory-book/settings')).json
check('/settings 默认值', settings0.ok === true && settings0.settings.coreChars === 1200 && settings0.settings.autoFollowup === true)
const saved = (await call('/memory-book/settings', {
  url: '/memory-book/settings',
  method: 'POST',
  body: { coreChars: 5000, mainCoreChars: 6000, indexChars: 1800, mainIndexChars: 3000, transientCoreChars: 500, transientIndexChars: 900, pagesPerDir: 4, fallbackRounds: 3, handoverChanges: 7, autoFollowup: false },
})).json
check(
  '/settings 10 项保存生效',
  saved.ok === true &&
    saved.settings.coreChars === 5000 &&
    saved.settings.mainCoreChars === 6000 &&
    saved.settings.pagesPerDir === 4 &&
    saved.settings.fallbackRounds === 3 &&
    saved.settings.handoverChanges === 7 &&
    saved.settings.autoFollowup === false,
  JSON.stringify(saved.settings),
)
check('/settings 写入全局 settings.json', JSON.parse(readFileSync(path.join(globalRoot, 'settings.json'), 'utf8')).coreChars === 5000)
const clamped = (await call('/memory-book/settings', { url: '/memory-book/settings', method: 'POST', body: { coreChars: 1 } })).json
check('/settings 越界被钳制', clamped.ok === true && clamped.settings.coreChars === 300, String(clamped.settings.coreChars))
const reset = (await call('/memory-book/settings', { url: '/memory-book/settings', method: 'POST', body: { reset: true } })).json
check('/settings 恢复默认并删文件', reset.ok === true && reset.settings.coreChars === 1200 && !existsSync(path.join(globalRoot, 'settings.json')))

// ── /resolve：跨库解析 ──────────────────────────────────────────────────────
const resolved = (await call('/memory-book/resolve', { url: '/memory-book/resolve' + q({ path: 'wiki/projects/共享页' }) })).json
check('/resolve 返回跨库命中', resolved.ok === true && resolved.candidates.length === 2, JSON.stringify(resolved.candidates))
check(
  '/resolve 全局候选字段',
  resolved.candidates.some((item) => item.kind === 'global' && item.title === '全局共享页' && item.path === 'wiki/projects/共享页'),
  JSON.stringify(resolved.candidates),
)
check(
  '/resolve 项目候选字段',
  resolved.candidates.some((item) => item.kind === 'project' && item.workspaceId === 'ws-a' && item.workspaceTitle === '项目甲' && item.title === '项目甲共享页'),
  JSON.stringify(resolved.candidates),
)
const resolveNone = (await call('/memory-book/resolve', { url: '/memory-book/resolve' + q({ path: 'wiki/projects/不存在页' }) })).json
check('/resolve 无命中返回空候选', resolveNone.ok === true && resolveNone.candidates.length === 0)
const resolveBad = (await call('/memory-book/resolve', { url: '/memory-book/resolve' + q({ path: '../etc/passwd' }) })).json
check('/resolve 非法路径返回 ok:false', resolveBad.ok === false)

// ── 鉴权：保留 connection.requestRejection ──────────────────────────────────
rejectionStatus = 401
const rejected = await call('/memory-book/library')
check('鉴权拒绝时返回 401 空响应', rejected.status === 401 && rejected.json === undefined, `status=${rejected.status}`)
rejectionStatus = undefined

if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 项: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\nOK: 面板接口 ${total} 项断言全部通过`)
