/**
 * memory-book 客户端半边（v0.13.0「按项目独立」改造）。
 *
 * 界面结构：
 * - 侧栏「记忆」面板：顶部「记忆范围」下拉（全局记忆库 + 各工作区），
 *   下面四个页签：项目文档 / 核心记忆 / 知识库 / 配置。
 * - 会话页眉「本项目记忆」按钮（会话级插槽，能拿到 sessionId）：定位当前会话的
 *   主项目并打开本面板。
 * - 引用（sources / related）先按当前库打开，失败再跨库查 /resolve；多条命中弹出候选。
 * - 临时项目提示条：library 返回 transient（当前工作目录所属项目）时显示，可一键跳转。
 *
 * 所有数据来自 Host 半边注册的 /memory-book/* 路由；定位库统一用
 * scope=global / workspaceId=<id> / sessionId=<id> 三种查询参数（设计稿 §8.1）。
 * 代码注释为中文；英文文案只用于非中文界面。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-memory-book',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PANEL_ID = 'memory-book'
    const API = '/memory-book'
    const CORE_PATH = 'core/核心记忆'
    // 浏览器本地记录「上次选择的记忆范围」，按 §7.1 只记在本地。
    const STORE_KEY = 'dsh.memory-book.scope'
    const ZH = /^zh/i.test(navigator.language || '')

    // 7 类固定文档里 6 个版本化/单文件文档的固定顺序（第 7 类是项目经验，单独渲染）。
    const DOC_ORDER = ['brief', 'planning', 'plan', 'status', 'handover', 'decisions']
    const DOC_LABELS = ZH
      ? { brief: '说明及目标', planning: '策划', plan: '计划', status: '状态', handover: '交接', decisions: '决策历史' }
      : { brief: 'Brief & goals', planning: 'Planning', plan: 'Plan', status: 'Status', handover: 'Handover', decisions: 'Decisions' }

    // 配置 10 项的字段名（与 Host 约定，见设计稿 §5 / §8.1）。
    const SETTING_DEFAULTS = {
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
    const SETTING_ROWS = [
      ['coreChars', 'globalCoreLabel'],
      ['mainCoreChars', 'mainCoreLabel'],
      ['transientCoreChars', 'transientCoreLabel'],
      ['indexChars', 'globalIndexLabel'],
      ['mainIndexChars', 'mainIndexLabel'],
      ['transientIndexChars', 'transientIndexLabel'],
      ['pagesPerDir', 'pagesPerDirLabel'],
      ['fallbackRounds', 'fallbackRoundsLabel'],
      ['handoverChanges', 'handoverChangesLabel'],
    ]
    // Host 没返回 limits 时用的兜底范围（设计稿 §5 的「范围」列）。
    const SETTING_LIMITS = {
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

    const T = ZH
      ? {
          label: '记忆',
          headerButton: '本项目记忆',
          scopeLabel: '记忆范围',
          scopeGlobal: '全局记忆库',
          hasMemory: '有记忆',
          noMemory: '无记忆',
          customScope: '当前范围',
          tabDocs: '项目文档',
          tabCore: '核心记忆',
          tabLibrary: '知识库',
          tabConfig: '配置',
          docsTitle: '固定文档',
          docsHint: '固定文档由引擎管理：可手改、不可删除；版本化文档保留全部历史版本，历史版本只读。',
          docsGlobalNone: '全局记忆库没有固定文档（固定文档只属于项目库）。',
          docMissing: '未创建 ⚠ 必须创建',
          docMissingHint: '还没有创建，AI 会在下一轮补更时创建。',
          docHistory: '历史版本',
          docVersionCount: '个版本',
          latest: '最新',
          expTitle: '项目经验',
          expNone: '还没有项目经验页。',
          historyHint: '历史版本只读，按时间从新到旧排列。',
          historyEmpty: '还没有历史版本。',
          backToDocs: '返回文档',
          readOnly: '只读',
          fixedTag: '固定文档',
          versionedTag: '版本化',
          docKey: '文档',
          transientBanner: '当前工作目录属于：',
          transientJump: '跳转到该项目',
          transientNoWorkspace: '这个目录还没有加入工作区，暂时无法在这里跳转。',
          resolveTitle: '这个页面在多个库中存在，请选择要打开的库：',
          resolveNone: '所有库都没有找到这个页面：',
          emptyAll: '记忆库还是空的。让 AI 用 memory 工具写第一页，或点右上角「+」。',
          emptyProject: '这个项目还没有记忆，首次写入时自动创建。',
          emptyList: '这一分类还没有页面。',
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
          injected: '每轮注入',
          chars: '字符',
          failed: '读取失败',
          saved: '已保存',
          loading: '读取中…',
          none: '无',
          dir: '库目录',
          settingsTitle: '注入预算与维护节奏',
          settingsHint: '前 6 项是三份记忆的每轮注入上限，第 7 项是每个目录最多列出的页数，后 3 项是维护节奏。调大会增加每轮固定成本；调小会让内容被截断。',
          defaultsNote: '保存后写入全局 settings.json；「恢复默认」会删除它。',
          defaultsLabel: '默认值',
          settingRange: '范围 {min}–{max}',
          resetDefault: '恢复默认',
          restored: '已恢复默认值',
          settingsSaved: '已保存配置',
          globalCoreLabel: '全局核心记忆上限（字符）',
          mainCoreLabel: '主项目核心记忆上限（字符）',
          transientCoreLabel: '临时项目核心记忆上限（字符）',
          globalIndexLabel: '全局索引上限（字符）',
          mainIndexLabel: '主项目索引上限（字符）',
          transientIndexLabel: '临时项目索引上限（字符）',
          pagesPerDirLabel: '每个目录最多显示页数',
          fallbackRoundsLabel: '兜底提醒间隔（轮）',
          handoverChangesLabel: '交接间隔（次实质变化）',
          autoFollowupLabel: '自动补更轮（触发即强制跑）',
        }
      : {
          label: 'Memory',
          headerButton: 'Project memory',
          scopeLabel: 'Memory scope',
          scopeGlobal: 'Global memory',
          hasMemory: 'has memory',
          noMemory: 'no memory',
          customScope: 'Current scope',
          tabDocs: 'Project docs',
          tabCore: 'Core memory',
          tabLibrary: 'Library',
          tabConfig: 'Settings',
          docsTitle: 'Fixed docs',
          docsHint: 'Fixed docs are engine-managed: editable, never deletable. Versioned docs keep all history, and history is read-only.',
          docsGlobalNone: 'The global library has no fixed docs (fixed docs belong to project libraries).',
          docMissing: 'Missing ⚠ must be created',
          docMissingHint: 'Not created yet; the agent creates it on the next maintenance round.',
          docHistory: 'History',
          docVersionCount: 'version(s)',
          latest: 'Latest',
          expTitle: 'Project experiences',
          expNone: 'No project experience pages yet.',
          historyHint: 'History is read-only, newest first.',
          historyEmpty: 'No historical versions.',
          backToDocs: 'Back to docs',
          readOnly: 'Read-only',
          fixedTag: 'Fixed doc',
          versionedTag: 'Versioned',
          docKey: 'Doc',
          transientBanner: 'Current working directory belongs to: ',
          transientJump: 'Switch to it',
          transientNoWorkspace: 'This directory is not a workspace yet, so it cannot be opened here.',
          resolveTitle: 'This page exists in several libraries. Choose one:',
          resolveNone: 'No library contains this page: ',
          emptyAll: 'The memory library is empty.',
          emptyProject: 'This project has no memory yet. It is created on the first write.',
          emptyList: 'No pages in this category.',
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
          injected: 'Injected per turn',
          chars: 'chars',
          failed: 'Failed to load',
          saved: 'Saved',
          loading: 'Loading…',
          none: 'None',
          dir: 'Library',
          settingsTitle: 'Injection budgets and maintenance',
          settingsHint: 'The first 6 caps bound per-turn injection; the 7th limits pages per directory; the last 3 are maintenance rhythms.',
          defaultsNote: 'Saving writes the global settings.json; “Restore defaults” deletes it.',
          defaultsLabel: 'Defaults',
          settingRange: 'Range {min}–{max}',
          resetDefault: 'Restore defaults',
          restored: 'Defaults restored',
          settingsSaved: 'Settings saved',
          globalCoreLabel: 'Global core cap (chars)',
          mainCoreLabel: 'Main project core cap (chars)',
          transientCoreLabel: 'Transient project core cap (chars)',
          globalIndexLabel: 'Global index cap (chars)',
          mainIndexLabel: 'Main project index cap (chars)',
          transientIndexLabel: 'Transient project index cap (chars)',
          pagesPerDirLabel: 'Pages listed per directory',
          fallbackRoundsLabel: 'Fallback reminder interval (turns)',
          handoverChangesLabel: 'Handover interval (substantive changes)',
          autoFollowupLabel: 'Auto follow-up round (forced when triggered)',
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
      scopeBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        padding: '14px 22px 10px',
      },
      scopeLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      scopeSelect: {
        padding: '5px 8px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        maxWidth: '100%',
      },
      banner: {
        margin: '0 22px 8px',
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-state-warning-primary, #b8860b)',
        background: 'rgba(184, 134, 11, 0.12)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexWrap: 'wrap',
        fontSize: '12px',
      },
      tabs: {
        display: 'flex',
        gap: '22px',
        padding: '2px 22px 0',
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
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        whiteSpace: 'nowrap',
      },
      headerButton: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '999px',
        padding: '3px 10px',
        fontSize: '12px',
        lineHeight: 1.2,
        cursor: 'pointer',
      },
      headerButtonText: { whiteSpace: 'nowrap' },
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
      numberInput: {
        width: '120px',
        padding: '4px 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
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
      sectionTitle: { fontWeight: 600, fontSize: '13.5px', marginTop: '16px' },
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
      warn: { color: 'var(--dsw-alias-state-warning-primary, #b8860b)', fontSize: '11.5px' },
      docList: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' },
      docRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        flexWrap: 'wrap',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '9px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '9px 12px',
        cursor: 'pointer',
      },
      docRowMissing: { borderStyle: 'dashed', background: 'transparent', cursor: 'default' },
      docTitle: { fontWeight: 600, fontSize: '12.5px', flex: '0 1 auto' },
      docInfo: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11.5px', flex: '1 1 240px', wordBreak: 'break-word' },
      settingRow: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px' },
      settingLabel: { width: '260px', flex: '0 0 auto' },
      candidateBox: {
        marginTop: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '9px',
        padding: '10px 12px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      candidateRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '7px 8px',
        borderRadius: '7px',
        cursor: 'pointer',
      },
    }

    // ── 模块级状态：当前焦点项目 store + 布局服务引用 ─────────────────────────
    // 页眉按钮（conversation.session.header.utilities，会话级）与主面板不在同一组件树，
    // 所以用模块级 store 传递「本会话主项目」。面板订阅它，点击按钮后自动切换范围。

    const focusStore = { value: null, seq: 0 }
    const focusListeners = new Set()
    let layoutService = null

    function publishFocus(next) {
      focusStore.seq += 1
      focusStore.value = { ...(next || {}), at: focusStore.seq }
      for (const listener of focusListeners) {
        try {
          listener(focusStore.value)
        } catch (error) {
          // 单个订阅者出错不影响其他订阅者
        }
      }
    }

    function useFocusValue() {
      const [value, setValue] = useState(focusStore.value)
      useEffect(() => {
        const listener = (next) => setValue(next)
        focusListeners.add(listener)
        return () => {
          focusListeners.delete(listener)
        }
      }, [])
      return value
    }

    function openMemoryPanel() {
      if (!layoutService || typeof layoutService.selectPanel !== 'function') return
      try {
        layoutService.selectPanel(PANEL_ID)
      } catch (error) {
        // 面板还没注册时 selectPanel 会抛错：忽略，等用户从侧栏点开
      }
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

    /** 归一化路径：统一分隔符、去尾部斜杠、Windows 下不区分大小写。 */
    function samePath(left, right) {
      const normalize = (value) => String(value || '').replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()
      const a = normalize(left)
      const b = normalize(right)
      return a !== '' && a === b
    }

    /** 库定位参数：scope=global / workspaceId=<id> / sessionId=<id>（设计稿 §8.1）。 */
    function scopeQuery(locator) {
      if (!locator) return ''
      if (locator.kind === 'global') return 'scope=global'
      if (locator.sessionId) return `sessionId=${encodeURIComponent(locator.sessionId)}`
      if (locator.workspaceId) return `workspaceId=${encodeURIComponent(locator.workspaceId)}`
      return ''
    }

    function withScope(path, locator) {
      const query = scopeQuery(locator)
      if (query === '') return path
      return path + (path.includes('?') ? '&' : '?') + query
    }

    function locatorKey(locator) {
      if (!locator) return ''
      if (locator.kind === 'global') return 'global'
      if (locator.sessionId) return 'session:' + locator.sessionId
      if (locator.workspaceId) return 'ws:' + locator.workspaceId
      return ''
    }

    function readStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : null
      } catch (error) {
        return null
      }
    }

    function writeStore(locator) {
      try {
        const value =
          locator && locator.kind === 'global'
            ? { kind: 'global' }
            : locator && locator.workspaceId
              ? { kind: 'project', workspaceId: locator.workspaceId }
              : null
        if (value === null) window.localStorage.removeItem(STORE_KEY)
        else window.localStorage.setItem(STORE_KEY, JSON.stringify(value))
      } catch (error) {
        // 隐私模式/无 localStorage 时静默降级：只是不记住选择
      }
    }

    /** 固定文档路径（项目库里固定在 project/ 下）。 */
    function isFixedPath(path) {
      return String(path || '').startsWith('project/')
    }

    /** 临地项目信息兜底解析：Host 约定字段名 transient；兼容旧命名的临时写法。 */
    function transientOf(lib) {
      if (!lib) return null
      const raw = lib.transient || lib.temporary || lib.tempProject || null
      if (!raw) return null
      if (raw.kind && raw.kind !== 'project') return null
      return raw
    }

    function buildSettingsDraft(lib) {
      const merged = { ...SETTING_DEFAULTS }
      if (lib && lib.defaults && typeof lib.defaults === 'object') Object.assign(merged, lib.defaults)
      if (lib && lib.settings && typeof lib.settings === 'object') Object.assign(merged, lib.settings)
      if (merged.autoFollowup === undefined) merged.autoFollowup = true
      return merged
    }

    function limitOf(lib, key) {
      const raw = lib && lib.limits ? lib.limits[key] : null
      if (Array.isArray(raw) && raw.length >= 2 && Number.isFinite(Number(raw[0])) && Number.isFinite(Number(raw[1]))) {
        return [Number(raw[0]), Number(raw[1])]
      }
      return SETTING_LIMITS[key] || null
    }

    function limitText(lib, key) {
      const range = limitOf(lib, key)
      if (range === null) return ''
      return T.settingRange.replace('{min}', String(range[0])).replace('{max}', String(range[1]))
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

    // ── 子组件 ──────────────────────────────────────────────────────────────

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

    /** 项目文档页签里的一行：固定文档（单文件或版本化最新版）。 */
    function DocRow(props) {
      const { item, onOpen, onHistory } = props
      const title = item.label || DOC_LABELS[item.doc] || item.doc
      const versions = Number(item.versions || 0)
      const missing = item.missing === true || !item.latestPath
      return h(
        'div',
        { style: { ...styles.docRow, ...(missing ? styles.docRowMissing : {}) }, onClick: missing ? undefined : () => onOpen(item.latestPath) },
        h('div', { style: styles.docTitle }, title),
        missing
          ? h('div', { style: styles.docInfo }, T.docMissing)
          : h(
              'div',
              { style: styles.docInfo },
              `${T.latest}：${item.latestTitle || item.latestPath} · ${formatTime(item.updated)} · ${versions} ${T.docVersionCount}${item.chars ? ` · ${item.chars} ${T.chars}` : ''}`,
            ),
        missing || versions === 0
          ? null
          : h(
              'button',
              {
                type: 'button',
                style: styles.button,
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onHistory(item.doc)
                },
              },
              `${T.docHistory}（${versions}）`,
            ),
      )
    }

    /** 历史版本一行：只读，点开查看。 */
    function VersionRow(props) {
      const { version, onOpen } = props
      return h(
        'div',
        { style: styles.docRow, onClick: () => onOpen(version.path) },
        h('div', { style: styles.docTitle }, version.title || version.path),
        h('div', { style: styles.docInfo }, `${formatTime(version.updated)}${version.summary ? ' · ' + version.summary : ''}`),
      )
    }

    /** 跨库候选一行：显示所在库与页面路径。 */
    function CandidateRow(props) {
      const { candidate, onOpen } = props
      const where = candidate.kind === 'global' ? T.scopeGlobal : candidate.workspaceTitle || candidate.title || ''
      return h(
        'div',
        { style: styles.candidateRow, onClick: () => onOpen(candidate) },
        h('span', { style: styles.badge }, where),
        h('span', { style: { fontWeight: 600 } }, candidate.title || candidate.path),
        h('span', { style: styles.dim }, candidate.path),
      )
    }

    // ── 主组件 ──────────────────────────────────────────────────────────────

    function Panel() {
      // 页签与范围
      const [tab, setTab] = useState('docs')
      const [locator, setLocator] = useState(null)
      const [projects, setProjects] = useState(null)
      // 当前库数据
      const [lib, setLib] = useState(null)
      const [core, setCore] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      // 知识库
      const [query, setQuery] = useState('')
      const [searchResults, setSearchResults] = useState(null)
      const [category, setCategory] = useState('all')
      const [creating, setCreating] = useState(false)
      const [newPath, setNewPath] = useState('')
      // 页面详情
      const [selected, setSelected] = useState(null)
      const [readOnlyOverride, setReadOnlyOverride] = useState(false)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      // 项目文档 / 历史版本 / 跨库候选
      const [history, setHistory] = useState(null)
      const [resolveCandidates, setResolveCandidates] = useState(null)
      // 配置
      const [settingsDraft, setSettingsDraft] = useState(null)

      // 模块级焦点（页眉按钮写入）
      const focusValue = useFocusValue()

      // 防重复执行的 ref（也方便假 React 运行时测试）
      const bootedRef = useRef(false)
      const loadedKeyRef = useRef('')
      const focusHandledRef = useRef(0)
      const searchKeyRef = useRef('')

      // ── 数据加载 ────────────────────────────────────────────────────────

      const loadLibrary = useCallback(async (target) => {
        try {
          const data = await api(withScope('/library', target))
          setLib(data)
          setError('')
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setLoading(false)
        }
      }, [])

      const loadCore = useCallback(async (target) => {
        try {
          const data = await api(withScope(`/page?path=${encodeURIComponent(CORE_PATH)}`, target))
          setCore(data)
        } catch (error) {
          setCore(null)
        }
      }, [])

      /** 打开一个页面。返回是否成功；quiet=true 时不写错误（跨库跳转前半段用）。 */
      const openPageAt = useCallback(
        async (path, target, options) => {
          const opts = options || {}
          setNotice('')
          setEditing(false)
          setReadOnlyOverride(opts.readOnly === true)
          const clean = String(path || '').split('#')[0]
          try {
            const data = await api(withScope(`/page?path=${encodeURIComponent(clean)}`, target || locator))
            setSelected(data)
            setDraft(data.content || '')
            setError('')
            return true
          } catch (e) {
            if (opts.quiet !== true) setError(String((e && e.message) || e))
            return false
          }
        },
        [locator],
      )

      /** 切换记忆范围（下拉或临时项目跳转都用它）。 */
      const changeScope = useCallback((next, persist) => {
        setLocator(next)
        if (persist === true) writeStore(next)
        setSelected(null)
        setReadOnlyOverride(false)
        setEditing(false)
        setHistory(null)
        setResolveCandidates(null)
        setQuery('')
        setSearchResults(null)
        setCategory('all')
        setError('')
        setNotice('')
      }, [])

      /** 跨库候选跳转：切范围 + 打开目标页。 */
      const jumpToCandidate = useCallback(
        async (candidate) => {
          if (!candidate || !candidate.path) return
          const next = candidate.kind === 'global' ? { kind: 'global' } : { kind: 'project', workspaceId: candidate.workspaceId }
          changeScope(next, true)
          setTab('library')
          // 最后一步失败要显示错误（前面的本库尝试是静默的）
          await openPageAt(candidate.path, next, {})
        },
        [changeScope, openPageAt],
      )

      /** 引用 chip：先按当前库打开；失败再跨库查（/resolve），多命中给候选。 */
      const openReference = useCallback(
        async (ref) => {
          const clean = String(ref || '').split('#')[0]
          if (clean === '') return
          const opened = await openPageAt(clean, locator, { quiet: true })
          if (opened) return
          try {
            const data = await api(`/resolve?path=${encodeURIComponent(clean)}`)
            const candidates = Array.isArray(data.candidates) ? data.candidates : []
            if (candidates.length === 0) {
              setError(T.resolveNone + clean)
              return
            }
            if (candidates.length === 1) {
              await jumpToCandidate(candidates[0])
              return
            }
            setResolveCandidates({ ref: clean, candidates })
          } catch (e) {
            setError(String((e && e.message) || e))
          }
        },
        [jumpToCandidate, locator, openPageAt],
      )

      /** 打开当前库里的已知页面（文档/卡片/关联页都用它）。 */
      const openPage = useCallback(
        async (path) => {
          await openPageAt(path, locator, {})
        },
        [locator, openPageAt],
      )

      /** 读取某版本化文档的历史版本列表（新→旧）。 */
      const loadHistory = useCallback(
        async (doc) => {
          try {
            const data = await api(withScope(`/history?doc=${encodeURIComponent(doc)}`, locator))
            const versions = Array.isArray(data.versions) ? data.versions : []
            let label = DOC_LABELS[doc] || doc
            if (lib && Array.isArray(lib.docs)) {
              const found = lib.docs.find((item) => item.doc === doc)
              if (found && found.label) label = found.label
            }
            setHistory({ doc, label, versions })
            setSelected(null)
            setEditing(false)
            setError('')
          } catch (e) {
            setError(String((e && e.message) || e))
          }
        },
        [lib, locator],
      )

      /** 浏览器本地记录的下拉选择 → 实际定位参数。 */
      const onScopeSelect = useCallback(
        (value) => {
          if (value === 'global') {
            changeScope({ kind: 'global' }, true)
            return
          }
          if (typeof value === 'string' && value.startsWith('ws:')) {
            const workspaceId = value.slice(3)
            const found = ((projects && projects.projects) || []).find((item) => item.workspaceId === workspaceId)
            changeScope({ kind: 'project', workspaceId, title: found && found.title, path: found && found.path }, true)
          }
        },
        [changeScope, projects],
      )

      /** 临时项目提示条 → 跳转到该项目（须是已登记的工作区）。 */
      const jumpToTransient = useCallback(() => {
        const temp = transientOf(lib)
        if (temp === null) return
        const list = (projects && projects.projects) || []
        const found = list.find((item) => samePath(item.path, temp.path) || (temp.workspaceId && item.workspaceId === temp.workspaceId))
        if (!found) {
          setError(T.transientNoWorkspace)
          return
        }
        changeScope({ kind: 'project', workspaceId: found.workspaceId, title: found.title, path: found.path }, true)
      }, [changeScope, lib, projects])

      // ── 写操作 ──────────────────────────────────────────────────────────

      const save = useCallback(async () => {
        const target = selected !== null ? selected : tab === 'core' ? core : null
        if (target === null || target === undefined) return
        try {
          await api(withScope('/page', locator), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: target.path, content: draft }),
          })
          await loadLibrary(locator)
          if (selected !== null) {
            await openPageAt(target.path, locator, {})
          } else {
            await loadCore(locator)
          }
          setNotice(T.saved)
          setEditing(false)
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [core, draft, loadCore, loadLibrary, locator, openPageAt, selected, tab])

      const remove = useCallback(async () => {
        if (selected === null || !window.confirm(T.delConfirm)) return
        try {
          await api(withScope('/delete', locator), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: selected.path }),
          })
          setSelected(null)
          setNotice('')
          await loadLibrary(locator)
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [loadLibrary, locator, selected])

      const create = useCallback(async () => {
        const path = newPath.trim()
        if (path === '') return
        const seed = '---\ntitle: 新页面\nsummary: 一句话说明这页回答什么问题\n---\n\n'
        try {
          await api(withScope('/page', locator), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path, content: seed }),
          })
          setCreating(false)
          setNewPath('')
          await loadLibrary(locator)
          await openPageAt(path, locator, {})
          setEditing(true)
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [loadLibrary, locator, newPath, openPageAt])

      const createCore = useCallback(async () => {
        const content = '---\ntitle: 核心记忆\nsummary: 每轮必守的短规则：工作区路由、项目铁律\n---\n\n# 铁律\n\n1. \n'
        try {
          await api(withScope('/page', locator), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: CORE_PATH, content }),
          })
          await loadLibrary(locator)
          await loadCore(locator)
          setDraft(content)
          setEditing(true)
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [loadCore, loadLibrary, locator])

      const saveSettingsDraft = useCallback(async () => {
        if (settingsDraft === null) return
        try {
          await api('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(settingsDraft),
          })
          setNotice(T.settingsSaved)
          await loadLibrary(locator)
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [loadLibrary, locator, settingsDraft])

      const resetSettingsDraft = useCallback(async () => {
        try {
          const data = await api('/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          })
          setSettingsDraft(buildSettingsDraft(data && data.settings ? { settings: data.settings } : null))
          setNotice(T.restored)
          await loadLibrary(locator)
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [loadLibrary, locator])

      const openConfig = useCallback(() => {
        setTab('config')
        setSelected(null)
        setEditing(false)
        setHistory(null)
        setReadOnlyOverride(false)
        setSettingsDraft(buildSettingsDraft(lib))
      }, [lib])

      // ── 副作用：启动、按范围加载、焦点同步、搜索 ─────────────────────────

      /** 启动：拉 /projects，决定初始范围（焦点 > 本地记忆 > 第一个有记忆的项目 > 全局）。 */
      const bootstrap = useCallback(async () => {
        let data = null
        try {
          data = await api('/projects')
        } catch (e) {
          setError(String((e && e.message) || e))
        }
        const projectList = data && Array.isArray(data.projects) ? data.projects : []
        setProjects({ global: (data && data.global) || null, projects: projectList })

        const focused = focusStore.value
        let next = null
        if (focused && focused.sessionId) next = { kind: 'project', sessionId: focused.sessionId }
        else if (focused && focused.scope && focused.scope.kind === 'global') next = { kind: 'global' }

        if (next === null) {
          const saved = readStore()
          if (saved && saved.kind === 'global') {
            next = { kind: 'global' }
          } else if (saved && saved.workspaceId) {
            const found = projectList.find((item) => item.workspaceId === saved.workspaceId)
            if (found) next = { kind: 'project', workspaceId: found.workspaceId, title: found.title, path: found.path }
          }
        }
        if (next === null) {
          const withMemory = projectList.find((item) => item.hasMemory === true)
          next = withMemory
            ? { kind: 'project', workspaceId: withMemory.workspaceId, title: withMemory.title, path: withMemory.path }
            : { kind: 'global' }
        }
        setLocator(next)
      }, [])

      useEffect(() => {
        if (bootedRef.current) return
        bootedRef.current = true
        bootstrap()
      }, [bootstrap])

      useEffect(() => {
        if (locator === null) return
        const key = locatorKey(locator)
        if (loadedKeyRef.current === key) return
        loadedKeyRef.current = key
        loadLibrary(locator)
        loadCore(locator)
      }, [loadLibrary, loadCore, locator])

      // 页眉按钮写入的焦点：只在值更新时切换范围（用自增序号识别重复执行）。
      useEffect(() => {
        if (!focusValue || !focusValue.at || focusValue.at === focusHandledRef.current) return
        focusHandledRef.current = focusValue.at
        let next = null
        if (focusValue.sessionId) next = { kind: 'project', sessionId: focusValue.sessionId }
        else if (focusValue.scope && focusValue.scope.kind === 'global') next = { kind: 'global' }
        if (next !== null) changeScope(next, false)
      }, [changeScope, focusValue])

      // 搜索：非空时请求 /search（失败则退回本库本地过滤）。
      useEffect(() => {
        const needle = query.trim()
        const key = `${needle}|${locatorKey(locator)}`
        if (searchKeyRef.current === key) return
        searchKeyRef.current = key
        if (needle === '' || locator === null) {
          setSearchResults(null)
          return
        }
        api(withScope(`/search?q=${encodeURIComponent(needle)}`, locator))
          .then((data) => setSearchResults(Array.isArray(data.pages) ? data.pages : Array.isArray(data.hits) ? data.hits : []))
          .catch(() => setSearchResults(null))
      }, [locator, query])

      // ── 派生数据 ────────────────────────────────────────────────────────

      const isGlobal = lib !== null && lib.scope !== undefined && lib.scope !== null && lib.scope.kind === 'global'

      const libraryPages = useMemo(() => {
        if (lib === null || !Array.isArray(lib.pages)) return []
        return lib.pages.filter(
          (page) => page.core !== true && !isFixedPath(page.path) && (category === 'all' || page.category === category),
        )
      }, [category, lib])

      const visiblePages = useMemo(() => {
        const needle = query.trim()
        // 有服务端检索结果时直接用（Host 的 /search 返回 hits，只按页面兜底不用再本地过滤）
        if (needle !== '' && Array.isArray(searchResults)) {
          return searchResults.filter((page) => page.core !== true && !isFixedPath(page.path))
        }
        if (needle === '') return libraryPages
        return libraryPages.filter((page) =>
          [page.title, page.summary, page.path, ...(page.sources || []), ...(page.related || [])].join(' ').toLowerCase().includes(needle.toLowerCase()),
        )
      }, [libraryPages, query, searchResults])

      /** 项目文档页签的 6 项固定文档；Host 没给 docs 时按缺失占位。 */
      const docs = useMemo(() => {
        if (lib === null || isGlobal) return []
        const list = Array.isArray(lib.docs) ? lib.docs : []
        const byDoc = new Map(list.map((item) => [item.doc, item]))
        return DOC_ORDER.map(
          (doc) =>
            byDoc.get(doc) || {
              doc,
              label: DOC_LABELS[doc] || doc,
              missing: true,
              latestPath: '',
              latestTitle: '',
              updated: '',
              versions: 0,
              chars: 0,
            },
        )
      }, [isGlobal, lib])

      const experiences = useMemo(() => (lib !== null && Array.isArray(lib.experiences) ? lib.experiences : []), [lib])

      /** 下拉当前值（按库返回的 scope.path 反查工作区 id）。 */
      const scopeValue = useMemo(() => {
        if (locator !== null && locator.kind === 'global' && (lib === null || lib.scope === undefined || lib.scope === null)) return 'global'
        if (lib === null || lib.scope === undefined || lib.scope === null) return ''
        if (lib.scope.kind === 'global') return 'global'
        // Host 的 scope 字段带 workspaceId 时直接用它
        if (lib.scope.workspaceId) {
          const byId = ((projects && projects.projects) || []).find((item) => item.workspaceId === lib.scope.workspaceId)
          if (byId) return 'ws:' + byId.workspaceId
        }
        const matched = ((projects && projects.projects) || []).find((item) => samePath(item.path, lib.scope.path))
        if (matched && matched.workspaceId) return 'ws:' + matched.workspaceId
        return 'custom'
      }, [lib, locator, projects])

      const coreExists = lib !== null && Array.isArray(lib.pages) && lib.pages.some((page) => page.core === true)
      const transientInfo = transientOf(lib)
      const showTransient =
        transientInfo !== null && !(lib !== null && lib.scope !== undefined && lib.scope !== null && samePath(lib.scope.path, transientInfo.path))

      const titleOfPath = useCallback(
        (path) => {
          const clean = String(path).split('#')[0]
          const found = (lib && Array.isArray(lib.pages) ? lib.pages : []).find((page) => page.path === clean)
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

      // ── 渲染片段 ────────────────────────────────────────────────────────

      const scopeOptions = []
      scopeOptions.push(h('option', { key: 'global', value: 'global' }, T.scopeGlobal))
      for (const project of (projects && projects.projects) || []) {
        if (!project.workspaceId) continue
        const state = project.hasMemory === true ? T.hasMemory : T.noMemory
        scopeOptions.push(
          h(
            'option',
            { key: project.workspaceId, value: 'ws:' + project.workspaceId },
            `${project.title || project.path}（${state}）— ${project.path}`,
          ),
        )
      }
      if (scopeValue === 'custom') {
        scopeOptions.push(h('option', { key: 'custom', value: 'custom' }, T.customScope))
      }

      const scopeBar = h(
        'div',
        { style: styles.scopeBar },
        h('span', { style: styles.scopeLabel }, T.scopeLabel),
        h('select', { style: styles.scopeSelect, value: scopeValue, onChange: (event) => onScopeSelect(event.target.value) }, scopeOptions),
        h('div', { style: styles.spacer }),
        lib !== null && lib.scope !== undefined && lib.scope !== null
          ? h('span', { style: styles.dim }, `${T.dir}：${lib.scope.memoryRoot || lib.scope.path || ''}`)
          : null,
      )

      const transientBanner = showTransient
        ? h(
            'div',
            { style: styles.banner },
            h('span', null, T.transientBanner + (transientInfo.title || transientInfo.path || '')),
            h('button', { type: 'button', style: styles.button, onClick: jumpToTransient }, T.transientJump),
          )
        : null

      const tabBar = h(
        'div',
        { style: styles.tabs },
        [
          ['docs', T.tabDocs],
          ['core', T.tabCore],
          ['library', T.tabLibrary],
          ['config', T.tabConfig],
        ].map(([key, label]) =>
          h(
            'div',
            {
              key,
              style: { ...styles.tab, ...(tab === key ? styles.tabActive : {}) },
              onClick: () => {
                if (key === 'config') {
                  openConfig()
                  return
                }
                setTab(key)
                setSelected(null)
                setEditing(false)
                setReadOnlyOverride(false)
                // 切页签一律退出历史版本视图（只有项目文档页签会进入它）
                setHistory(null)
                if (key === 'library') setResolveCandidates(null)
              },
            },
            label,
          ),
        ),
      )

      // 项目文档页签
      const docsView = h(
        'div',
        { style: styles.body },
        h('div', { style: { fontWeight: 600, fontSize: '15px' } }, T.docsTitle),
        h('div', { style: styles.dim }, T.docsHint),
        lib === null
          ? h('div', { style: styles.dim, marginTop: '10px' }, T.loading)
          : isGlobal
            ? h('div', { style: { ...styles.none, marginTop: '10px' } }, T.docsGlobalNone)
            : h(
                'div',
                { style: styles.docList },
                docs.map((item) => h(DocRow, { key: item.doc, item, onOpen: openPage, onHistory: loadHistory })),
              ),
        isGlobal || lib === null
          ? null
          : [
              h('div', { key: 'exp-title', style: styles.sectionTitle }, T.expTitle),
              experiences.length === 0
                ? h('div', { key: 'exp-empty', style: { ...styles.none, marginTop: '6px' } }, T.expNone)
                : h(
                    'div',
                    { key: 'exp-list', style: styles.docList },
                    experiences.map((item) =>
                      h(
                        'div',
                        { key: item.path, style: styles.docRow, onClick: () => openPage(item.path) },
                        h('div', { style: styles.docTitle }, item.title || item.type || item.path),
                        h('div', { style: styles.docInfo }, `${formatTime(item.updated)} · ${item.path}`),
                      ),
                    ),
                  ),
            ],
      )

      // 历史版本视图（从项目文档页签点「历史版本」进入）
      const historyView =
        history === null
          ? null
          : h(
              'div',
              { style: styles.body },
              h(
                'div',
                { style: styles.row },
                h('button', { type: 'button', style: styles.button, onClick: () => setHistory(null) }, `← ${T.backToDocs}`),
                h('div', { style: styles.spacer }),
                h('div', { style: { fontWeight: 600 } }, `${history.label} · ${T.docHistory}`),
              ),
              h('div', { style: { ...styles.dim, marginTop: '6px' } }, T.historyHint),
              history.versions.length === 0
                ? h('div', { style: { ...styles.none, marginTop: '10px' } }, T.historyEmpty)
                : h(
                    'div',
                    { style: styles.docList },
                    history.versions.map((version) =>
                      h(VersionRow, {
                        key: version.path,
                        version,
                        onOpen: (path) => openPageAt(path, locator, { readOnly: true }),
                      }),
                    ),
                  ),
            )

      // 核心记忆页签
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
                    h('div', { style: { fontWeight: 600, fontSize: '15px' } }, (core.fields && core.fields.title) || CORE_PATH),
                    h('div', { style: styles.spacer }),
                    h('div', { style: styles.dim }, `${T.updated}：${formatTime(core.updated)}`),
                    editing
                      ? [
                          h(
                            'button',
                            {
                              key: 'cancel',
                              style: styles.button,
                              onClick: () => {
                                setEditing(false)
                                setDraft(core.content || '')
                              },
                            },
                            T.cancel,
                          ),
                          h('button', { key: 'save', style: styles.primary, onClick: save }, T.save),
                        ]
                      : h(
                          'button',
                          {
                            style: styles.button,
                            onClick: () => {
                              setDraft(core.content || '')
                              setEditing(true)
                            },
                          },
                          T.edit,
                        ),
                  ),
                  h('div', { style: styles.sectionLabel }, T.summary),
                  h('div', { style: styles.paragraph }, (core.fields && core.fields.summary) || T.noSummary),
                  h('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', margin: '14px 0' } }),
                  editing
                    ? h('textarea', { style: styles.textarea, value: draft, spellCheck: false, onChange: (event) => setDraft(event.target.value) })
                    : h('div', null, renderMarkdown(core.body)),
                ),
      )

      // 知识库页签
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
          h('span', { style: styles.railCount }, String((lib && lib.counts && lib.counts.all) || 0)),
        ),
        ((lib && lib.categories) || []).map((item) =>
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
          ? h('div', { style: styles.none }, lib !== null && Array.isArray(lib.pages) && lib.pages.length === 0 ? (isGlobal ? T.emptyAll : T.emptyProject) : T.emptyList)
          : visiblePages.map((page) => h(Card, { key: page.path, page, onOpen: openPage })),
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
        h('div', { style: styles.columns }, rail, listView),
        lib !== null && lib.injected
          ? h(
              'div',
              { style: { ...styles.dim, marginTop: '14px' } },
              `${T.injected}：${lib.injected.totalChars} ${T.chars}（core ≤ ${lib.injected.coreLimit}，索引 ≤ ${lib.injected.indexLimit}）`,
            )
          : null,
      )

      // 页面详情（各页签共用；历史版本只读、固定页无删除按钮）
      const selectedMeta = selected === null ? {} : selected.meta || {}
      const selectedReadOnly =
        selected !== null && (selectedMeta.readOnly === true || selected.readOnly === true || readOnlyOverride === true)
      const selectedFixed = selected !== null && (selectedMeta.fixed === true || isFixedPath(selected.path))

      const detailView =
        selected === null
          ? null
          : h(
              'div',
              { style: styles.body },
              h(
                'div',
                { style: styles.row },
                h(
                  'button',
                  {
                    style: styles.button,
                    onClick: () => {
                      setSelected(null)
                      setEditing(false)
                      setReadOnlyOverride(false)
                    },
                  },
                  `← ${T.back}`,
                ),
                h('div', { style: styles.spacer }),
                selectedReadOnly
                  ? h('span', { style: styles.badge }, T.readOnly)
                  : editing
                    ? [
                        h(
                          'button',
                          {
                            key: 'cancel',
                            style: styles.button,
                            onClick: () => {
                              setEditing(false)
                              setDraft(selected.content || '')
                            },
                          },
                          T.cancel,
                        ),
                        h('button', { key: 'save', style: styles.primary, onClick: save }, T.save),
                      ]
                    : h(
                        'button',
                        {
                          key: 'edit',
                          style: styles.button,
                          onClick: () => {
                            setDraft(selected.content || '')
                            setEditing(true)
                          },
                        },
                        T.edit,
                      ),
                selectedFixed ? h('span', { key: 'fixed', style: styles.badge }, T.fixedTag) : null,
                selectedMeta.versioned === true ? h('span', { key: 'versioned', style: styles.badge }, T.versionedTag) : null,
                !selectedFixed && !selectedReadOnly
                  ? h('button', { key: 'del', style: styles.danger, onClick: remove }, T.del)
                  : null,
              ),
              h(
                'div',
                { style: { marginTop: '10px', fontSize: '16px', fontWeight: 600 } },
                (selected.fields && selected.fields.title) || selected.path,
              ),
              h(
                'div',
                { style: styles.metaRow },
                h('span', null, `${T.updated}：${formatTime(selected.updated)}`),
                h('span', null, `${T.category}：${selected.categoryLabel || T.none}`),
                selectedMeta.doc
                  ? h('span', null, `${T.docKey}：${(DOC_LABELS[selectedMeta.doc] || selectedMeta.doc)}`)
                  : null,
              ),
              h('div', { style: styles.sectionLabel }, T.summary),
              h('div', { style: styles.paragraph }, (selected.fields && selected.fields.summary) || T.noSummary),
              h('div', { style: styles.sectionLabel }, T.sources),
              h(Chips, { items: selected.fields && selected.fields.sources, onOpen: openReference, labelOf, empty: T.none }),
              h('div', { style: styles.sectionLabel }, T.body),
              editing
                ? h('textarea', { style: styles.textarea, value: draft, spellCheck: false, onChange: (event) => setDraft(event.target.value) })
                : h('div', null, renderMarkdown(selected.body)),
              h('div', { style: styles.sectionLabel }, T.related),
              h(Chips, { items: selected.fields && selected.fields.related, onOpen: openReference, labelOf, empty: T.none }),
            )

      // 跨库候选（引用跳转）
      const resolveBox =
        resolveCandidates === null
          ? null
          : h(
              'div',
              { style: { ...styles.candidateBox, margin: '0 22px 12px' } },
              h(
                'div',
                { style: styles.row },
                h('span', { style: { fontWeight: 600 } }, T.resolveTitle),
                h('div', { style: styles.spacer }),
                h('button', { type: 'button', style: styles.button, onClick: () => setResolveCandidates(null) }, T.cancel),
              ),
              h(
                'div',
                { style: { marginTop: '8px' } },
                resolveCandidates.candidates.map((candidate) =>
                  h(CandidateRow, { key: `${candidate.kind}-${candidate.workspaceId || ''}-${candidate.path}`, candidate, onOpen: jumpToCandidate }),
                ),
              ),
            )

      // 配置页签（10 项：6 个预算上限 + 每目录页数 + 2 个维护节奏 + 自动补更开关）
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
                h('button', { style: styles.button, onClick: () => setTab('library') }, T.back),
              ),
              h('div', { style: { ...styles.paragraph, marginTop: '8px' } }, T.settingsHint),
              SETTING_ROWS.map(([key, labelKey]) =>
                h(
                  'div',
                  { key, style: styles.settingRow },
                  h('div', { style: styles.settingLabel }, T[labelKey]),
                  h('input', {
                    type: 'number',
                    style: styles.numberInput,
                    value: String(settingsDraft[key] === undefined || settingsDraft[key] === null ? SETTING_DEFAULTS[key] : settingsDraft[key]),
                    onChange: (event) => setSettingsDraft({ ...settingsDraft, [key]: Number(event.target.value) }),
                  }),
                  h('span', { style: styles.dim }, limitText(lib, key)),
                ),
              ),
              h(
                'label',
                { style: { ...styles.settingRow, cursor: 'pointer' } },
                h('input', {
                  type: 'checkbox',
                  checked: settingsDraft.autoFollowup !== false,
                  onChange: (event) => setSettingsDraft({ ...settingsDraft, autoFollowup: event.target.checked }),
                }),
                h('span', { style: styles.settingLabel }, T.autoFollowupLabel),
              ),
              h('div', { style: { ...styles.dim, marginTop: '10px' } }, T.defaultsNote),
              h(
                'div',
                { style: { ...styles.row, marginTop: '16px' } },
                h('button', { style: styles.primary, onClick: saveSettingsDraft }, T.save),
                h('button', { style: styles.button, onClick: resetSettingsDraft }, T.resetDefault),
              ),
            )

      let bodyView
      if (selected !== null) bodyView = detailView
      else if (tab === 'docs') bodyView = history !== null ? historyView : docsView
      else if (tab === 'core') bodyView = coreView
      else if (tab === 'config') bodyView = settingsView
      else bodyView = libraryView

      return h(
        'div',
        { style: styles.root },
        scopeBar,
        transientBanner,
        tabBar,
        resolveBox,
        bodyView,
        error === '' ? null : h('div', { style: { ...styles.error, padding: '0 22px 18px' } }, error),
        notice === '' ? null : h('div', { style: { ...styles.ok, padding: '0 22px 18px' } }, notice),
      )
    }

    // ── 会话页眉「本项目记忆」按钮 ─────────────────────────────────────────
    // 注册到 conversation.session.header.utilities（session 级 list 插槽），
    // props 里有 sessionId；点击后定位本会话主项目、写入焦点 store、打开面板。

    function HeaderAction(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const onClick = useCallback(async () => {
        if (sessionId !== '') {
          try {
            const data = await api(`/library?sessionId=${encodeURIComponent(sessionId)}`)
            publishFocus({ sessionId, scope: data.scope || null })
          } catch (error) {
            // 没有主项目（或网络失败）时退回全局库，面板照常打开
            publishFocus({ scope: { kind: 'global' } })
          }
        }
        openMemoryPanel()
      }, [sessionId])
      if (sessionId === '') return null
      return h(
        'button',
        { type: 'button', style: styles.headerButton, title: T.headerButton, onClick },
        h(
          'svg',
          { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, style: { display: 'block' } },
          h('path', {
            d: 'M5 4.5A2.5 2.5 0 0 1 7.5 2h9A2.5 2.5 0 0 1 19 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 19.5z',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinejoin: 'round',
          }),
          h('path', { d: 'M8.2 2v20', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M11.5 7.5h4.6M11.5 11h4.6M11.5 14.5h3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        ),
        h('span', { style: styles.headerButtonText }, T.headerButton),
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
      // layout 是客户端布局服务（ctx.layout.selectPanel），用来从页眉按钮打开本面板。
      inject: ['slots', 'layout'],
      apply(ctx) {
        layoutService = (ctx && ctx.layout) || null
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 22, label: T.label }, PanelIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel))
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: PANEL_ID, order: 12, label: T.headerButton },
            HeaderAction,
          ),
        )
      },
    }
  },
})
