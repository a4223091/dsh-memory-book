# memory-book（DSH 本地记忆插件）

把灵犀那套记忆结构搬到本地：`core/核心记忆` + `wiki/` + `raw/`，全部是磁盘上的 Markdown，不上云。

- 记忆库：`%USERPROFILE%\.dsh\memory\`
- 插件源码：`C:\Users\Administrator\AppData\Local\dsh\bundles\memory-book`（本地 bundle，profile 里是 link）
- 技能说明：`~/.dsh/skills/memory-book/SKILL.md`

## 能力

| 能力 | 入口 | 说明 |
|---|---|---|
| 读写页面 | `memory` 工具 | read / add / patch / remove / search；路径是页面路径 |
| 每轮注入 | `systemPrompt.section`（order 700） | core 正文 + wiki/raw 目录索引；空库零注入；注入不含时间戳 |
| 浏览编辑 | 左栏「记忆」面板 | 两页签：核心记忆 / 知识库（分类 + 卡片 + 详情，Markdown 渲染、来源与关联可点） |
| 沉淀 | 用户说一句话 | 模型用 session_event_search/read 回取关键片段，直接提炼进 wiki/core；没有中间证据文件、没有命令、没有队列 |
| 配置 | 面板右上「配置」 | 三个注入预算可改、可一键恢复默认；落在 `settings.json`（删除即回默认） |

## 数据格式

```markdown
---
title: 页面标题
summary: 一句话说明这页回答什么问题（会进每轮索引）
sources: [raw/页名#条目标题]   # 可选
related: [wiki/projects/某页]  # 可选
---

正文（Markdown，标题从 ## 开始）
```

- `raw/` 只放溯源凭证：正文用 `## 条目` 切分，每条 `type: local|cloud|web` + `path` / `file_id`+`url` / `url` + `added` + `summary`。
- 目录索引每行是 `页面路径 — 标题：摘要`（标题与文件名相同时省略标题）；模型看到路径就能直接 `memory read`，不必先 search。
- `search` 按主题词匹配：多个词用空格分开时要求**同时命中**（标题命中权重最高），全部词都不命中才退回「命中部分词」并注明。
- `settings.json` 可调：`coreChars`（默认 4000）、`indexChars`（2500）、`pagesPerDir`（8）。面板「配置」也能改，改完下一轮生效；「恢复默认」会删掉这个文件。

## 离线测试

四套测试都自带临时库（会覆盖 `USERPROFILE` 与 `DSH_HOME`），不会碰真实记忆。

```powershell
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$plugin = "C:\Users\Administrator\AppData\Local\dsh\bundles\memory-book"
$tests  = "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\memory-plugin"

# Host 半边（工具 schema / 注入 / CRUD / 错误路径）
& $node "$tests\test-host.mjs" $plugin

# 客户端模块契约与 slot 注册
& $node "$tests\test-client.mjs" $plugin

# 面板 5 个 HTTP 接口端到端（自带临时库）
& $node "$tests\test-routes.mjs" $plugin

# 面板渲染冒烟（最小 React 运行时，不启动浏览器）
& $node "$tests\test-render.mjs" $plugin
```

## 安装 / 升级

```text
plugin_manager install_bundle  target=<插件目录绝对路径>
```

本地 bundle 是 profile 里的 `link:` 依赖。**升级后必须 remove_bundle → install_bundle**，Host 侧代码才会重新加载；客户端半边要刷新页面（或重启 App）才挂上。

## 已移除的东西

会话证据层（`rollout/`）、待沉淀队列（`.state.json` / `<memory_pending>`）、面板「会话证据」页签、`/memory` 命令、`memory action=distill`、`recall`——它们在 v0.7–v0.9 存在过，实测后判定为过度设计（价值低于复杂度）。会话证据的底子仍然是持久化的会话日志，需要时用 `session_event_*` 直接读。
