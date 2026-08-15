// dsh-session-move: HOST half.
//
// Session management for a DSH profile, surfaced in the Web UI and to agents:
//   - move a session to another workspace (folder)
//   - permanently delete a session
//   - AI-rename a session (LLM summarizes the conversation into a title)
//
// DSH folders ("workspaces") are NOT free-form containers: a session belongs
// to the workspace whose `path` equals the session's cwd (work directory).
// The cwd is frozen in the session header line (first frame of the
// session.jsonl.zstd artifact) and physically determines where the session
// log lives: ~/.dsh/sessions/<projectKey(cwd)>/<sessionId>/.
//
// Moving a session therefore means, in one atomic-ish sequence:
//   1. stop/flush live sessions (moving while an agent owns the session would
//      desync the in-memory header from the on-disk one);
//   2. read the on-disk header line to learn the current cwd;
//   3. rewrite the header line's `cwd` to the target workspace's path
//      (decompress the first zstd frame, patch the JSON, recompress,
//      concatenate with the untouched trailing frames);
//   4. physically move the session directory to the new projectKey slug;
//   5. detach the session from the old workspace and attach it to the new
//      one via the workspace registry (its attachSession validates the
//      on-disk header cwd against the target path and updates the in-memory
//      session-path index, so the UI reflects the move without a restart).
//
// Surfaces:
//   GET  /__sessionmove/info             - workspaces + current workspace
//   POST /__sessionmove/move             - move (body: {sessionId, workspaceId})
//   POST /__sessionmove/delete           - delete (body: {sessionId})
//   POST /__sessionmove/rename-ai        - AI rename (body: {sessionId})
//   workbench_session_move               - model tool wrapper over move
//   workbench_session_delete             - model tool wrapper over delete
//   workbench_session_rename_ai          - model tool wrapper over AI rename
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title'

const name = 'dsh-session-move'
// Required services. 'tools' powers the model tools; 'sessions' and 'llm'
// back the AI-rename feature (live session lookup + LLM stream), which are
// accessed as ctx.sessions / ctx.llm property accessors and therefore must
// be injected — cordis rejects undeclared property access.
const inject = ['tools', 'sessions', 'llm']

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const ZSTD_MAGIC = 0xfd2fb528

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class MoveError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

// --- path helpers ------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

// Reproduce the JSONL backend's projectKey() slug encoding so the session
// directory can be located/moved without depending on the internal package.
// Separators become '-'; unsafe code units become ~XXXX (uppercase hex);
// leading '-' runs are stripped; the result is wrapped in '--...--'.
function projectKey(cwd) {
  if (!cwd || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

// Session ids appear in two spellings in different stores (raw uuid and
// `session-<uuid>`); try both when scanning for on-disk directories.
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (SESSION_ID_RE.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
}

// Locate every on-disk session directory across all slug folders.
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, e.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch { /* keep scanning */ }
    }
  }
  return found
}

// Remove every on-disk session directory for both id spellings.
function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return dirs.length > 0
}

// --- zstd frame helpers (concatenated-frame container, like the backend) -----

