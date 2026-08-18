# dsh-session-move

[![GitHub stars](https://img.shields.io/github/stars/reinocheong/dsh-session-move?style=flat-square)](https://github.com/reinocheong/dsh-session-move/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

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
# from GitHub (recommended until published to npm)
dsh plugin --profile web add https://github.com/reinocheong/dsh-session-move/archive/refs/tags/v0.1.1.tar.gz
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

Open a session's `...` menu → **AI Rename** — the LLM reads a representative sample across the whole conversation (evenly sampled to fit the token budget), fixes any typos, and writes a concise title in the conversation's language.

By default it uses the session's own model route. To pin a different provider/model, configure the plugin row:

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

### Reliability (v0.1.2)

The move keeps **every** place a session's location is recorded in sync — not just the header and the log directory:

- **Projection cache** — the session's `identity.cwd` in the projection cache (`session_projcache`) follows the move, so the web session list resolves the correct storage slug immediately (no `ENOENT` on cold sessions and no "Ungrouped" residue after a move).
- **Boot reconciliation** — on startup the plugin audits every stored projection-cache record against its on-disk header and repairs stale `identity.cwd` entries left behind by earlier half-applied moves or manual reorgs, so the list shows real session titles from the first render instead of the folder placeholder.
- **Live sessions** — a session that is loaded in memory when moved has a frozen header snapshot; the plugin detaches it from the live agents store before re-attaching it to the target workspace, so the attach validation never sees a stale `cwd` (this was the cause of moves silently landing in "Ungrouped" while the physical move succeeded).
- **Running sessions (fixed in v0.1.2)** — when the moved session is actively executing a task, the plugin now also **releases the agent** from the agents registry (emits `agent/disposed`), not just cancels its current turn. This is the load-bearing part: dsh's agent factory waits for BOTH the session and the agent to leave their registries (`waitForDrainingConfiguredIdentity` listens for `session/disposed` and `agent/disposed`) before rebuilding a live session; cancelling the turn alone leaves the agent registered, so the wait never resolves and the moved session can never be re-opened or resumed (symptom: you can type and hear the notification sound, but the agent never replies). The client also **reloads the page** after a successful move — the host flags the resident conversation instance as `removed` ("session unavailable" input), and a full reload is the most reliable recovery: the client restores the persisted selection and re-opens the moved session cold from its new location with its history intact.

Each fix is fail-soft: if a repair can't run, the plugin logs a warning and leaves the state untouched rather than corrupting it.

---

## Performance & footprint

The plugin is designed to be lightweight:

- **Zero runtime dependencies** — it only uses Node built-ins plus packages dsh already ships (`dsh-tools`, `dsh-llm`, `dsh-session-title`, `dsh-session-title-llm`). Nothing new is installed.
- **No background work** — no timers, polling, or resident connections. Move/delete/rename are purely request-driven: work happens while the request runs, then the plugin goes idle.
- **Tiny footprint** — the whole plugin is ~85 KB of source; its resident memory is negligible against a running dsh process.
- **Fast operations** — the stateless endpoints answer in ~1 ms (e.g. `/__sessionmove/info`); the only potentially slow step is AI rename, which calls the LLM once on demand (a few seconds, timeout-configurable) and never runs otherwise.
- **Cheap client side** — one DOM observer plus three dialogs that render only when opened; nothing runs in the browser while idle.

---

## Requirements

- Node.js `^22.19.0 || >=24.0.0` (same as dsh)
- dsh `0.1.0-rc.6` or newer
- AI rename additionally needs the official `@deepseek-ai/dsh-session-title` / `@deepseek-ai/dsh-session-title-llm` packages (bundled with dsh)

## License

MIT
