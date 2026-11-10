# 接手说明（HANDOFF）

> 给下一位维护这个插件的 AI / 人：读完这一页就能改、能测、能发布。当前版本 **0.13.0**。

## 一句话定位

按项目独立的本地记忆：**全局库 + 主项目库 + 临时项目库**，三层（core/wiki/raw）Markdown + 7 类项目固定文档 + `memory` 工具八操作 + 每轮注入 + 引擎强制维护 + 记忆面板。不上云，没有后台定时任务。

## 目录地图

| 是什么 | 在哪 |
|---|---|
| 插件源码 | 本仓库（DSH profile 里通常以 `link:` 链接） |
| 全局库 | `%USERPROFILE%\.dsh\memory\`（core / wiki / raw + settings.json） |
| 项目库 | `<工作区文件夹>\.memory-book\`（core / wiki / raw / project / .gitignore） |
| 测试 | `test/`（四套离线测试，见 README） |
| 设计取舍 | README「设计取舍」与 `CHANGELOG.md`；深入设计可另行整理 `docs/` |
| 运行时 | Node.js ≥ 22（DSH 自带的 node 也可以） |

## 升级 / 发布 SOP

1. 改 `index.js`（Host：项目解析、三层注入、固定文档引擎、强制维护、工具、HTTP 接口）或 `client.js`（面板）。
2. 改 `package.json` 的 `version`，并在 `CHANGELOG.md` 记一条。
3. 重装（本地 bundle 是 link，必须卸载再装才会重新加载 Host 代码）：
   `plugin_manager remove_bundle(target=@local/dsh-memory-book)` → `plugin_manager install_bundle(target=<本仓库绝对路径>)`
4. 跑测试：`npm test`，必须 0 失败。
5. 验证运行时：`GET /memory-book/library` 返回 **401**（路由在、鉴权在；404 = 没加载）。
6. 客户端改动：刷新页面后肉眼确认面板。
7. 改源码一律用编辑器 / `edit` / `write` 工具或 Node 脚本按 UTF-8 读写；**不要用 PowerShell 的 `Get-Content`/`Set-Content` 写文件**（PS 5.1 按 GBK 写会把 UTF-8 中文写成乱码）。

## 验收口径（什么算改好了）

不只看“插件 applied”：

- 项目 A 写页 → 落到 A 的 `.memory-book`；项目 B 的会话看不到；
- 下一轮注入出现「全局 + 主项目 +（临时项目）+ 固定文档清单」；
- 固定文档：说明及目标超 2000 字被拒；状态/交接每次 `record` 生成新版本、旧版可 `history` 查到；固定页删不掉；没先 `read` 就写会被拒；
- 有实质变化时回合结束后真的追加了一轮补更（不是只注入提醒）；
- 面板范围切换、页眉按钮、历史版本只读；4 套测试全过；401 而不是 404。

## 已知坑

1. **注入段会残留**：`systemPrompt.section` 按 agent 注册，插件卸载不会自动 dispose。必须在 `apply` 里统一 `ctx.effect(() => () => {...})` 释放。
2. **测试桩容易骗人**：假 ctx 缺 `workspaceRegistry` / `sessions` / `workingDirectory` / `agentTeams` 会导致项目判定或角色判错；先按真实契约造桩。
3. **根级面板不知道“当前窗口”**：侧栏面板拿不到会话，所以用「范围下拉 + 会话页眉按钮（session 级插槽带 sessionId）」。
4. **先读再写是引擎强制**：`patch`/`put`/`record` 没读过会被拒；读取后文件被外部改过也会被拒（mtime 乐观锁）。被拒先重新 read，不要绕过检查。
5. **`record` 要带 `based_on`**：并发下最新版变了会拒绝；重新读最新版本再写，不要另建“最新版”。
6. **固定文档只有 Lead 能写**：Agent Teams 队友、子代理写固定文档会被拒；它们写经验页/普通页并回报路径。
7. **补更依赖 `agent.followup`**：`createUserMessage` 走动态 `import('@deepseek-ai/dsh-llm')`，解析不到时用最小 UserMessage 兜底；`followup` 不存在或抛错时降级为下一轮注入里的 `<memory_maintenance_notice>`，不是静默失败。
8. **每用户回合最多补 1 轮**：补更轮自身的工具调用不重复触发；取消/报错/子代理会话不触发。
9. **项目判定缓存**：主项目在 `agent/created` 时算一次（不随 `cd` 变化）；临时项目每轮现算。会话被移动到别的工作区后，新会话才生效。
10. **跨盘迁移**：项目库在项目所在盘；`rename` 跨盘会失败，迁移脚本需「复制 + 删除源」兜底。
11. **测试隔离**：4 套测试必须同时覆盖 `USERPROFILE`、`DSH_HOME` 和临时项目目录，否则会碰真实记忆库或互相污染。
12. **`.memory-book` 默认不进 git**：首次建库自动写 `.gitignore`（内容 `*`）；想让记忆进仓库，删掉那个文件。

## 版本历史

| 版本 | 变化 |
|---|---|
| 0.1–0.2 | 三层 + 工具五操作 + 注入 + 灵犀式面板 |
| 0.3–0.9 | 试做证据层、队列、命令、distill action、按钮（均已移除） |
| 0.10 | 收敛回三层 + 五操作 + 两页签面板；测试 69 项 |
| 0.11–0.12.2 | core 启用、索引带路径、search 分词、参数名对齐文件工具、拒绝未知参数；测试 88 项 |
| **0.13.0** | **按项目独立**：三层注入；项目库在 `<工作区>\.memory-book`；7 类固定文档（2000 字上限、版本化、禁删、先读再写）；引擎强制维护（实质变化 → followup 补更轮，可关）；工具加 scope/put/record/history；面板四页签 + 范围下拉 + 页眉按钮；多智能体写保护；测试 279 项 |

## 明确不做

- 压缩联动（不在插件里加阈值提示或按钮）。
- 空闲/后台定时动作（没有定时器；补更由回合事件触发）。
- 把会话证据存成单独一层（需要时用 `session_event_search/read` 直接读日志）。
- 全局库放固定文档（`project/` 只属于项目库，Host 已拦截）。