// Structurally scan complete zstd frames; EOF inside the final frame is
// reported via tornStart (not needed for our read-modify-write path, but
// kept for safety when patching the first frame).
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt zstd session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('corrupt zstd session log: reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

// Read the session header line: decompress the first frame, parse its JSON.
async function readSessionHeader(sessionDirPath) {
  const file = path.join(sessionDirPath, 'session.jsonl.zstd')
  if (!fs.existsSync(file)) {
    // Plaintext fallback (compression: none) — just in case.
    const plain = path.join(sessionDirPath, 'session.jsonl')
    if (fs.existsSync(plain)) {
      const first = fs.readFileSync(plain, 'utf8').split('\n')[0]
      return JSON.parse(first)
    }
    throw new MoveError(`session log not found in ${sessionDirPath}`, 500)
  }
  const bytes = fs.readFileSync(file)
  const frames = scanZstdFrames(bytes)
  if (frames.length === 0) throw new MoveError(`cannot locate header frame of ${file}`, 500)
  const first = bytes.subarray(frames[0].start, frames[0].end)
  const plaintext = await zstdDecompressAsync(first)
  const text = plaintext.toString('utf8')
  const line = text.split('\n')[0]
  return { header: JSON.parse(line), frameBytes: first, frameIndex: frames }
}

// Patch the header line's cwd and rewrite the artifact: new first frame
// (recompressed) + untouched trailing frames. The header line is JSONL: it
// MUST end with '\n' (the backend's parseHeaderRecord requires the last byte
// to be 0x0A), so serialize with a trailing newline exactly like the
// original writer.
async function rewriteHeaderCwd(file, header, firstFrameBytes, frames, newCwd) {
  const patched = { ...header, cwd: newCwd }
  const newFirst = await zstdCompressAsync(`${JSON.stringify(patched)}\n`, CHECKSUM_OPTIONS)
  const bytes = fs.readFileSync(file)
  const trailing = frames.slice(1).map((f) => bytes.subarray(f.start, f.end))
  const out = Buffer.concat([newFirst, ...trailing])
  const tmp = `${file}.move-tmp-${process.pid}`
  fs.writeFileSync(tmp, out)
  fs.renameSync(tmp, file)
}

// --- storage helpers ---------------------------------------------------------

// Stop a live agent before anything moves (cancel + bounded quiescence).
async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  if (typeof agent.cancel === 'function') {
    try { agent.cancel({ kind: 'user' }) } catch { /* already settling */ }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((resolve) => setTimeout(resolve, 15000)),
      ])
    } catch { /* proceed anyway */ }
  }
  return true
}

// Flush a live session so dispose-time teardown has no pending writes that
// could recreate the old log path after we move the directory.
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') {
      try { await sessions.flush(session); flushed = true } catch { /* ignore */ }
    }
  }
  return flushed
}

// Read workspace registry state (id -> {path,title,sessionIds}) via the
// storageDomain, plus the live registry's view where available.
async function readWorkspaces(ctx) {
  const out = []
  const sd = ctx.get('storageDomain')
  if (sd && typeof sd.get === 'function') {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const table = ws.table('workspaces')
        for (const [id, rec] of table.entries()) {
          if (!rec || typeof rec !== 'object') continue
          out.push({
            workspaceId: id,
            path: typeof rec.path === 'string' ? rec.path : null,
            title: typeof rec.title === 'string' ? rec.title : null,
            sessionIds: Array.isArray(rec.sessionIds) ? rec.sessionIds : [],
          })
        }
      } catch { /* unit closed or table absent */ }
    }
  }
  return out
}

// --- core move ---------------------------------------------------------------

