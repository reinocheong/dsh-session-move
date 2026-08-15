// dsh-session-move: CLIENT half.
//
// Adds session-management actions to the sidebar session-row "..." menu:
//   - Move to folder… (dialog with workspace picker; cross-folder drag & drop)
//   - AI Rename (auto-generates a title from the conversation)
//   - Delete session (risk-consent dialog)
//
// The sidebar session-row "..." menu (rename/fork/archive) is hard-coded in
// ui-workspace with no extension slot, so the items are injected at the DOM
// level (same technique as the delete-session plugin). Dialogs are root-scoped
// shell.overlay occupants listening for window events; menu items dispatch by
// row title, never switching the conversation.
//
// Locale: all copy lives in the zh/en dictionaries and follows the client's
// active language through the `locale` service.
window.__ModuleLoader__.load({
  id: 'dsh-session-move',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const { Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const ROW_MENU_ATTR = 'data-session-move'
    const ROW_DELETE_ATTR = 'data-session-move-delete'
    const ROW_AI_RENAME_ATTR = 'data-session-move-ai-rename'
    const OVERLAY_SLOT = 'shell.overlay'
    const DIALOG_ID = 'session-move-dialog'
    const DELETE_DIALOG_ID = 'session-delete-dialog'
    const AI_RENAME_DIALOG_ID = 'session-ai-rename-dialog'
    const EVENT = 'dsh-session-move:open'
    const DELETE_EVENT = 'dsh-session-move:delete'
    const AI_RENAME_EVENT = 'dsh-session-move:ai-rename'

    // --- locale --------------------------------------------------------------

    const NS = 'session-move'

    const zhDict = {
      'menu.move': '移动到文件夹…',
      'menu.delete': '删除会话',
      'menu.aiRename': 'AI 重命名',
      'dialog.title': '移动会话到文件夹',
      'dialog.cancel': '取消',
      'dialog.confirm': '移动',
      'dialog.moving': '移动中…',
      'dialog.untitled': '未命名会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '序列号：',
      'dialog.current': '当前文件夹：',
      'dialog.target': '目标文件夹：',
      'dialog.targetPlaceholder': '选择目标文件夹…',
      'dialog.noTarget': '请选择一个目标文件夹',
      'dialog.sameWorkspace': '该会话已经在所选文件夹中',
      'dialog.notFoundDesc': '未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。',
      'dialog.loading': '正在加载文件夹列表…',
      'dialog.moveDesc': '移动后，会话将在目标文件夹的工作目录下继续工作。历史记录随会话一并移动。',
      'dialog.moved': '已移动到「{title}」',
      'dialog.notFound': '找不到可移动的文件夹',
      'delete.title': '删除会话',
      'delete.runningWarn': '⚠ 会话正在运行',
      'delete.ack': '我已了解后果，确认删除',
      'delete.desc': '将永久删除该会话及其全部对话记录（会话日志、统计与工作区记账），此操作不可恢复。',
      'delete.runningDesc': '该会话正在运行，删除会立即停止其任务并永久删除，正在进行的操作将中断且无法恢复。',
      'delete.deleting': '正在删除…',
      'delete.confirm': '删除',
      'delete.notFoundDesc': '未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。',
      'aiRename.title': 'AI 重命名会话',
      'aiRename.desc': 'AI 将阅读整个会话的对话内容，生成一个简洁的标题。生成需要调用模型，通常只需几秒。',
      'aiRename.renaming': 'AI 正在阅读会话并生成标题…',
      'aiRename.done': '已重命名为「{title}」',
      'aiRename.confirm': '重命名',
      'aiRename.notFoundDesc': '未能在会话列表中找到该会话（可能已被删除或列表尚未刷新），请刷新后重试。',
    }

    const enDict = {
      'menu.move': 'Move to folder…',
      'menu.delete': 'Delete session',
      'menu.aiRename': 'AI Rename',
      'dialog.title': 'Move session to folder',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Move',
      'dialog.moving': 'Moving…',
      'dialog.untitled': 'Untitled session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session ID: ',
      'dialog.current': 'Current folder: ',
      'dialog.target': 'Target folder: ',
      'dialog.targetPlaceholder': 'Choose a target folder…',
      'dialog.noTarget': 'Please choose a target folder',
      'dialog.sameWorkspace': 'The session is already in the chosen folder',
      'dialog.notFoundDesc': 'Could not find this session in the session list (it may have been deleted or the list has not refreshed yet). Please refresh and try again.',
      'dialog.loading': 'Loading folders…',
      'dialog.moveDesc': 'After moving, the session keeps working in the target folder\'s working directory. History moves with the session.',
      'dialog.moved': 'Moved to “{title}”',
      'dialog.notFound': 'No movable folders found',
      'delete.title': 'Delete session',
      'delete.runningWarn': '⚠ Session is running',
      'delete.ack': 'I understand the consequences. Confirm deletion',
      'delete.desc': 'This will permanently delete the session and all of its conversation records (session log, statistics and workspace accounting). This action cannot be undone.',
      'delete.runningDesc': 'This session is running. Deleting it will stop its task immediately and remove it permanently; any work in progress will be interrupted and cannot be recovered.',
      'delete.deleting': 'Deleting…',
      'delete.confirm': 'Delete',
      'delete.notFoundDesc': 'Could not find this session in the session list (it may have been deleted or the list has not refreshed yet). Please refresh and try again.',
      'aiRename.title': 'AI rename session',
      'aiRename.desc': 'AI will read the whole conversation and generate a concise title. This calls a model and usually takes a few seconds.',
      'aiRename.renaming': 'AI is reading the conversation and generating a title…',
      'aiRename.done': 'Renamed to “{title}”',
      'aiRename.confirm': 'Rename',
      'aiRename.notFoundDesc': 'Could not find this session in the session list (it may have been deleted or the list has not refreshed yet). Please refresh and try again.',
    }

    var __locale = null
    var __sessionsSvc = null

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function __t(key) {
      if (__locale && typeof __locale.translate === 'function') {
        const text = __locale.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
    }

    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- helpers -------------------------------------------------------------

    function normalizeTitle(t) {
      return String(t || '').trim().replace(/\s+/g, ' ')
    }

    function stripForkSuffix(t) {
      return normalizeTitle(t).replace(/\s*\(\d+\)\s*$/, '')
    }

    function resolveTargetFromStore(detail) {
      const sessionId = detail.sessionId || null
      const title = detail.title || null
      if (sessionId) return { sessionId, title }
      const want = normalizeTitle(title)
      if (!want) return null
      const wantBase = stripForkSuffix(want)
      const svc = __sessionsSvc
      if (svc && svc.list) {
        try {
          const snap = svc.list.getSnapshot()
          const byId = snap && snap.byId ? snap.byId : {}
          const ids = Object.keys(byId)
          for (const id of ids) {
            const s = byId[id]
            if (s && normalizeTitle(s.title) === want) return { sessionId: id, title: s.title }
          }
          if (wantBase) {
            for (const id of ids) {
              const s = byId[id]
              if (s && stripForkSuffix(s.title) === wantBase) return { sessionId: id, title: s.title }
            }
          }
        } catch { /* ignore */ }
      }
      return null
    }

    // --- move dialog ---------------------------------------------------------

    function MoveSessionDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null) // {sessionId, title, notFound}
      const [workspaces, setWorkspaces] = useState(null) // [{workspaceId,title,path}]
      const [currentWorkspaceId, setCurrentWorkspaceId] = useState(null)
      const [selected, setSelected] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        const handler = (e) => {
          const d = e && e.detail ? e.detail : {}
          const resolved = resolveTargetFromStore(d)
          if (!resolved) {
            const want = normalizeTitle(d.title)
            if (!want) return
            setTarget({ sessionId: null, title: want, notFound: true })
            setWorkspaces([])
            setSelected('')
            setBusy(false)
            setError(null)
            return
          }
          setTarget(resolved)
          setSelected('')
          setBusy(false)
          setError(null)
          setWorkspaces(null)
          fetch('/__sessionmove/info')
            .then((r) => r.json())
            .then((data) => {
              if (data && data.ok && Array.isArray(data.workspaces)) {
                setWorkspaces(data.workspaces)
                setCurrentWorkspaceId(data.currentWorkspaceId || null)
              } else {
                setWorkspaces([])
                setError((data && data.error) || t('dialog.notFound'))
              }
            })
            .catch(() => {
              setWorkspaces([])
              setError(t('dialog.notFound'))
            })
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setError(null)
      }, [busy])

      const confirm = useCallback(() => {
        if (busy || !target || !selected) return
        setBusy(true)
        setError(null)
        fetch('/__sessionmove/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: target.sessionId, workspaceId: selected }),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) {
              throw new Error(data.error || `move failed (HTTP ${res.status})`)
            }
            setTarget(null)
            const svc = __sessionsSvc
            if (svc && typeof svc.refreshList === 'function') {
              svc.refreshList().catch(() => {})
            }
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [busy, target, selected])

      if (!target) return null

      const name = target.notFound
        ? target.title || t('dialog.untitled')
        : (target.title || t('dialog.untitled'))
      const currentWs = workspaces && currentWorkspaceId
        ? workspaces.find((w) => w.workspaceId === currentWorkspaceId)
        : null
      const sameAsCurrent = selected === currentWorkspaceId

      const metaStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 13,
        lineHeight: '20px',
        margin: '0 0 10px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }
      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary, inherit)',
      }
      const descStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 12,
        lineHeight: '17px',
        margin: '0 0 12px',
      }
      const errStyle = {
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontSize: 12,
        lineHeight: '16px',
        marginTop: 8,
      }
      const statusStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 12,
        lineHeight: '16px',
        marginTop: 8,
      }
      const cancelBtnStyle = {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
        cursor: 'pointer',
        marginRight: 8,
      }
      const confirmBtnStyle = {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-business-primary, #4f7cff)',
        background: 'var(--dsw-alias-state-business-primary, #4f7cff)',
        color: '#fff',
        fontSize: 13,
        cursor: 'pointer',
      }

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.cancel'),
        description: target.notFound ? t('dialog.notFoundDesc') : t('dialog.moveDesc'),
        footer: [
          React.createElement('button', {
            key: 'cancel',
            type: 'button',
            disabled: busy,
            onClick: close,
            style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, t('dialog.cancel')),
          React.createElement('button', {
            key: 'confirm',
            type: 'button',
            disabled: busy || !selected || sameAsCurrent,
            onClick: confirm,
            style: { ...confirmBtnStyle, ...(busy || !selected || sameAsCurrent ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, busy ? t('dialog.moving') : t('dialog.confirm')),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          target.sessionId
            ? React.createElement(React.Fragment, null,
                React.createElement('br'),
                t('dialog.sessionId'), target.sessionId)
            : null),
        currentWs
          ? React.createElement('div', { key: 'cur', style: metaStyle },
              t('dialog.current'), currentWs.title || currentWs.path)
          : null,
        workspaces === null
          ? React.createElement('div', { key: 'loading', style: statusStyle }, t('dialog.loading'))
          : React.createElement('div', { key: 'list', role: 'radiogroup', 'aria-label': t('dialog.target') },
              workspaces.length === 0
                ? React.createElement('div', { key: 'empty', style: statusStyle }, t('dialog.notFound'))
                : workspaces.map((w) => {
                    const label = w.title || w.path
                    return React.createElement('label', {
                      key: w.workspaceId,
                      style: rowStyle,
                    }, React.createElement('input', {
                      type: 'radio',
                      name: 'session-move-target',
                      value: w.workspaceId,
                      checked: selected === w.workspaceId,
                      disabled: busy,
                      onChange: (e) => setSelected(e.target.value),
                    }), React.createElement('span', null, label,
                      w.path && w.title ? React.createElement('span', {
                        style: { color: 'var(--dsw-alias-label-tertiary, #8a8a8e)', fontSize: 12, marginLeft: 6 },
                      }, w.path) : null))
                  })),
        sameAsCurrent
          ? React.createElement('div', { key: 'same', style: { color: 'var(--dsw-alias-state-warn-primary, #f5a524)', fontSize: 12, lineHeight: '16px', marginTop: 6 } }, t('dialog.sameWorkspace'))
          : null,
        busy ? React.createElement('div', { key: 'busy', style: statusStyle }, t('dialog.moving')) : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    // --- delete session dialog ------------------------------------------------
    // Risk-consent dialog shared by the sidebar "删除会话" item. Listens for a
    // window event carrying {sessionId, title, running}; resolves the session
    // from the client store when only a title was dispatched, then POSTs to
    // the host delete endpoint. Deletion is permanent — confirmation requires
    // ticking the acknowledgement checkbox.

    function DeleteSessionDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null) // {sessionId, title, running, notFound}
      const [acknowledged, setAcknowledged] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      useEffect(() => {
        const handler = (e) => {
          const d = e && e.detail ? e.detail : {}
          const resolved = resolveTargetFromStore(d)
          if (resolved) {
            setTarget({ ...resolved, running: d.running === true })
            setAcknowledged(false)
            setError(null)
            setBusy(false)
            return
          }
          const want = normalizeTitle(d.title)
          if (!want) return
          setTarget({ sessionId: null, title: want, running: false, notFound: true })
          setAcknowledged(false)
          setError(null)
          setBusy(false)
        }
        window.addEventListener(DELETE_EVENT, handler)
        return () => window.removeEventListener(DELETE_EVENT, handler)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setError(null)
      }, [busy])

      const confirm = useCallback(() => {
        if (busy || !acknowledged || !target) return
        setBusy(true)
        setError(null)
        fetch('/__sessionmove/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: target.sessionId }),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) {
              throw new Error(data.error || ('delete failed (HTTP ' + res.status + ')'))
            }
            setTarget(null)
            const svc = __sessionsSvc
            if (svc && typeof svc.refreshList === 'function') {
              svc.refreshList().catch(() => {})
            }
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [busy, acknowledged, target])

      if (!target) return null

      const name = target.notFound
        ? target.title || t('dialog.untitled')
        : (target.title || t('dialog.untitled'))
      const description = target.notFound
        ? t('delete.notFoundDesc')
        : target.running
          ? t('delete.runningDesc')
          : t('delete.desc')

      const metaStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 13,
        lineHeight: '20px',
        margin: '0 0 10px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }
      const warnStyle = {
        color: 'var(--dsw-alias-state-warn-primary, #f5a524)',
        fontSize: 13,
        lineHeight: '20px',
        margin: '0 0 10px',
      }
      const optStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        marginTop: 10,
      }
      const errStyle = {
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontSize: 12,
        lineHeight: '16px',
        marginTop: 8,
      }
      const statusStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 12,
        lineHeight: '16px',
        marginTop: 8,
      }
      const cancelBtnStyle = {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
        cursor: 'pointer',
        marginRight: 8,
      }
      const dangerBtnStyle = {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'var(--dsw-alias-state-error-primary, #e5484d)',
        color: '#fff',
        fontSize: 13,
        cursor: 'pointer',
      }

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('delete.title'),
        closeLabel: t('dialog.cancel'),
        description,
        footer: [
          React.createElement('button', {
            key: 'cancel',
            type: 'button',
            disabled: busy,
            onClick: close,
            style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, t('dialog.cancel')),
          React.createElement('button', {
            key: 'confirm',
            type: 'button',
            disabled: busy || !acknowledged || !target.sessionId,
            onClick: confirm,
            style: { ...dangerBtnStyle, ...(busy || !acknowledged || !target.sessionId ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, busy ? t('delete.deleting') : t('delete.confirm')),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          target.sessionId
            ? React.createElement(React.Fragment, null,
                React.createElement('br'),
                t('dialog.sessionId'), target.sessionId)
            : null),
        target.running
          ? React.createElement('div', { key: 'warn', style: warnStyle }, t('delete.runningWarn'))
          : null,
        React.createElement('label', { key: 'ack', style: optStyle },
          React.createElement('input', {
            type: 'checkbox',
            checked: acknowledged,
            disabled: busy,
            onChange: (e) => setAcknowledged(e.target.checked),
          }),
          t('delete.ack')),
        busy ? React.createElement('div', { key: 'busy', style: statusStyle }, t('delete.deleting')) : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    // --- AI rename dialog ------------------------------------------------------
    // Listens for a window event carrying {sessionId, title}; calls the host
    // AI-rename endpoint and shows the new title. No risk consent needed —
    // renaming is non-destructive.

    function AiRenameDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null) // {sessionId, title, notFound}
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [doneTitle, setDoneTitle] = useState(null)

      useEffect(() => {
        const handler = (e) => {
          const d = e && e.detail ? e.detail : {}
          const resolved = resolveTargetFromStore(d)
          if (!resolved) {
            const want = normalizeTitle(d.title)
            if (!want) return
            setTarget({ sessionId: null, title: want, notFound: true })
            setBusy(false)
            setError(null)
            setDoneTitle(null)
            return
          }
          setTarget(resolved)
          setBusy(false)
          setError(null)
          setDoneTitle(null)
        }
        window.addEventListener(AI_RENAME_EVENT, handler)
        return () => window.removeEventListener(AI_RENAME_EVENT, handler)
      }, [])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setError(null)
        setDoneTitle(null)
      }, [busy])

      // Start renaming immediately when the dialog opens with a real session.
      useEffect(() => {
        if (!target || target.notFound || !target.sessionId || busy || doneTitle !== null) return
        setBusy(true)
        setError(null)
        fetch('/__sessionmove/rename-ai', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: target.sessionId }),
        })
          .then(async (res) => {
            let data = {}
            try { data = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !data.ok) {
              throw new Error(data.error || ('rename failed (HTTP ' + res.status + ')'))
            }
            setDoneTitle(data.title)
            setBusy(false)
            const svc = __sessionsSvc
            if (svc && typeof svc.refreshList === 'function') {
              svc.refreshList().catch(() => {})
            }
          })
          .catch((reason) => {
            setBusy(false)
            setError(reason && reason.message ? reason.message : String(reason))
          })
      }, [target, busy, doneTitle])

      if (!target) return null

      const name = target.notFound
        ? target.title || t('dialog.untitled')
        : (target.title || t('dialog.untitled'))

      const metaStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 13,
        lineHeight: '20px',
        margin: '0 0 10px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }
      const descStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 13,
        lineHeight: '20px',
        margin: '0 0 12px',
      }
      const doneStyle = {
        color: 'var(--dsw-alias-state-success-primary, #30a46c)',
        fontSize: 13,
        lineHeight: '20px',
        marginTop: 8,
        fontWeight: 500,
      }
      const errStyle = {
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontSize: 12,
        lineHeight: '16px',
        marginTop: 8,
      }
      const statusStyle = {
        color: 'var(--dsw-alias-label-secondary, #8a8a8e)',
        fontSize: 13,
        lineHeight: '20px',
        marginTop: 8,
      }
      const closeBtnStyle = {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: 13,
        cursor: 'pointer',
      }

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('aiRename.title'),
        closeLabel: t('dialog.cancel'),
        description: target.notFound ? t('aiRename.notFoundDesc') : t('aiRename.desc'),
        footer: [
          React.createElement('button', {
            key: 'close',
            type: 'button',
            disabled: busy,
            onClick: close,
            style: closeBtnStyle,
          }, t('dialog.cancel')),
        ],
      }, [
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          target.sessionId
            ? React.createElement(React.Fragment, null,
                React.createElement('br'),
                t('dialog.sessionId'), target.sessionId)
            : null),
        busy
          ? React.createElement('div', { key: 'busy', style: statusStyle }, t('aiRename.renaming'))
          : null,
        doneTitle !== null
          ? React.createElement('div', { key: 'done', style: doneStyle }, t('aiRename.done', { title: doneTitle }))
          : null,
        error ? React.createElement('div', { key: 'err', style: errStyle, role: 'alert' }, error) : null,
      ])
    }

    // --- sidebar session-row menu injection ----------------------------------

    var FOLDER_PATH = 'M8.05 1.75a.75.75 0 0 1 .663.398L9.57 4h4.68a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75v-11a.75.75 0 0 1 .75-.75h6.3Zm-.418 1.5H2.5v9h11v-7.5H9.212l-.915-1.5Z'
    var TRASH_PATH = 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.4161 12.0917 13.1624 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z'
    // Sparkle/star icon for the AI-rename menu item.
    var SPARKLE_PATH = 'M8 1.75a.75.75 0 0 1 .698.47l1.086 2.632a.75.75 0 0 0 .364.364l2.632 1.086a.75.75 0 0 1 0 1.396l-2.632 1.086a.75.75 0 0 0-.364.364L8.698 11.28a.75.75 0 0 1-1.396 0L6.216 8.648a.75.75 0 0 0-.364-.364L3.22 7.198a.75.75 0 0 1 0-1.396l2.632-1.086a.75.75 0 0 0 .364-.364L7.302 2.22A.75.75 0 0 1 8 1.75ZM12.5 9.5a.5.5 0 0 1 .465.313l.36.872a.5.5 0 0 0 .242.242l.872.36a.5.5 0 0 1 0 .93l-.872.36a.5.5 0 0 0-.242.242l-.36.872a.5.5 0 0 1-.93 0l-.36-.872a.5.5 0 0 0-.242-.242l-.872-.36a.5.5 0 0 1 0-.93l.872-.36a.5.5 0 0 0 .242-.242l.36-.872A.5.5 0 0 1 12.5 9.5Z'

    function openMoveFlow(row) {
      if (!row) return
      var titleEl = row.querySelector('[class*=title]')
      var title = titleEl ? String(titleEl.innerText || '').trim() : ''
      if (!title) return
      window.dispatchEvent(new CustomEvent(EVENT, { detail: { title } }))
    }

    function openDeleteFlow(row) {
      if (!row) return
      var titleEl = row.querySelector('[class*=title]')
      var title = titleEl ? String(titleEl.innerText || '').trim() : ''
      if (!title) return
      window.dispatchEvent(new CustomEvent(DELETE_EVENT, { detail: { title } }))
    }

    function openAiRenameFlow(row) {
      if (!row) return
      var titleEl = row.querySelector('[class*=title]')
      var title = titleEl ? String(titleEl.innerText || '').trim() : ''
      if (!title) return
      window.dispatchEvent(new CustomEvent(AI_RENAME_EVENT, { detail: { title } }))
    }

    // Shared base style for injected menu items.
    function menuItemStyle(danger) {
      return [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        'color:' + (danger ? 'var(--dsw-alias-state-error-primary,#e5484d)' : 'var(--dsw-alias-label-primary,inherit)'),
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
    }

    function makeMenuItem(attr, svgPath, label, danger, onClick) {
      var item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute(attr, '1')
      item.style.cssText = menuItemStyle(danger)
      item.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="' + svgPath + '" fill="currentColor"/></svg><span></span>'
      item.querySelector('span').textContent = label
      item.addEventListener('mouseenter', function () {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', function () {
        item.style.background = 'transparent'
      })
      item.addEventListener('click', onClick)
      return item
    }

    function appendSeparator(menu) {
      var sep = document.createElement('div')
      sep.style.cssText = 'height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))'
      menu.appendChild(sep)
      return sep
    }

    function ensureSidebarMoveItem() {
      var menu = document.querySelector('[role=menu]')
      if (!menu) return
      if (menu.querySelector('[' + ROW_MENU_ATTR + ']') && menu.querySelector('[' + ROW_AI_RENAME_ATTR + ']') && menu.querySelector('[' + ROW_DELETE_ATTR + ']')) return
      var row = findOpenSessionRow()
      if (!row) return // not a session-row menu
      if (!menu.querySelector('[' + ROW_MENU_ATTR + ']')) {
        menu.appendChild(makeMenuItem(ROW_MENU_ATTR, FOLDER_PATH, __t('menu.move'), false, function () { openMoveFlow(row) }))
      }
      if (!menu.querySelector('[' + ROW_AI_RENAME_ATTR + ']')) {
        menu.appendChild(makeMenuItem(ROW_AI_RENAME_ATTR, SPARKLE_PATH, __t('menu.aiRename'), false, function () { openAiRenameFlow(row) }))
      }
      if (!menu.querySelector('[' + ROW_DELETE_ATTR + ']')) {
        appendSeparator(menu)
        menu.appendChild(makeMenuItem(ROW_DELETE_ATTR, TRASH_PATH, __t('menu.delete'), true, function () { openDeleteFlow(row) }))
      }
    }

    function findOpenSessionRow() {
      var rows = document.querySelectorAll('[class*=sessionRow]')
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i]
      }
      return null
    }

    function refreshSidebarMoveLabel() {
      const items = document.querySelectorAll('[' + ROW_MENU_ATTR + ']')
      for (let i = 0; i < items.length; i++) {
        const span = items[i].querySelector('span')
        if (span) span.textContent = __t('menu.move')
      }
      const renames = document.querySelectorAll('[' + ROW_AI_RENAME_ATTR + ']')
      for (let i = 0; i < renames.length; i++) {
        const span = renames[i].querySelector('span')
        if (span) span.textContent = __t('menu.aiRename')
      }
      const deletes = document.querySelectorAll('[' + ROW_DELETE_ATTR + ']')
      for (let i = 0; i < deletes.length; i++) {
        const span = deletes[i].querySelector('span')
        if (span) span.textContent = __t('menu.delete')
      }
    }

    function installSidebarMove() {
      if (window.__dshSessionMoveInstalled) return
      window.__dshSessionMoveInstalled = true
      try { ensureSidebarMoveItem() } catch (e) { /* never crash the UI */ }
      var observer = new MutationObserver(function () {
        try { ensureSidebarMoveItem() } catch (e) { /* never crash the UI */ }
        try { ensureDropTargets() } catch (e) { /* never crash the UI */ }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      installDropHandling()
    }

    // --- drag-and-drop: move a session onto another workspace row ------------
    // The official workspace browser only supports drag-reorder WITHIN one
    // folder: session rows are draggable, but the folder rows' dragover/drop
    // handlers only react while a WORKSPACE row is being dragged (the
    // workspace reorder). Dragging a SESSION over a folder row is ignored by
    // the official code (no preventDefault), so the browser rejects the drop.
    //
    // IMPORTANT (HTML5 DnD): dataTransfer.getData() is only reliable during
    // the DROP event — during dragstart it returns '' by spec, regardless of
    // listener phase. So we (a) classify the drag source from the DOM at
    // dragstart (session row vs workspace row), and (b) read the session id
    // from dataTransfer inside the drop handler, where it is guaranteed
    // readable (the official session row sets 'text/plain' = session id).

    const DROP_ATTR = 'data-session-move-drop'
    var __dragKind = null // 'session' | 'workspace' | null
    var __dropHighlight = null

    function isSessionId(v) {
      return typeof v === 'string' && /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    }

    // Classify the drag source from the DOM (not dataTransfer): the official
    // code marks session rows and workspace rows with distinct CSS module
    // class names. Runs in the bubble phase so the DOM is fully settled.
    function installDropHandling() {
      if (window.__dshSessionMoveDropInstalled) return
      window.__dshSessionMoveDropInstalled = true
      document.addEventListener('dragstart', function (e) {
        var t = e.target
        if (!t || typeof t.closest !== 'function') return
        if (t.closest('[class*=sessionRow]')) {
          __dragKind = 'session'
          try { ensureDropTargets() } catch (err) { /* ignore */ }
        } else if (t.closest('[class*=projectRow]')) {
          __dragKind = 'workspace'
        } else {
          __dragKind = null
        }
      })
      document.addEventListener('dragend', function () {
        __dragKind = null
        clearDropHighlight()
      })
      // Fallback cleanup on drop too (covers both our drops and official ones).
      document.addEventListener('drop', function () {
        __dragKind = null
        clearDropHighlight()
      })
    }

    function clearDropHighlight() {
      if (__dropHighlight) {
        try { __dropHighlight.style.outline = '' } catch { /* ignore */ }
        __dropHighlight = null
      }
    }

    // A folder row (workspace header) in the tree view. Inject dragover/drop
    // only when a SESSION is being dragged; workspace-reorder drags are left
    // to the official handlers untouched.
    function ensureDropTargets() {
      var rows = document.querySelectorAll('[class*=projectRow]')
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i]
        if (row.getAttribute(DROP_ATTR)) continue
        row.setAttribute(DROP_ATTR, '1')
        row.addEventListener('dragover', function (e) {
          if (__dragKind !== 'session') return
          e.preventDefault()
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
          clearDropHighlight()
          __dropHighlight = this
          try { this.style.outline = '2px solid var(--dsw-alias-state-business-primary, #4f7cff)' } catch { /* ignore */ }
        })
        row.addEventListener('dragleave', function () {
          if (__dropHighlight === this) clearDropHighlight()
        })
        row.addEventListener('drop', function (e) {
          if (__dragKind !== 'session') return
          e.preventDefault()
          e.stopPropagation()
          __dragKind = null
          clearDropHighlight()
          // dataTransfer is readable here: the official session row's
          // dragstart set 'text/plain' to the session id.
          var id = e.dataTransfer && e.dataTransfer.getData ? e.dataTransfer.getData('text/plain') : ''
          if (!isSessionId(id)) return
          // Resolve the target workspace from the folder row's title via the
          // info endpoint (folder rows carry no data attribute with their id;
          // titles are unique in practice for this profile).
          try {
            var titleEl = this.querySelector('[class*=title]')
            var title = titleEl ? String(titleEl.innerText || '').trim() : ''
            if (title) moveByDrop(id, title)
          } catch (err) { /* never crash the UI */ }
        })
      }
    }

    // POST the move; on success refresh the session list in place. Reuses the
    // same endpoint and refresh flow as the dialog.
    function moveByDrop(sessionId, workspaceTitle) {
      fetch('/__sessionmove/info')
        .then(function (r) { return r.json() })
        .then(function (data) {
          if (!data || !data.ok || !Array.isArray(data.workspaces)) throw new Error('info unavailable')
          var ws = data.workspaces.find(function (w) { return w.title === workspaceTitle })
          if (!ws) throw new Error('workspace not found: ' + workspaceTitle)
          // Don't move when the session already lives in the target folder.
          if (data.currentWorkspaceId === ws.workspaceId) return
          return fetch('/__sessionmove/move', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId, workspaceId: ws.workspaceId }),
          }).then(async function (res) {
            var payload = {}
            try { payload = await res.json() } catch { /* keep {} */ }
            if (!res.ok || !payload.ok) throw new Error(payload.error || ('move failed (HTTP ' + res.status + ')'))
            var svc = __sessionsSvc
            if (svc && typeof svc.refreshList === 'function') {
              svc.refreshList().catch(function () {})
            }
          })
        })
        .catch(function (err) { /* surface quietly; drag-and-drop must never crash the UI */ })
    }

    // --- apply ---------------------------------------------------------------

    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* namespace already registered: keep the existing copy */ }
    }

    function apply(ctx) {
      __sessionsSvc = ctx.get('sessions')
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => {
          __sessionsSvc = sub.sessions
        })
      }
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
          refreshSidebarMoveLabel()
        })
      }
      ctx.on('locale/change', refreshSidebarMoveLabel)
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 100,
        ...(__locale ? { locale: NS } : {}),
      }, MoveSessionDialog))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DELETE_DIALOG_ID,
        order: 110,
        ...(__locale ? { locale: NS } : {}),
      }, DeleteSessionDialog))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: AI_RENAME_DIALOG_ID,
        order: 105,
        ...(__locale ? { locale: NS } : {}),
      }, AiRenameDialog))
      installSidebarMove()
    }

    return { apply, inject: ['slots'] }
  },
})
