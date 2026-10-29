/**
 * Client half of memory-book.
 *
 * 界面参考灵犀客户端：顶部两个页签「核心记忆 / 知识库」。
 * - 核心记忆：看/改 core 正文（每轮全文注入的那份）。
 * - 知识库：搜索 + 分类栏 + 卡片列表；点开是「知识详情」——来源 / 更新 / 分类、
 *   摘要、正文（Markdown 渲染）、关联页面（可点击跳转）。
 *
 * 数据全部来自 Host 半边注册的 /memory-book/* 路由。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory-book',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const PANEL_ID = 'memory-book'
    const API = '/memory-book'
    const CORE_PATH = 'core/核心记忆'
    const ZH = /^zh/i.test(navigator.language || '')

    const T = ZH
      ? {
          label: '记忆',
          tabCore: '核心记忆',
          tabLibrary: '知识库',
          coreMissing: '还没有核心记忆。它是每轮全文注入的短规则（工作区路由、项目铁律），建议先写一份。',
          createCore: '创建核心记忆',
          edit: '编辑',
          save: '保存',
          cancel: '取消',
          del: '删除',
          delConfirm: '确定删除这一页吗？不可恢复。',
          searchPlaceholder: '请输入内容',
          all: '全部',
          newPage: '新建页面',
          newPath: '页面路径，如 wiki/lessons/某教训',
          create: '创建',
          detail: '知识详情',
          back: '返回',
          summary: '摘要',
          body: '正文',
          sources: '来源',
          related: '关联',
          updated: '更新',
          category: '分类',
          noSummary: '（无摘要）',
          emptyList: '这一分类还没有页面。',
          emptyAll: '记忆库还是空的。让 AI 用 memory 工具写第一页，或点右上角「+」。',
          injected: '每轮注入',
          chars: '字符',
          failed: '读取失败',
          saved: '已保存',
          loading: '读取中…',
          none: '无',
          config: '配置',
          settingsTitle: '注入预算',
          settingsHint: '每轮注入的三个上限。调大会增加每轮固定成本；调小会让内容被截断。只看当前用量的话，看页面底部的「每轮注入」。',
          coreLimitLabel: '核心记忆上限（字符）',
          indexLimitLabel: '索引上限（字符）',
          pagesPerDirLabel: '每个目录最多显示页数',
          defaultsNote: '默认值：4000 / 2500 / 8',
          resetDefault: '恢复默认',
          restored: '已恢复默认值',
          settingsSaved: '已保存配置',
        }
      : {
          label: 'Memory',
          tabCore: 'Core memory',
          tabLibrary: 'Library',
          coreMissing: 'No core memory yet. It is the short rule set injected every turn.',
          createCore: 'Create core memory',
          edit: 'Edit',
          save: 'Save',
          cancel: 'Cancel',
          del: 'Delete',
          delConfirm: 'Delete this page? This cannot be undone.',
          searchPlaceholder: 'Search',
          all: 'All',
          newPage: 'New page',
          newPath: 'Page path, e.g. wiki/lessons/some-lesson',
          create: 'Create',
          detail: 'Page detail',
          back: 'Back',
          summary: 'Summary',
          body: 'Body',
          sources: 'Sources',
          related: 'Related',
          updated: 'Updated',
          category: 'Category',
          noSummary: '(no summary)',
          emptyList: 'No pages in this category.',
          emptyAll: 'The memory library is empty.',
          injected: 'Injected per turn',
          chars: 'chars',
          failed: 'Failed to load',
          saved: 'Saved',
          loading: 'Loading…',
          none: 'None',
          config: 'Settings',
          settingsTitle: 'Injection budgets',
          settingsHint: 'Three caps for per-turn injection. Larger caps raise fixed cost; smaller caps truncate content.',
          coreLimitLabel: 'Core memory cap (chars)',
          indexLimitLabel: 'Index cap (chars)',
          pagesPerDirLabel: 'Pages listed per directory',
          defaultsNote: 'Defaults: 4000 / 2500 / 8',
          resetDefault: 'Restore defaults',
          restored: 'Defaults restored',
          settingsSaved: 'Settings saved',
        }

    const styles = {
      root: {
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        lineHeight: 1.55,
      },
      tabs: {
        display: 'flex',
        gap: '22px',
        padding: '14px 22px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      tab: {
        padding: '4px 2px 10px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '2px solid transparent',
        fontSize: '13.5px',
      },
      tabActive: {
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
        borderBottom: '2px solid var(--dsw-alias-brand-primary)',
      },
      body: { padding: '16px 22px 28px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      spacer: { flex: '1 1 auto' },
      dim: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px' },
      button: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '6px',
        padding: '4px 12px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        borderRadius: '6px',
        padding: '4px 12px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      danger: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '6px',
        padding: '3px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      searchBar: { display: 'flex', gap: '10px', alignItems: 'center' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: '12.5px',
      },
      plus: {
        width: '34px',
        height: '34px',
        flex: '0 0 auto',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '18px',
        lineHeight: 1,
        cursor: 'pointer',
      },
      columns: { display: 'flex', gap: '18px', marginTop: '14px', alignItems: 'flex-start' },
      rail: { flex: '0 0 132px', display: 'flex', flexDirection: 'column', gap: '2px' },
      railItem: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '7px 9px',
        borderRadius: '7px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary)',
      },
      railItemActive: {
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14))',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      railCount: { marginLeft: 'auto', fontSize: '11.5px' },
      list: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        cursor: 'pointer',
      },
      cardTitle: { display: 'flex', alignItems: 'baseline', gap: '10px' },
      cardTitleText: { fontWeight: 600, fontSize: '13.5px', flex: '1 1 auto', wordBreak: 'break-word' },
      cardSummary: {
        marginTop: '6px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
      },
      metaRow: {
        display: 'flex',
        gap: '18px',
        flexWrap: 'wrap',
        marginTop: '6px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11.5px',
      },
      sectionLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px', marginTop: '14px', marginBottom: '4px' },
      chip: {
        display: 'inline-block',
        margin: '0 6px 6px 0',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '11.5px',
        cursor: 'pointer',
      },
      paragraph: { margin: '6px 0', whiteSpace: 'pre-wrap' },
      input: {
        width: '120px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '320px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '12px',
        lineHeight: 1.65,
        resize: 'vertical',
      },
      error: { marginTop: '12px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      ok: { marginTop: '8px', color: 'var(--dsw-alias-state-success-primary, #2e7d32)', fontSize: '12px' },
      none: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────

    async function api(path, init) {
      const response = await fetch(API + path, init)
      const json = await response.json()
      if (!json || json.ok !== true) throw new Error((json && json.message) || T.failed)
      return json
    }

    function pad(value) {
      return String(value).padStart(2, '0')
    }

    /** ISO(UTC) → 本地 YYYY-MM-DD HH:mm:ss，与灵犀界面的「更新」一致。 */
    function formatTime(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso || ''
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    // ── Markdown 渲染（够用即可：标题/表格/列表/代码/引用/粗体/行内码） ──────────

    function renderInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
      let last = 0
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index))
        const token = match[0]
        if (token.startsWith('**')) {
          nodes.push(h('strong', { key: `${keyPrefix}-b-${index}` }, token.slice(2, -2)))
        } else {
          nodes.push(
            h(
              'code',
              { key: `${keyPrefix}-c-${index}`, style: { background: 'rgba(128,128,128,0.16)', padding: '1px 4px', borderRadius: '4px', fontSize: '11.5px' } },
              token.slice(1, -1),
            ),
          )
        }
        last = match.index + token.length
        index += 1
      }
      if (last < text.length) nodes.push(text.slice(last))
      return nodes
    }

    function splitRow(line) {
      return line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    }

    function renderMarkdown(source) {
      const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
      const blocks = []
      let i = 0
      let key = 0
      const cellStyle = { border: '1px solid var(--dsw-alias-border-l1)', padding: '6px 10px', textAlign: 'left' }
      while (i < lines.length) {
        const line = lines[i]

        if (/^\s*```/.test(line)) {
          const code = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            code.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(
            h(
              'pre',
              {
                key: `b${key++}`,
                style: {
                  background: 'var(--dsw-alias-bg-base)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  overflowX: 'auto',
                  fontSize: '11.5px',
                  lineHeight: 1.6,
                },
              },
              code.join('\n'),
            ),
          )
          continue
        }

        if (/^\s*$/.test(line)) {
          i += 1
          continue
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          const size = level <= 1 ? '16px' : level === 2 ? '15px' : '14px'
          blocks.push(
            h(
              'div',
              { key: `b${key++}`, style: { fontSize: size, fontWeight: 600, margin: level <= 2 ? '16px 0 6px' : '14px 0 6px' } },
              renderInline(heading[2], `h${key}`),
            ),
          )
          i += 1
          continue
        }

        if (/^\|.*\|$/.test(line) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
          const header = splitRow(line)
          i += 2
          const rows = []
          while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          blocks.push(
            h(
              'div',
              { key: `b${key++}`, style: { overflowX: 'auto', margin: '8px 0' } },
              h(
                'table',
                { style: { borderCollapse: 'collapse', fontSize: '12px', minWidth: '60%' } },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    header.map((cell, index) =>
                      h(
                        'th',
                        { key: index, style: { ...cellStyle, background: 'var(--dsw-alias-bg-layer-1)' } },
                        renderInline(cell, `th${index}`),
                      ),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  rows.map((row, rowIndex) =>
                    h(
                      'tr',
                      { key: rowIndex },
                      row.map((cell, cellIndex) => h('td', { key: cellIndex, style: cellStyle }, renderInline(cell, `td${rowIndex}-${cellIndex}`))),
                    ),
                  ),
                ),
              ),
            ),
          )
          continue
        }

        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
            i += 1
          }
          blocks.push(
            h(
              'ul',
              { key: `b${key++}`, style: { margin: '6px 0', paddingLeft: '20px' } },
              items.map((item, index) => h('li', { key: index }, renderInline(item, `li${index}`))),
            ),
          )
          continue
        }

        if (/^\s*\d+\.\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
            i += 1
          }
          blocks.push(
            h(
              'ol',
              { key: `b${key++}`, style: { margin: '6px 0', paddingLeft: '20px' } },
              items.map((item, index) => h('li', { key: index }, renderInline(item, `li${index}`))),
            ),
          )
          continue
        }

        if (/^>\s?/.test(line)) {
          const quoted = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            quoted.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          blocks.push(
            h(
              'blockquote',
              {
                key: `b${key++}`,
                style: {
                  margin: '8px 0',
                  padding: '2px 12px',
                  borderLeft: '3px solid var(--dsw-alias-border-l1)',
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              renderInline(quoted.join(' '), `q${key}`),
            ),
          )
          continue
        }

        if (/^\s*---+\s*$/.test(line)) {
          blocks.push(h('div', { key: `b${key++}`, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '14px 0' } }))
          i += 1
          continue
        }

        const paragraph = [line]
        i += 1
        while (
          i < lines.length &&
          !/^\s*$/.test(lines[i]) &&
          !/^(#{1,6})\s|^\s*[-*]\s|^\s*\d+\.\s|^>\s?|^\s*```|^\|.*\|$|^\s*---+\s*$/.test(lines[i])
        ) {
          paragraph.push(lines[i])
          i += 1
        }
        blocks.push(h('p', { key: `b${key++}`, style: styles.paragraph }, renderInline(paragraph.join('\n'), `p${key}`)))
      }
      return blocks
    }

    // ── 组件 ────────────────────────────────────────────────────────────────

    function Card(props) {
      const { page, onOpen } = props
      return h(
        'div',
        { style: styles.card, onClick: () => onOpen(page.path) },
        h('div', { style: styles.cardTitle }, h('div', { style: styles.cardTitleText }, page.title), h('div', { style: styles.dim }, formatTime(page.updated))),
        h('div', { style: styles.cardSummary }, page.summary || T.noSummary),
      )
    }

    function Chips(props) {
      const { items, onOpen, labelOf, empty } = props
      if (!items || items.length === 0) return h('div', { style: styles.none }, empty || T.none)
      return h(
        'div',
        null,
        items.map((item, index) =>
          h(
            'span',
            { key: `${item}-${index}`, style: styles.chip, onClick: () => onOpen(String(item).split('#')[0]), title: item },
            labelOf ? labelOf(item) : item.split('#')[0].replace(/^raw\//, '').replace(/^wiki\/[^/]+\//, ''),
          ),
        ),
      )
    }

    // ── 主组件 ──────────────────────────────────────────────────────────────

    function Panel() {
      const [tab, setTab] = useState('library')
      const [lib, setLib] = useState(null)
      const [core, setCore] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('all')
      const [selected, setSelected] = useState(null)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [creating, setCreating] = useState(false)
      const [newPath, setNewPath] = useState('')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [settingsDraft, setSettingsDraft] = useState(null)

      const loadLibrary = useCallback(async () => {
        try {
          const data = await api('/library')
          setLib(data)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }, [])

      const loadCore = useCallback(async () => {
        try {
          const data = await api(`/page?path=${encodeURIComponent(CORE_PATH)}`)
          setCore(data)
        } catch {
          setCore(null)
        }
      }, [])

      useEffect(() => {
        loadLibrary()
        loadCore()
      }, [loadCore, loadLibrary])

      const openPage = useCallback(async (path) => {
        setNotice('')
        setEditing(false)
        try {
          const data = await api(`/page?path=${encodeURIComponent(path)}`)
          setSelected(data)
          setDraft(data.content)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [])

      const save = useCallback(async () => {
        const target = tab === 'core' ? core : selected
        if (target === null || target === undefined) return
        try {
          await api('/page', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: target.path, content: draft }),
          })
          setNotice(T.saved)
          setEditing(false)
          await loadLibrary()
          if (tab === 'core') await loadCore()
          else await openPage(target.path)
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [core, draft, loadCore, loadLibrary, openPage, selected, tab])

      const remove = useCallback(async () => {
        if (selected === null || !window.confirm(T.delConfirm)) return
        try {
          await api('/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: selected.path }),
          })
          setSelected(null)
          setNotice('')
          await loadLibrary()
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [loadLibrary, selected])

      const create = useCallback(async () => {
        const path = newPath.trim()
        if (path === '') return
        const seed = '---\ntitle: 新页面\nsummary: 一句话说明这页回答什么问题\n---\n\n'
        try {
          await api('/page', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, content: seed }),
          })
          setCreating(false)
          setNewPath('')
          await loadLibrary()
          await openPage(path)
          setEditing(true)
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [loadLibrary, newPath, openPage])

      const createCore = useCallback(async () => {
        const content = '---\ntitle: 核心记忆\nsummary: 每轮必守的短规则：工作区路由、项目铁律\n---\n\n# 铁律\n\n1. \n'
        try {
          await api('/page', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: CORE_PATH, content }),
          })
          await loadLibrary()
          await loadCore()
          setDraft(content)
          setEditing(true)
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [loadCore, loadLibrary])

      const coreExists = lib !== null && lib.pages.some((page) => page.core)

      const saveSettingsDraft = useCallback(async () => {
        if (settingsDraft === null) return
        try {
          await api('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(settingsDraft),
          })
          setNotice(T.settingsSaved)
          setSettingsOpen(false)
          await loadLibrary()
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [loadLibrary, settingsDraft])

      const resetSettingsDraft = useCallback(async () => {
        try {
          const data = await api('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          })
          setSettingsDraft({ ...(data.settings || {}) })
          setNotice(T.restored)
          await loadLibrary()
        } catch (e) {
          setError(String(e.message || e))
        }
      }, [loadLibrary])
      const libraryPages = useMemo(() => {
        if (lib === null) return []
        return lib.pages.filter((page) => !page.core && (category === 'all' || page.category === category))
      }, [category, lib])

      const visiblePages = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return libraryPages
        return libraryPages.filter((page) =>
          [page.title, page.summary, page.path, ...(page.sources || []), ...(page.related || [])].join(' ').toLowerCase().includes(needle),
        )
      }, [libraryPages, query])

      const titleOfPath = useCallback(
        (path) => {
          const clean = String(path).split('#')[0]
          const found = lib?.pages.find((page) => page.path === clean)
          return found ? found.title : clean
        },
        [lib],
      )

      const labelOf = useCallback(
        (item) => {
          const [path, section] = String(item).split('#')
          const title = titleOfPath(path)
          return section ? `${title} · ${section}` : title
        },
        [titleOfPath],
      )

      const tabBar = h(
        'div',
        { style: styles.tabs },
        h(
          'div',
          {
            style: { ...styles.tab, ...(tab === 'core' ? styles.tabActive : {}) },
            onClick: () => {
              setTab('core')
              setSelected(null)
              setEditing(false)
            },
          },
          T.tabCore,
        ),
        h(
          'div',
          {
            style: { ...styles.tab, ...(tab === 'library' ? styles.tabActive : {}) },
            onClick: () => {
              setTab('library')
              setEditing(false)
            },
          },
          T.tabLibrary,
        ),
        h('div', { style: styles.spacer }),
        h(
          'div',
          {
            style: { ...styles.tab, ...(settingsOpen ? styles.tabActive : {}) },
            onClick: () => {
              setSettingsDraft(lib === null ? null : { ...(lib.settings || lib.defaults || {}) })
              setSettingsOpen(!settingsOpen)
              setSelected(null)
              setEditing(false)
            },
          },
          T.config,
        ),
      )

      const coreView = h(
        'div',
        { style: styles.body },
        loading
          ? h('div', { style: styles.dim }, T.loading)
          : coreExists === false
            ? h(
                'div',
                null,
                h('div', { style: styles.paragraph }, T.coreMissing),
                h('div', { style: { marginTop: '10px' } }, h('button', { style: styles.primary, onClick: createCore }, T.createCore)),
              )
            : core === null
              ? h('div', { style: styles.dim }, T.loading)
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { style: styles.row },
                    h('div', { style: { fontWeight: 600, fontSize: '15px' } }, core.fields.title || CORE_PATH),
                    h('div', { style: styles.spacer }),
                    h('div', { style: styles.dim }, `${T.updated}：${formatTime(core.updated)}`),
                    editing
                      ? [
                          h('button', { key: 'cancel', style: styles.button, onClick: () => { setEditing(false); setDraft(core.content) } }, T.cancel),
                          h('button', { key: 'save', style: styles.primary, onClick: save }, T.save),
                        ]
                      : h('button', { style: styles.button, onClick: () => { setDraft(core.content); setEditing(true) } }, T.edit),
                  ),
                  h('div', { style: styles.sectionLabel }, T.summary),
                  h('div', { style: styles.paragraph }, core.fields.summary || T.noSummary),
                  h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '14px 0' } }),
                  editing
                    ? h('textarea', { style: styles.textarea, value: draft, spellCheck: false, onChange: (event) => setDraft(event.target.value) })
                    : h('div', null, renderMarkdown(core.body)),
                ),
      )

      const rail = h(
        'div',
        { style: styles.rail },
        h(
          'div',
          {
            style: { ...styles.railItem, ...(category === 'all' ? styles.railItemActive : {}) },
            onClick: () => {
              setCategory('all')
              setSelected(null)
            },
          },
          h('span', null, T.all),
          h('span', { style: styles.railCount }, String(lib?.counts?.all ?? 0)),
        ),
        (lib?.categories || []).map((item) =>
          h(
            'div',
            {
              key: item.key,
              style: { ...styles.railItem, ...(category === item.key ? styles.railItemActive : {}) },
              onClick: () => {
                setCategory(item.key)
                setSelected(null)
              },
            },
            h('span', null, item.label),
            h('span', { style: styles.railCount }, String(item.count)),
          ),
        ),
      )

      const listView = h(
        'div',
        { style: styles.list },
        visiblePages.length === 0
          ? h('div', { style: styles.none }, lib !== null && lib.pages.length === 0 ? T.emptyAll : T.emptyList)
          : visiblePages.map((page) => h(Card, { key: page.path, page, onOpen: openPage })),
      )

      const detailView = selected === null ? null : h(
        'div',
        { style: styles.list },
        h(
          'div',
          { style: styles.row },
          h('button', { style: styles.button, onClick: () => { setSelected(null); setEditing(false) } }, `← ${T.back}`),
          h('div', { style: styles.spacer }),
          editing
            ? [
                h('button', { key: 'cancel', style: styles.button, onClick: () => { setEditing(false); setDraft(selected.content) } }, T.cancel),
                h('button', { key: 'save', style: styles.primary, onClick: save }, T.save),
              ]
            : [h('button', { key: 'edit', style: styles.button, onClick: () => { setDraft(selected.content); setEditing(true) } }, T.edit), h('button', { key: 'del', style: styles.danger, onClick: remove }, T.del)],
        ),
        h('div', { style: { marginTop: '10px', fontSize: '16px', fontWeight: 600 } }, selected.fields.title || selected.path),
        h(
          'div',
          { style: styles.metaRow },
          h('span', null, `${T.updated}：${formatTime(selected.updated)}`),
          h('span', null, `${T.category}：${selected.categoryLabel}`),        ),
        h('div', { style: styles.sectionLabel }, T.summary),
        h('div', { style: styles.paragraph }, selected.fields.summary || T.noSummary),
        h('div', { style: styles.sectionLabel }, T.sources),
        h(Chips, { items: selected.fields.sources, onOpen: openPage, labelOf, empty: T.none }),
        h('div', { style: styles.sectionLabel }, T.body),
        editing
          ? h('textarea', { style: styles.textarea, value: draft, spellCheck: false, onChange: (event) => setDraft(event.target.value) })
          : h('div', null, renderMarkdown(selected.body)),
        h('div', { style: styles.sectionLabel }, T.related),
        h(Chips, { items: selected.fields.related, onOpen: openPage, labelOf, empty: T.none }),
      )

      const libraryView = h(
        'div',
        { style: styles.body },
        h(
          'div',
          { style: styles.searchBar },
          h('input', {
            style: styles.input,
            placeholder: T.searchPlaceholder,
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { style: styles.plus, title: T.newPage, onClick: () => setCreating((value) => !value) }, '+'),
        ),
        creating
          ? h(
              'div',
              { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
              h('input', {
                style: styles.input,
                placeholder: T.newPath,
                value: newPath,
                onChange: (event) => setNewPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') create()
                },
              }),
              h('button', { style: styles.primary, onClick: create }, T.create),
            )
          : null,
        h('div', { style: styles.columns }, rail, selected === null ? listView : detailView),
        lib === null ? null : h('div', { style: { ...styles.dim, marginTop: '14px' } }, `${T.injected}：${lib.injected.totalChars} ${T.chars}（core ≤ ${lib.injected.coreLimit}，索引 ≤ ${lib.injected.indexLimit}）`),
      )

      const settingsView =
        settingsDraft === null
          ? h('div', { style: styles.body }, h('div', { style: styles.dim }, T.loading))
          : h(
              'div',
              { style: styles.body },
              h(
                'div',
                { style: styles.row },
                h('div', { style: { fontWeight: 600, fontSize: '15px' } }, T.settingsTitle),
                h('div', { style: styles.spacer }),
                h('button', { style: styles.button, onClick: () => setSettingsOpen(false) }, T.back),
              ),
              h('div', { style: { ...styles.paragraph, marginTop: '8px' } }, T.settingsHint),
              ...[
                ['coreChars', T.coreLimitLabel],
                ['indexChars', T.indexLimitLabel],
                ['pagesPerDir', T.pagesPerDirLabel],
              ].map(([key, label]) =>
                h(
                  'div',
                  { key, style: { ...styles.row, marginTop: '12px' } },
                  h('div', { style: { width: '230px' } }, label),
                  h('input', {
                    type: 'number',
                    style: styles.input,
                    value: settingsDraft[key],
                    onChange: (event) => setSettingsDraft({ ...settingsDraft, [key]: Number(event.target.value) }),
                  }),
                ),
              ),
              h('div', { style: { ...styles.dim, marginTop: '10px' } }, T.defaultsNote),
              h(
                'div',
                { style: { ...styles.row, marginTop: '16px' } },
                h('button', { style: styles.primary, onClick: saveSettingsDraft }, T.save),
                h('button', { style: styles.button, onClick: resetSettingsDraft }, T.resetDefault),
              ),
            )

      return h(
        'div',
        { style: styles.root },
        tabBar,
        settingsOpen ? settingsView : tab === 'core' ? coreView : libraryView,
        error === '' ? null : h('div', { style: { ...styles.error, padding: '0 22px 18px' } }, error),
        notice === '' ? null : h('div', { style: { ...styles.ok, padding: '0 22px 18px' } }, notice),
      )
    }

    function PanelIcon(props) {
      const size = props && props.size ? props.size : 20
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4 5.5A2 2 0 0 1 6 3.5h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 3.5v17', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M11.2 8.4h5M11.2 11.7h5M11.2 15h3.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: T.label }, PanelIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
      },
    }
  },
})