async function moveSessionCore(ctx, sessionId, workspaceId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new MoveError(`invalid session id: ${sessionId}`)
  }

  const workspaces = await readWorkspaces(ctx)
  const target = workspaces.find((w) => w.workspaceId === workspaceId)
  if (!target || !target.path) {
    throw new MoveError(`workspace not found: ${workspaceId}`, 404)
  }

  // 1. Refuse while a live agent owns the session: moving would desync the
  //    in-memory header from the on-disk one. We stop + flush first (mirrors
  //    the delete plugin's safety posture) so the move is never half-applied.
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)

  // 2. Locate the on-disk session directory and read its header cwd.
  const dirs = findSessionDirs(sessionId)
  if (dirs.length === 0) throw new MoveError(`session not found: ${sessionId}`, 404)
  const sessionDirPath = dirs[0]
  const { header, frameBytes, frameIndex } = await readSessionHeader(sessionDirPath)
  const oldCwd = header.cwd

  // 3. When the session already lives in the target directory, the physical
  //    move is a no-op — but the workspace accounting might still be missing
  //    (e.g. after a failed attach in a previous move attempt). Detect and
  //    repair that case instead of returning silently.
  const oldWorkspace = workspaces.find((w) => w.path === oldCwd) || null
  if (oldCwd === target.path) {
    // Check whether the session is actually recorded in the target workspace.
    const alreadyAccounted = target.sessionIds.includes(sessionId)
    if (alreadyAccounted) {
      return {
        moved: false,
        sessionId,
        oldCwd,
        newCwd: target.path,
        oldWorkspaceId: oldWorkspace ? oldWorkspace.workspaceId : null,
        newWorkspaceId: target.workspaceId,
      }
    }
    // Session is in the right directory but missing from the workspace table —
    // fall through to the attach step below. Refresh in-memory caches first.
    const reg = ctx.get('workspaceRegistry')
    if (reg && typeof reg === 'object') {
      try {
        const liveSessions = ctx.get('sessions')
        const live = liveSessions && typeof liveSessions.get === 'function'
          ? liveSessions.get(sessionId) : undefined
        if (live && live.header) {
          try { live.header.cwd = target.path } catch { /* frozen */ }
        }
        const updatedHeader = { ...header, cwd: target.path }
        if (typeof reg.headers?.set === 'function') reg.headers.set(sessionId, updatedHeader)
        if (typeof reg.sessionPaths?.set === 'function') reg.sessionPaths.set(sessionId, target.path)
        if (typeof reg.invalidSessionPaths?.delete === 'function') reg.invalidSessionPaths.delete(sessionId)
      } catch { /* best-effort */ }
    }
    // Now attach. If oldCwd belongs to a different workspace, detach first.
    if (oldWorkspace && oldWorkspace.workspaceId !== target.workspaceId) {
      const entity = reg && typeof reg.get === 'function' ? reg.get(oldWorkspace.workspaceId) : undefined
      if (entity && typeof entity.detachSession === 'function') {
        try { await entity.detachSession(sessionId) } catch { /* ignore */ }
      }
    }
    let attachError = null
    const newEntity = reg && typeof reg.get === 'function' ? reg.get(target.workspaceId) : undefined
    if (newEntity && typeof newEntity.attachSession === 'function') {
      try { await newEntity.attachSession(sessionId) } catch (e) {
        attachError = String(e?.message ?? e)
      }
    }
    // Ensure the workspace table is persisted to disk so the attach survives
    // a restart (storageDomain may batch writes).
    try {
      const sd = ctx.get('storageDomain')
      if (sd && typeof sd.flush === 'function') await sd.flush()
    } catch { /* best-effort flush */ }
    return {
      moved: false,
      reattached: !alreadyAccounted,
      sessionId,
      oldCwd,
      newCwd: target.path,
      oldWorkspaceId: oldWorkspace ? oldWorkspace.workspaceId : null,
      newWorkspaceId: target.workspaceId,
      ...(attachError !== null ? { attachError } : {}),
    }
  }

  // 4. Move the physical directory first: old slug -> new slug.
  const newSlug = projectKey(target.path)
  const newSessionDir = path.join(sessionsRoot(), newSlug, sessionDirPath.split(path.sep).pop())
  try {
    fs.mkdirSync(path.dirname(newSessionDir), { recursive: true })
    fs.renameSync(sessionDirPath, newSessionDir)
  } catch (error) {
    throw new MoveError(`failed to move session directory: ${error.message}`, 500)
  }

  // 5. Rewrite the header cwd in the new location.
  const logFile = path.join(newSessionDir, 'session.jsonl.zstd')
  try {
    await rewriteHeaderCwd(logFile, header, frameBytes, frameIndex, target.path)
  } catch (error) {
    // Roll the directory back so a failed header patch never leaves the
    // session stranded under the new slug with the old cwd.
    try { fs.renameSync(newSessionDir, sessionDirPath) } catch { /* keep going */ }
    throw new MoveError(`failed to rewrite session header: ${error.message}`, 500)
  }

  // 6. Refresh the workspace registry's in-memory header/path index for this
  //    session BEFORE detach/attach. attachSession validates through
  //    readSessionHeader, which prefers the in-memory cache (live session
  //    header, then the headers map) over the on-disk artifact — if we only
  //    rewrote the file, the cache still carries the old cwd and the attach
  //    would fail its path check. Mirroring the cache keeps the UI consistent
  //    without a restart.
  const reg = ctx.get('workspaceRegistry')
  if (reg && typeof reg === 'object') {
    try {
      const liveSessions = ctx.get('sessions')
      const live = liveSessions && typeof liveSessions.get === 'function'
        ? liveSessions.get(sessionId)
        : undefined
      const updatedHeader = { ...header, cwd: target.path }
      if (live && live.header) {
        // A live session's header is authoritative for readSessionHeader.
        // Patch the live header object's cwd in place (it is a plain record
        // on the session entity; the on-disk artifact was already rewritten,
        // so keeping the in-memory view aligned is safe).
        try { live.header.cwd = target.path } catch { /* frozen or read-only */ }
      }
      if (typeof reg.headers?.set === 'function') {
        reg.headers.set(sessionId, updatedHeader)
      }
      if (typeof reg.sessionPaths?.set === 'function') {
        reg.sessionPaths.set(sessionId, target.path)
      }
      if (typeof reg.invalidSessionPaths?.delete === 'function') {
        reg.invalidSessionPaths.delete(sessionId)
      }
    } catch (e) {
      ctx.logger?.warn?.('[dsh-session-move] registry index refresh failed:', e?.message ?? e)
    }
  }

  // 7. Update workspace accounting: detach from the old workspace, attach to
  //    the new one (attachSession validates the header cwd == target path —
  //    now satisfied by the refreshed in-memory index — and re-accounts the
  //    session under the target workspace).
  let oldWorkspaceId = null
  if (oldWorkspace) {
    oldWorkspaceId = oldWorkspace.workspaceId
    const entity = reg && typeof reg.get === 'function' ? reg.get(oldWorkspaceId) : undefined
    if (entity && typeof entity.detachSession === 'function') {
      try { await entity.detachSession(sessionId) } catch (e) {
        ctx.logger?.warn?.('[dsh-session-move] detach failed:', e?.message ?? e)
      }
    }
  }
  const newEntity = reg && typeof reg.get === 'function' ? reg.get(target.workspaceId) : undefined
  let attachError = null
  if (newEntity && typeof newEntity.attachSession === 'function') {
    try { await newEntity.attachSession(sessionId) } catch (e) {
      attachError = String(e?.message ?? e)
      ctx.logger?.warn?.('[dsh-session-move] attach failed:', e?.message ?? e)
    }
  }
  // Persist workspace table to disk so the attach survives a restart.
  try {
    const sd = ctx.get('storageDomain')
    if (sd && typeof sd.flush === 'function') await sd.flush()
  } catch { /* best-effort flush */ }

  return {
    moved: true,
    stopped,
    sessionId,
    oldCwd,
    newCwd: target.path,
    oldWorkspaceId,
    newWorkspaceId: target.workspaceId,
    ...(attachError !== null ? { attachError } : {}),
  }
}

