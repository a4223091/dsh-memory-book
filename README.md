# memory-book（DSH 本地记忆插件）v0.13.0

按项目独立的本地记忆：**全局库 + 主项目库 + 临时项目库**，全部是磁盘上的 Markdown，不上云。

| 库 | 位置 | 何时注入 | 放什么 |
|---|---|---|---|
| 全局库 | `%USERPROFILE%\.dsh\memory\` | 任何会话都注入 | 用户画像、通用经验、跨项目规则 |
| 主项目库 | `<会话所属工作区文件夹>\.memory-book\` | 任何会话都注入 | 本项目铁律、知识、固定文档 |
| 临时项目库 | `<当前工作目录所属项目>\.memory-book\` | 仅当 `cd` 到别的项目时追加 | 临时项目的 core/索引/文档清单 |

- 插件源码：`C:\Users\Administrator\AppData\Local\dsh\bundles\memory-book`（本地 bundle，profile 里是 link）
- 技能说明：`~/.dsh/skills/memory-book/SKILL.md`（模型侧用法）
- 设计稿：`C:\Users\Administrator\Documents\deepseek-harness\default-workspace\memory-plugin\设计稿-项目独立.md`

## 项目库布局

```
<项目文件夹>\
  .memory-book\
    .gitignore                      # 内容 `*`：默认整个记忆库不进 git；想提交就删掉它
    core\核心记忆.md                # 每轮全文注入
    wiki\{projects,concepts,lessons,profile,entities}\*.md
    raw\*.md                        # 只登记来源定位符
    project\
      说明及目标.md                 # 单文件，正文 ≤2000 字
      经验\<类型>.md                # 同类型一个页面，全量覆盖，不保留旧版
      策划\<YYYYMMDD-HHmm>.md       # 每次 record 新增一版，旧版保留
      计划\<...>.md
      状态\<...>.md
      交接\<...>.md
      决策历史\<...>.md
