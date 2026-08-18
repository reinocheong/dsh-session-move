# dsh-session-move

[![GitHub stars](https://img.shields.io/github/stars/reinocheong/dsh-session-move?style=flat-square)](https://github.com/reinocheong/dsh-session-move/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**在 DeepSeek Harness 网页界面里管理会话 —— 移动、删除、AI 重命名，支持拖拽。**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的双端插件（宿主 + 浏览器）。补齐官方界面缺失的能力：

| 功能 | 官方 dsh | 安装本插件后 |
|---|---|---|
| 把会话移动到别的文件夹（workspace） | ❌ 会话被锁定在创建时的文件夹里 | ✅ 拖拽 **或** 菜单 → 选择弹窗 |
| 彻底删除会话 | ❌ 只有归档（隐藏，记录仍在磁盘） | ✅ 菜单 → 风险确认弹窗 → 完整删除 |
| AI 重命名会话 | ⚠️ 有自动标题，但只根据**第一条**消息 | ✅ 一键：LLM 总结**整个对话**生成标题 |

每个功能同时提供 **agent 工具**（`workbench_session_move`、`workbench_session_delete`、`workbench_session_rename_ai`），让 agent 也能帮你整理会话。

---

## 安装

```sh
# 从 GitHub 安装（发布到 npm 前的推荐方式）
dsh plugin --profile web add https://github.com/reinocheong/dsh-session-move/archive/refs/tags/v0.1.1.tar.gz
```

重启 profile 使插件生效：

```sh
# systemd 托管的安装
sudo systemctl restart dsh
```

> **手动安装说明**（把包复制到 `~/.dsh/profiles/node_modules/` 自己装时）：必须在 profile 的 `cordis.patch.yml` 里手动注册：
> ```yaml
> - insert:
>     - id: session-move
>       name: dsh-session-move
> ```
> `dsh plugin add` 会自动完成这一步。

---

## 使用方法

### 🗂 把会话移动到别的文件夹

**拖拽** — 按住侧边栏里任意会话行，拖到另一个文件夹标题上。悬停时目标文件夹会高亮，松手即移动。

**菜单** — 打开会话的 `...` 菜单 → **移动到文件夹…** → 选择目标文件夹 → 确认。

移动会连带改变会话的工作目录：改写会话 header 里的 `cwd`、把持久化日志移到目标文件夹的存储目录、更新 workspace 记账 —— 历史记录随会话一起走，移动后会话继续在新目录下工作。

### 🗑 删除会话

打开会话的 `...` 菜单 → **删除会话** → 勾选「我已了解后果」→ 确认。

删除是完整且永久的：先停止运行中的 agent，再删除日志目录、投影缓存行和 workspace 记账。不会残留成「未分组」的孤儿记录。

### ✨ AI 重命名

打开会话的 `...` 菜单 → **AI 重命名** — LLM 阅读整个对话的**均匀采样**（控制 token 预算内覆盖全时间线），自动纠正错别字，用对话本身的语言生成简洁标题。

默认使用会话自身的模型路由。要固定别的 provider/model，配置插件行：

```yaml
- id: session-move
  name: dsh-session-move
  config:
    renameAi:
      provider: deepseek-official
      model: deepseek-v4-flash
      targetWords: 6
      targetCjkCharacters: 14
      maxInputBytes: 8192
      maxOutputTokens: 96
      timeoutMs: 60000
```

---

## Agent 工具

| 工具 | 说明 |
|---|---|
| `workbench_session_move` | 把会话移动到另一个 workspace（按 session id + workspace id）。 |
| `workbench_session_delete` | 永久删除一个会话。 |
| `workbench_session_rename_ai` | AI 重命名一个会话。 |

---

## HTTP 端点

这些端点支撑 UI，也可直接调用：

| 端点 | 方法 | 请求体 | 返回 |
|---|---|---|---|
| `/__sessionmove/info` | GET | — | 所有 workspace + 会话当前所在 workspace |
| `/__sessionmove/move` | POST | `{ sessionId, workspaceId }` | 移动结果（旧/新 cwd、workspace id） |
| `/__sessionmove/delete` | POST | `{ sessionId }` | 删除了什么 |
| `/__sessionmove/rename-ai` | POST | `{ sessionId }` | 新标题 |

---

## 实现原理（简述）

dsh 的「文件夹」（workspace）**不是**随意归类的容器。会话属于哪个文件夹，由会话的工作目录（`cwd`）决定——cwd 冻结在会话日志（zstd 压缩）的 header 行里。因此移动会话意味着：

1. 停止/刷新运行中的 agent；
2. 把 header 行的 `cwd` 改写为目标文件夹路径（解压第一个 zstd 帧 → 改 JSON → 重压 → 尾部帧逐字节保留）；
3. 把日志目录物理移动到目标文件夹的存储 slug；
4. 通过 workspace registry 从旧 workspace 摘除、挂到新 workspace（同时刷新内存索引，UI 即时更新，无需重启）。

所有存储变更都经由 dsh 自身的 `storageDomain`，内存与磁盘保持一致，不会留下半挂账的记录。

### 可靠性（v0.1.2）

移动会把会话位置的**每一处**记录都同步到位——不止 header 和日志目录：

- **投影缓存**——会话在投影缓存（`session_projcache`）里的 `identity.cwd` 会跟着移动更新，web 会话列表立刻解析到正确的存储 slug（冷会话不再 `ENOENT`，移动后不再留下「未分组」残留）。
- **启动对账**——插件启动时会审计每一条投影缓存记录与磁盘 header 是否一致，修复历史上半途移动或手动整理留下的陈旧 `identity.cwd`，让列表首屏就显示真实会话标题，而不是文件夹占位名。
- **活会话**——移动时如果会话正加载在内存中，其 header 是冻结的快照；插件会先从 live agents store 摘除再挂到目标工作区，挂载校验不会读到过期的 `cwd`（这正是「物理移动成功却掉进未分组」的根因）。
- **运行中的会话（v0.1.2 修复）**——移动正在执行任务的会话时，除了取消当前回合，还会从 agents 注册表**释放 agent**（发出 `agent/disposed`）。这是关键：dsh 的 agent 工厂在重建会话前会等待「session 与 agent 双双离开注册表」（`waitForDrainingConfiguredIdentity` 监听 `session/disposed` 和 `agent/disposed`）；只取消回合而不释放 agent，等待会永远挂起，移动后的会话无法重新打开/恢复（表现为「能打字、只有提示音、没有回复」）。客户端在移动成功后也会**整页刷新**——移动会把当前会话实例标记为 `removed`（输入框变成「会话不可用」），刷新是最可靠的恢复方式：页面重载后从持久化恢复选中项，被移动的会话从新位置冷加载重建，历史完整保留。

每个修复都是 fail-soft：修不了就记一条 warning、保持原状，绝不损坏数据。

---

## 性能与资源占用

插件刻意保持轻量：

- **零运行时依赖** — 只用 Node 内置模块 + dsh 自带的包（`dsh-tools`、`dsh-llm`、`dsh-session-title`、`dsh-session-title-llm`），不新增任何安装。
- **无后台任务** — 没有定时器、轮询或常驻连接。移动/删除/重命名都是纯请求驱动：请求处理期间才干活，其余时间完全空闲。
- **体积小** — 整个插件源码约 85KB，驻留内存相对于运行中的 dsh 进程可忽略。
- **操作快** — 无状态端点响应约 1ms（如 `/__sessionmove/info`）；唯一可能稍慢的是 AI 重命名，它按需调用一次 LLM（几秒钟，超时可配置），平时绝不运行。
- **客户端开销小** — 一个 DOM 观察器 + 三个弹窗组件（仅在打开时渲染），空闲时浏览器端零运行成本。

---

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`（与 dsh 一致）
- dsh `0.1.0-rc.6` 或更新版本
- AI 重命名需要官方 `@deepseek-ai/dsh-session-title` / `@deepseek-ai/dsh-session-title-llm` 包（dsh 自带）

## 许可证

MIT