// --- core delete -------------------------------------------------------------

// Remove the session from the in-memory store so host session lists stop
// returning it and no flush can re-materialize its files. Mirrors the
// delete-session plugin's approach (detachEntered is the store's own teardown
// path); falls back to raw store.delete defensively.
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        detached = true
      }
    }
  } catch { /* ignore */ }
  return detached
}

// Remove the session from the projection-cache domain and the workspace
// accounting domain via the active storageDomain, so memory and disk stay
// consistent (no resurrected session after the next periodic flush).
async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch { /* unit closed or table absent */ }
  }

  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, {
              ...rec,
              sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)),
            })
            workspaceRemoved = true
          }
        }
      } catch { /* unit closed or table absent */ }
      try {
        const g = ws.global
        if (g && typeof g.get === 'function' && typeof g.set === 'function') {
          const state = g.get()
          if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
            await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
            workspaceRemoved = true
          }
        }
      } catch { /* no global slot or unit closed */ }
    }
  }

  return { projRemoved, workspaceRemoved }
}

// Delete one session end-to-end: stop + flush live agent, detach it from the
// in-memory store, remove the on-disk log directory (both id spellings), drop
// the projection row, and only then detach the workspace accounting — so a
// failed delete can never leave the session half-detached in "Ungrouped".
async function deleteSessionCore(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new MoveError(`invalid session id: ${sessionId}`, 400)
  }
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  detachLiveSession(ctx, sessionId)

  const firstDirRemoved = removeSessionDirs(sessionId)
  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  const secondDirRemoved = removeSessionDirs(sessionId)
  await new Promise((resolve) => setImmediate(resolve))
  const thirdDirRemoved = removeSessionDirs(sessionId)

  const remainingDirs = findSessionDirs(sessionId)
  if (remainingDirs.length > 0) {
    throw new MoveError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500)
  }

  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirRemoved = firstDirRemoved || secondDirRemoved || thirdDirRemoved
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved
  if (!dirRemoved && !projRemoved && !workspaceRemoved) {
    throw new MoveError(`session not found: ${sessionId}`, 404)
  }
  return { stopped, detached: true, dirRemoved, projRemoved, workspaceRemoved }
}

