# dsh-session-move

**Manage DeepSeek Harness sessions from the Web UI — move, delete, and AI-rename, with drag & drop.**

A dual-face (host + browser) plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

| Feature | Official dsh | With this plugin |
|---|---|---|
| Move a session to another folder (workspace) | ❌ sessions are locked to the folder they were created in | ✅ drag & drop **or** menu → picker dialog |
| Permanently delete a session | ❌ archive only (hidden, never really gone) | ✅ menu → risk-consent dialog → full removal |
| AI-rename a session | ⚠️ auto-titles exist, but only from the *first* message | ✅ one-click: LLM summarizes the **whole conversation** |

Each feature also ships as an **agent tool** (`workbench_session_move`, `workbench_session_delete`, `workbench_session_rename_ai`).

Full bilingual docs: [README.zh.md](README.zh.md) · English [README.md](README.md)

## Install

```sh
dsh plugin --profile web add dsh-session-move
# then restart the profile, e.g.
sudo systemctl restart dsh
```

## License

MIT
