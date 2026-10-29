# 接手说明（HANDOFF）

> 给下一位维护这个插件的 AI/人：读完这一页就能改、能测、能升级。当前版本 **0.12.2**。

## 一句话定位

把灵犀平台的记忆结构复刻到 DSH 本地：三层（core/wiki/raw）Markdown 文件 + `memory` 工具五操作 + 每轮注入 + 记忆面板。全局库，不上云，没有后台任务。

## 目录地图（都是绝对路径，本机专用）

| 是什么 | 在哪 |
|---|---|
| 插件源码 | `C:\Users\Administrator\AppData\Local\dsh\bundles\memory-book`（profile 里是 `link:`，别再复制一份） |
| 记忆库 | `%USERPROFILE%\.dsh\memory\`（core / wiki / raw + settings.json） |
| 技能说明 | `~/.dsh/skills/memory-book/SKILL.md`（模型侧用法：什么时候写、怎么写、怎么沉淀） |
| 设计稿 | `C:\Users\Administrator\Documents\deepseek-harness\default-workspace\memory-plugin\设计稿.md`（边界、格式、注入、已移除功能与原因） |
| 测试 | 同目录 `test-host.mjs` / `test-client.mjs` / `test-routes.mjs` / `test-render.mjs` |
| 验证用的 node | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |

## 升级 SOP（改完必须走完）

1. 改 `index.js`（Host：工具、注入、HTTP 接口）或 `client.js`（面板）。
2. 改 `package.json` 的 `version`。
3. 重装（本地 bundle 是 link，必须卸载再装才会重新加载 Host 代码）：
   `plugin_manager remove_bundle(target=@local/dsh-memory-book)` → `plugin_manager install_bundle(target=C:\Users\Administrator\AppData\Local\dsh\bundles\memory-book)`
4. 跑 4 套测试（命令见插件 `README.md`），**必须 0 失败**。
5. 验证运行时：`GET /memory-book/library` 返回 **401**（路由在、鉴权在；返回 404 说明没加载）。
6. 客户端改动：让用户刷新页面（或重启 App）后肉眼确认面板。

## 验收口径（什么算改好了）

不只看"插件 applied"：要在**下一轮注入**里看到变化、`memory` 工具实际读写成功、401 而不是 404、面板刷新后外观正确、4 套测试全过。

## 已知坑（每条都有对应记忆页）

1. **注入段会残留**：`systemPrompt.section` 是按 agent 注册的，插件卸载不会自动 dispose。必须在 `apply` 里 `ctx.effect(() => () => {...})` 统一释放。→ `wiki/lessons/插件升级-注入段要释放`
2. **测试桩容易骗人**：假 ctx 缺 `agents` 会导致注入段永不注册；假 page 缺 `ok` 字段会导致详情打不开。写测试时先按真实契约造桩。
3. **全局面板不知道"当前窗口"**：面板是 app 级的，按窗口的动作不能放面板按钮上——这类能力只能由会话内调用方（agent id）提供。
4. **别提前造层**：v0.7–v0.9 试过"会话证据层 + 待沉淀队列 + 生成骨架按钮"，实测证明是过度设计，已全部移除。→ `wiki/lessons/先最小可用-别提前造证据层`
5. **`patch` 匹配失败先重读**：通常不是格式问题，而是页面被改过。禁止删重建。→ `wiki/lessons/记忆写入-先读再改`
6. **测试隔离要设 `DSH_HOME`**：记忆库根目录优先取 `DSH_HOME`，只改 `USERPROFILE` 会让测试读写真实记忆库（表现为 read/add 全失败但看不出原因）。两个测试文件已同时设 `DSH_HOME=<临时目录>/.dsh`。
7. **改源码不要用 PowerShell 文本管道**：Windows PowerShell 5.1 的 `Get-Content`/`Set-Content` 默认按系统 ANSI（本机 GBK）读写，`Get-Content -Raw` + `Set-Content` 会把整个文件的中文写成乱码（0.12.1 → 0.12.2 之间真发生过，靠人工修补表才恢复）。改 JS 一律用 `edit` / `write` 工具，或 Node 脚本按 UTF-8 读写。

## 版本历史

| 版本 | 变化 |
|---|---|
| 0.1–0.2 | 三层 + 工具五操作 + 注入 + 灵犀式面板 |
| 0.3–0.9 | 试做证据层、队列、命令、distill action、按钮（均已移除） |
| 0.10 | 收敛回三层 + 五操作 + 两页签面板；删 rollout/.state.json/命令族；测试 69 项 |
| 0.11 | core 层真正启用（工作区路由等短规则）；索引带路径、search 分词 |
| 0.11.1 | 索引每行改成 `页面路径 — 标题：摘要`，模型可直接 read；`search` 改分词 + 全词命中 + 相关度排序，全不命中退回部分命中；修测试隔离（`DSH_HOME`）；测试 85 项（host 34 / client 10 / routes 22 / render 19） |
| 0.11.2 | 止血：参数名写成邻居工具的写法时（`file_path` / `content` / `old_string` / `new_string`），错误里直接点名正确参数名；测试 88 项 |
| 0.12.0 | **破坏性改名**：`add` 的 `new_content` → `content`（对齐 `write`），`patch` 的 `old_content`/`new_content` → `old_string`/`new_string`（对齐 `edit`）；测试 88 项 |
| 0.12.1 | 报错提示只描述当前版本：去掉 0.12 之前旧名的专门提示，只保留仍会撞车的 `file_path` → `path`；测试 87 项 |
| 0.12.2 | 改成业界做法：**拒绝未知参数并列出全部合法参数**（参数表只有一份，schema 与校验共用）；删掉 `file_path` 特例；测试 88 项 |

## 明确不做

- 压缩联动（不在插件里加阈值提示或按钮；压缩时机由用户判断，压缩由 DSH compaction 负责）。
- 空闲/后台自动动作（没有定时器、没有队列）。
- 把会话证据存成单独一层（需要时用 `session_event_search/read` 直接读日志）。