// --- core AI rename ----------------------------------------------------------

// Default LLM config for the AI rename feature. These mirror the values the
// official session-title-llm provider ships with, and can be overridden via
// the plugin row config (see README).
const AI_RENAME_DEFAULTS = {
  targetWords: 6,
  targetCjkCharacters: 14,
  maxInputBytes: 8192,
  maxOutputTokens: 96,
  timeoutMs: 60000,
}

// Collect human text-bearing user messages in log order (same eligibility
// rule as the official session-title fold: user-sourced, text-bearing).
function collectSessionTitleMessages(events, throughSeq) {
  const messages = []
  for (const event of events) {
    if (throughSeq !== undefined && event.seq > throughSeq) break
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const text = (event.data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (typeof text !== 'string' || text.trim().length === 0) continue
    messages.push({ seq: event.seq, text })
  }
  return messages
}

// Select the messages fed to the title LLM. Long conversations are sampled
// EVENLY across the whole timeline (first + last always kept, interior points
// spaced by index) so the title model sees the arc of the conversation —
// opening intent, middle development, recent tail — instead of only the first
// and last few messages. The sample size is the largest that still fits
// within maxInputBytes.
function selectTitleMessages(messages, maxInputBytes) {
  if (messages.length === 0) return messages
  const fits = (candidates) => {
    const framed = `Generate the session title from this JSON array of human messages:\n${JSON.stringify(candidates)}`
    return Buffer.byteLength(framed, 'utf8') <= maxInputBytes
  }
  if (fits(messages)) return messages
  // Sample k evenly-spaced messages (always including both ends) for k from
  // large to small until the framed input fits. Binary search over k.
  const sample = (k) => {
    if (k <= 0) return [messages[0]]
    if (k >= messages.length) return messages
    const picked = []
    for (let i = 0; i < k; i++) {
      const index = Math.round((i / (k - 1)) * (messages.length - 1))
      picked.push(messages[index])
    }
    // De-duplicate in case rounding collapsed adjacent indices.
    const seen = new Set()
    return picked.filter((m) => {
      if (seen.has(m.seq)) return false
      seen.add(m.seq)
      return true
    })
  }
  let lo = 1
  let hi = messages.length
  let best = [messages[0]]
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidates = sample(mid)
    if (fits(candidates)) {
      best = candidates
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

// AI-rename a session: sample the conversation, generate a title with our own
// prompt (fixes typos, concise), and apply it through the sessionTitle
// service. Both generation and rename append to the session, so it must be
// LIVE: live sessions are used directly, cold sessions are resumed through
// the agents service (which materializes them in the store) first.
async function renameSessionWithAi(ctx, sessionId, configOverride) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new MoveError(`invalid session id: ${sessionId}`, 400)
  }
  const config = {
    ...AI_RENAME_DEFAULTS,
    ...(configOverride && typeof configOverride === 'object' ? configOverride : {}),
  }
  let validated
  try {
    validated = resolveSessionTitleLlmConfig(config)
  } catch (e) {
    throw new MoveError(`invalid AI-rename config: ${e.message}`, 500)
  }

  // 1. Resolve the LIVE session (generator + rename both append to it).
  //    Live sessions are already attached; cold sessions are resumed through
  //    the agents service (the same path the official API uses), which
  //    materializes them in the session store.
  let session = ctx.sessions?.get?.(sessionId)
  if (session === undefined) {
    const agents = ctx.get('agents')
    if (agents !== undefined && typeof agents.resume === 'function') {
      try {
        await agents.resume({ resumeSessionId: sessionId })
      } catch (e) {
        ctx.logger?.warn?.('[dsh-session-move] cold-session resume failed:', e?.message ?? e)
      }
      session = ctx.sessions?.get?.(sessionId)
    }
    if (session === undefined) throw new MoveError(`session not found: ${sessionId}`, 404)
  }

  // 2. Collect human user messages from the live log. Long conversations are
  //    sampled evenly across the timeline so the title model sees the arc of
  //    the conversation while the input stays under maxInputBytes.
  const events = [...session.events]
  if (events.length === 0) throw new MoveError(`session has no message history: ${sessionId}`, 400)
  const allMessages = collectSessionTitleMessages(events)
  if (allMessages.length === 0) throw new MoveError(`session has no user messages to summarize: ${sessionId}`, 400)
  const messages = selectTitleMessages(allMessages, config.maxInputBytes)

  // 3. Generate the title through our own prompt (fixes typos, concise).
  //    The route comes from the session's own last request header (its
  //    current model), falling back to a plugin-configured provider/model
  //    pair when the session has never issued a request.
  const headerConfig = typeof session.requestHeader === 'function'
    ? session.requestHeader()?.config
    : undefined
  const route = (headerConfig && headerConfig.provider && headerConfig.model)
    ? { provider: headerConfig.provider, model: headerConfig.model }
    : (config.provider && config.model)
      ? { provider: config.provider, model: config.model }
      : undefined
  if (route === undefined) {
    throw new MoveError(
      'cannot AI-rename: no model route available (session has no request history and the plugin has no provider/model config). Add provider+model to the session-move plugin row config.',
      400,
    )
  }
  const request = {
    session,
    messages,
    signal: new AbortController().signal,
    route,
  }
  const title = await generateTitleWithCustomPrompt(ctx, validated, request, messages)
  // 4. Apply through the sessionTitle service.
  const titleService = ctx.get('sessionTitle')
  if (titleService === undefined || typeof titleService.rename !== 'function') {
    throw new MoveError('session title service is not available', 500)
  }
  const accepted = titleService.rename(session, title)
  return {
    title: accepted.title,
    sessionId,
  }
}

// Generate a session title with OUR OWN prompt instead of the official
// session-title-llm one. The official prompt produces ultra-short titles
// (≤10 CJK chars) and does not correct typos — user-reported issues. Our
// prompt asks for a slightly fuller title that summarizes what the
// conversation ACCOMPLISHED, and explicitly instructs the model to fix
// obvious typos in the source messages.
const TITLE_SYSTEM_PROMPT = [
  'You are naming an AI coding-assistant chat session.',
  'Read the human messages (they are a sample of the conversation) and write ONE concise title that captures the overall purpose of the session — what the user wanted and what was accomplished.',
  'Do NOT repeat the literal opening words of the conversation; write a summary title.',
  'IMPORTANT — fix typos: the source messages are raw user input and often contain typos or misspelled words. Always silently use the CORRECT, standard word in the title (e.g. a wrong character or a wrongly-typed term must be corrected, never copied as-is).',
  'Be CONCISE: a short title, not a sentence or a full description.',
  'Reply with only the title on one line: plain text, no quotes, no prefix, no explanation, no Markdown, no code.',
  'Use the language of the messages (Chinese messages → Chinese title; English → English).',
  `Aim for about ${'{cjk}'} CJK characters for Chinese or ${'{words}'} words for other languages — short and descriptive, like a file name, not a paragraph.`,
].join('\n')

async function generateTitleWithCustomPrompt(ctx, config, request, selectedMessages) {
  if (selectedMessages.length === 0) throw new MoveError('at least one source message is required', 400)
  const system = TITLE_SYSTEM_PROMPT
    .replace('{cjk}', String(config.targetCjkCharacters))
    .replace('{words}', String(config.targetWords))
  const userText = `Generate the session title from this JSON array of human messages:\n${JSON.stringify(selectedMessages)}`
  const messages = [createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: 'dsh-session-move' },
  })]
  const options = {
    provider: request.route.provider,
    model: request.route.model,
    messages,
    system,
    maxTokens: config.maxOutputTokens,
    sessionId: request.session.id,
    purpose: 'session-title',
    signal: request.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    request.signal.throwIfAborted()
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish !== undefined && finish.kind !== 'stop' && finish.kind !== 'length') {
    throw new MoveError(`title generation failed: unexpected finish ${JSON.stringify(finish)}`, 500)
  }
  const blocks = assembler.blocks()
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
  if (text.trim().length === 0) throw new MoveError('title model produced no text', 500)
  const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new MoveError('title model produced no text', 500)
  return title
}