```

全局库没有 `project/` 固定文档（固定文档只属于项目库）。

## 能力

| 能力 | 入口 | 说明 |
|---|---|---|
| 读写页面 | `memory` 工具 | 8 个动作 + `scope`（current/main/global），详见下表 |
| 每轮注入 | `systemPrompt.section`（order 700） | 主项目 core+索引+固定文档清单；全局 core+索引；临时项目 core+索引 |
| 固定文档 | 工具 `put` / `record` / `history` | 2000 字上限、版本化、禁止删除、历史只读 |
| 引擎强制维护 | 回合事件 + `agent.followup` | 检测到实质变化后自动追加一轮补更；可配置关闭 |
| 浏览编辑 | 左栏「记忆」面板 | 项目文档 / 核心记忆 / 知识库 / 配置；范围下拉切库 |
| 会话内入口 | 会话页眉「本项目记忆」按钮 | 定位当前会话主项目并打开面板 |
| 沉淀 | 用户说一句「沉淀/整理记忆」 | 模型回取会话片段 → 提炼 → 直接写；没有队列、没有中间文件 |
| 配置 | 面板「配置」页 | 10 项：注入预算 7 项 + 维护节奏 2 项 + 自动补更开关，落 `settings.json` |

## memory 工具

| action | 必填 | 说明 |
|---|---|---|
| read | path | 读整页，返回 frontmatter、正文、updated |
| add | path, content | 新建普通页，不覆盖；content 要含 frontmatter（title+summary） |
| patch | path, old_string, new_string | 片段替换，唯一匹配；固定页只能改最新版 |
| remove | path | 删除普通页；固定页拒绝 |
| search | query | 主题词检索，多词要求同时命中，全不命中退回部分命中 |
| put | path, content | 全量覆盖固定页：`project/说明及目标` 或 `project/经验/<类型>`；引擎生成 frontmatter |
| record | doc, content, based_on | 给版本化文档新增一版；`based_on`=上一版本路径（首个版本传空串） |
| history | doc | 列版本化文档全部历史版本（新→旧） |

- `scope`：`current`（默认，当前项目：有临时项目就是临时项目，否则主项目）/ `main`（主项目，不受 cd 影响）/ `global`（全局库）。
- **先读再写（引擎强制）**：`patch` / `put` / `record` 前必须在本会话 `read` 过目标页；读取后文件又被改过会被拒绝（乐观锁）。
- **并发保护**：`record` 的 `based_on` 不是最新版会被拒绝；写文件用临时文件 + rename 原子写。
- **固定文档只有 Lead 能写**：Agent Teams 队友、子代理只能写项目经验页与普通页，固定文档交给 Lead。
- 说明及目标正文超过 2000 字会被拒绝并回报字数。

## 注入预算（面板可调）

| 项 | 默认 | 说明 |
|---|---|---|
| coreChars | 1200 | 全局 core |
| mainCoreChars | 3000 | 主项目 core |
| transientCoreChars | 800 | 临时项目 core（0 = 只注入索引） |
| indexChars | 1000 | 全局索引 |
| mainIndexChars | 2500 | 主项目索引 |
| transientIndexChars | 1200 | 临时项目索引 |
| pagesPerDir | 8 | 每个 wiki 子目录最多列几页 |
| fallbackRounds | 5 | 连续多少用户回合无实质变化后由 AI 询问是否更新 |
| handoverChanges | 5 | 累计多少次实质变化后强制更新交接 |
| autoFollowup | 开 | 引擎自动追加补更轮 |

## 引擎强制维护

回合结束（`agent/status` 进入 idle）时检查，命中任意一条就用 `agent.followup(...)` **强制追加一轮补更**：

- 工作区有文件改动 / `write`·`edit`·`patch` 成功 → 状态（若用户表达了决策 → 决策历史）
- `todo_write` 或 `create_goal`/`update_goal` → 计划 + 状态
- 工具连续失败 ≥2 次 → 项目经验
- 固定文档缺失 → 补建
- 累计 5 次实质变化 → 交接
- 本轮 record 了计划/策划/交接但没 record 状态 → 状态
- 连续 5 个用户回合无实质变化 → 只让 AI 询问用户，不自动写

防死循环：每个用户回合最多 1 次；补更轮自身不重复触发；取消/报错/子代理会话不触发；`agent.followup` 不可用时降级为下一轮注入里的强制提醒。

## 多智能体协作

- 固定文档只有 Lead 写；队友写项目经验页与普通页；子代理不写固定文档。
- 写保护：先读再写 + mtime 乐观锁 + `based_on` 比较并交换 + 原子写 + 进程内写锁。
- 版本页 frontmatter 记录 `by`（哪个智能体）与 `session`（哪个会话），便于排查。

## 离线测试

四套测试都自带临时库（覆盖 `USERPROFILE` / `DSH_HOME` 与临时项目目录），不会碰真实记忆。

```powershell
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$plugin = "C:\Users\Administrator\AppData\Local\dsh\bundles\memory-book"
$tests  = "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\memory-plugin"

& $node "$tests\test-host.mjs" $plugin      # 宿主半边：项目解析/固定文档/注入/工具/强制维护
& $node "$tests\test-routes.mjs" $plugin    # 面板 8 个接口端到端
& $node "$tests\test-client.mjs" $plugin    # 客户端模块契约与 slot 注册
& $node "$tests\test-render.mjs" $plugin    # 面板渲染冒烟
```

## 安装 / 升级

```text
plugin_manager install_bundle  target=<插件目录绝对路径>
```

本地 bundle 是 profile 里的 `link:` 依赖。**升级后必须 remove_bundle → install_bundle**，Host 侧代码才会重新加载；客户端半边要刷新页面（或重启 App）才挂上。

## 从 v0.12（单一全局库）迁移

- 现有 `~/.dsh/memory` 原样保留为全局库；
- 把各项目页搬到对应工作区的 `.memory-book`：脚本 `memory-plugin/migrate-project-memory.mjs`（默认预演，`--apply` 才执行，执行前自动备份）。

## 已移除/明确不做

会话证据层（`rollout/`）、待沉淀队列、面板「会话证据」页签、`/memory` 命令、`distill` action、`recall`——v0.7–v0.9 试过，判定为过度设计，保持移除。
