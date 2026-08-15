# dsh-session-move

**Manage DeepSeek Harness sessions from the Web UI — move, delete, and AI-rename, with drag & drop.**

A dual-face (host + browser) plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It fills the gaps the official UI leaves open:

| Feature | Official dsh | With this plugin |
|---|---|---|
| Move a session to another folder (workspace) | ❌ sessions are locked to the folder they were created in | ✅ drag & drop **or** menu → picker dialog |
| Permanently delete a session | ❌ archive only (hidden, never really gone) | ✅ menu → risk-consent dialog → full removal |
| AI-rename a session | ⚠️ auto-titles exist, but only from the *first* message | ✅ one-click: LLM summarizes the **whole conversation** |

Each feature also ships as an **agent tool** (`workbench_session_move`, `workbench_session_delete`, `workbench_session_rename_ai`), so your agents can organize sessions too.

---

## Install

```sh
dsh plugin --profile web add dsh-session-move
```

Or, from a local checkout / GitHub tarball:

```sh
dsh plugin --profile web add https://github.com/reinocheong/dsh-session-move/archive/refs/heads/main.tar.gz
```

Restart the profile for the plugin to load:

```sh
# systemd-managed installs
sudo systemctl restart dsh
```

> **Note for manual installs** (copying the package into `~/.dsh/profiles/node_modules/` yourself): you must also register it in the profile's `cordis.patch.yml`:
> ```yaml
> - insert:
>     - id: session-move
>       name: dsh-session-move
> ```
> `dsh plugin add` does this automatically.

---

## Usage

### 🗂 Move a session to another folder

**Drag & drop** — grab any session row in the sidebar and drop it onto the title of another folder. The target folder highlights while you hover; release to move.

**Menu** — open a session's `...` menu → **Move to folder…** → pick the target folder → confirm.

Moving a session relocates its working directory: the session header's `cwd` is rewritten, the persisted log is moved to the target folder's storage slug, and the workspace accounting is updated — history travels with it, and the session keeps working in the new directory afterwards.

### 🗑 Delete a session

Open a session's `...` menu → **Delete session** → tick *"I understand the consequences"* → confirm.

Deletion is complete and permanent: running agents are stopped first, then the log directory, projection-cache row, and workspace accounting are removed. Nothing lingers in "Ungrouped".

### ✨ AI rename

Open a session's `...` menu → **AI Rename** — the LLM reads the conversation (opening intent + recent tail, bounded to the token budget) and writes a concise title in the conversation's language.

By default it uses the session's own model route. To pin a different provider/model, configure the plugin row:

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

## Agent tools

| Tool | Description |
|---|---|
| `workbench_session_move` | Move a session to another workspace (by session id + workspace id). |
| `workbench_session_delete` | Permanently delete a session. |
| `workbench_session_rename_ai` | AI-rename a session. |

---

## HTTP endpoints

These power the UI; they are also usable directly:

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/__sessionmove/info` | GET | — | all workspaces + the session's current workspace |
| `/__sessionmove/move` | POST | `{ sessionId, workspaceId }` | move result (old/new cwd, workspace ids) |
| `/__sessionmove/delete` | POST | `{ sessionId }` | what was removed |
| `/__sessionmove/rename-ai` | POST | `{ sessionId }` | the new title |

---

## How it works (the short version)

dsh folders ("workspaces") are **not** free-form containers. A session belongs to the workspace whose path equals the session's working directory (`cwd`), which is frozen in the header line of the session's zstd-compressed log. Moving a session therefore means:

1. stop/flush any live agent,
2. rewrite the header line's `cwd` to the target folder's path (decompress the first zstd frame, patch the JSON, recompress, keep the trailing frames byte-for-byte),
3. physically move the log directory to the target folder's storage slug,
4. detach from the old workspace and attach to the new one through the workspace registry (which also refreshes the in-memory index, so the UI updates instantly — no restart needed).

All storage mutation goes through dsh's own `storageDomain`, keeping memory and disk consistent; nothing is left half-accounted.

---

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (same as dsh)
- dsh `0.1.0-rc.6` or newer
- AI rename additionally needs the official `@deepseek-ai/dsh-session-title` / `@deepseek-ai/dsh-session-title-llm` packages (bundled with dsh)

## License

MIT