// --- http helpers ------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// --- plugin ------------------------------------------------------------------

export { moveSessionCore, deleteSessionCore, renameSessionWithAi }

function apply(ctx, config) {
  // Plugin row config: { renameAi?: { provider?, model?, targetWords?, ... } }
  // Cordis passes the plugin row's `config` as the SECOND apply argument (a
  // class- or function-plugin runtime callback); `ctx.config` is NOT an
  // injected service and must not be touched. Users can pin a model for the
  // AI-rename feature via the plugin row config without touching the source.
  const pluginConfig = (config && typeof config === 'object' && config.renameAi)
    ? config.renameAi
    : {}
  function registerHttp(host, targetCtx) {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__sessionmove/info',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        try {
          const workspaces = await readWorkspaces(ctx)
          const sessionId = String(req.url.split('?')[1] || '')
            .replace(/^sessionId=/, '')
            .trim()
          let currentWorkspaceId = null
          if (sessionId) {
            const dirs = findSessionDirs(sessionId)
            if (dirs.length > 0) {
              try {
                const { header } = await readSessionHeader(dirs[0])
                const ws = workspaces.find((w) => w.path === header.cwd)
                if (ws) currentWorkspaceId = ws.workspaceId
              } catch { /* header unreadable: no current workspace */ }
            }
          }
          sendJson(res, 200, {
            ok: true,
            workspaces: workspaces.map((w) => ({
              workspaceId: w.workspaceId,
              title: w.title,
              path: w.path,
            })),
            currentWorkspaceId,
          })
        } catch (e) {
          sendJson(res, 500, { error: e.message })
        }
      },
    }))

    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__sessionmove/move',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }
        const sessionId = String(args.sessionId || '').trim()
        const workspaceId = String(args.workspaceId || '').trim()
        if (!sessionId || !workspaceId) {
          sendJson(res, 400, { error: 'sessionId and workspaceId required' })
          return
        }
        try {
          const result = await moveSessionCore(ctx, sessionId, workspaceId)
          sendJson(res, 200, { ok: true, ...result })
        } catch (e) {
          const status = e instanceof MoveError ? e.status : 500
          sendJson(res, status, { error: e.message })
        }
      },
    }))
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__sessionmove/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }
        const sessionId = String(args.sessionId || '').trim()
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId required' })
          return
        }
        try {
          const result = await deleteSessionCore(ctx, sessionId)
          sendJson(res, 200, { ok: true, ...result })
        } catch (e) {
          const status = e instanceof MoveError ? e.status : 500
          sendJson(res, status, { error: e.message })
        }
      },
    }))
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/__sessionmove/rename-ai',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          sendJson(res, 400, { error: 'bad json body' })
          return
        }
        const sessionId = String(args.sessionId || '').trim()
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId required' })
          return
        }
        try {
          const result = await renameSessionWithAi(ctx, sessionId, pluginConfig)
          sendJson(res, 200, { ok: true, ...result })
        } catch (e) {
          const status = e instanceof MoveError ? e.status : 500
          sendJson(res, status, { error: e.message })
        }
      },
    }))
  }

  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttp(ws, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => {
      registerHttp(sub.webServer, sub)
    })
  }

  ctx.tools.register(defineTool({
    name: 'workbench_session_move',
    description: 'Move one session to another workspace (folder) of this workbench: stops the agent if it is running, rewrites the session header cwd, moves the persisted log directory to the target folder slug, and re-accounts the session under the target workspace. The session will henceforth work in the target directory.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to move (uuid or session-<uuid> form).',
      },
      workspaceId: {
        type: 'string',
        required: true,
        description: 'The target workspace id (list with workspace.list or the /__sessionmove/info endpoint).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args.sessionId || '').trim()
      const workspaceId = String(args.workspaceId || '').trim()
      try {
        const result = await moveSessionCore(ctx, sessionId, workspaceId)
        return [
          `moved: ${result.moved ? 'yes' : 'no-op'}`,
          `session: ${result.sessionId}`,
          `old cwd: ${result.oldCwd}`,
          `new cwd: ${result.newCwd}`,
          `old workspace: ${result.oldWorkspaceId ?? '(none)'}`,
          `new workspace: ${result.newWorkspaceId}`,
        ].join('\n')
      } catch (e) {
        return `move failed: ${e.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workbench_session_delete',
    description: 'Permanently delete one session of this workbench: stops the agent if it is running (cancel + quiescence), then removes its persisted log directory, projection-cache row and workspace accounting. The client reloads after a successful delete.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to delete (uuid or session-<uuid> form).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args.sessionId || '').trim()
      try {
        const result = await deleteSessionCore(ctx, sessionId)
        return [
          `deleted: ${sessionId}`,
          `log dir removed: ${result.dirRemoved}`,
          `projection row removed: ${result.projRemoved}`,
          `workspace accounting removed: ${result.workspaceRemoved}`,
        ].join('\n')
      } catch (e) {
        return `delete failed: ${e.message}`
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'workbench_session_rename_ai',
    description: 'AI-rename one session of this workbench: the LLM summarizes the conversation (user messages) into a concise title and applies it through the session title service. Uses the session\'s own model route by default; a provider/model can be pinned in the plugin config.',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'The session id to rename (uuid or session-<uuid> form).',
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: value }] },
    },
    async execute(args) {
      const sessionId = String(args.sessionId || '').trim()
      try {
        const result = await renameSessionWithAi(ctx, sessionId, pluginConfig)
        return [
          `renamed: ${result.sessionId}`,
          `new title: ${result.title}`,
        ].join('\n')
      } catch (e) {
        return `rename failed: ${e.message}`
      }
    },
  }))
}

export { apply, inject, name }
