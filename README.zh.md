# dsh-session-move

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
dsh plugin --profile web add dsh-session-move
```

或从本地目录 / GitHub tarball 安装：

```sh
dsh plugin --profile web add https://github.com/reinocheong/dsh-session-move/archive/refs/heads/main.tar.gz
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

打开会话的 `...` 菜单 → **AI 重命名** — LLM 阅读整个对话（开头意图 + 最近的对话，控制在 token 预算内），用对话本身的语言生成简洁标题。

默认使用会话自身的模型路由。要固定别的 provider/model，配置插件行：

```yaml
- id: session-move
  name: dsh-session-move
  config:
    renameAi:
      provider: deepseek-official
      model: deepseek-v4-flash
      targetWords: 5
      targetCjkCharacters: 10
      maxInputBytes: 4096
      maxOutputTokens: 64
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

---

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`（与 dsh 一致）
- dsh `0.1.0-rc.6` 或更新版本
- AI 重命名需要官方 `@deepseek-ai/dsh-session-title` / `@deepseek-ai/dsh-session-title-llm` 包（dsh 自带）

## 许可证

MIT
