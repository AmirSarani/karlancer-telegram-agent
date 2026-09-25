/**
 * Phase D — scheduled win detection (~every 10 min).
 *
 * Sources: notifications (win phrases) + status of projects we bid on (assigned freelancer == us).
 * Dedupe in kv, persist post-win state, prepare the first client message as an owner approval
 * (always HITL: mutation requester with forceRequireApproval → «تأییدها»). Never auto-sends.
 */
import { scanNotificationsForWins, advancePostWin, createPostWinState } from '../opportunity/post-win.js';
import { getOwnUserId } from './own-identity.js';
import { logger } from '../observability/logger.js';

const SEEN_KEY = 'postwin:seen';
const LATEST_KEY = 'postwin:latest';
const CURSOR_KEY = 'postwin:project_cursor';
const BASELINE_WINDOW_MS = 24 * 3_600_000;
const BID_LOOKBACK_MS = 30 * 86_400_000;

function kvRead(db, key) {
  try {
    const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function kvWrite(db, key, value) {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), new Date().toISOString());
}

function hashKey(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}

export function getLatestPostWin(db) {
  return kvRead(db, LATEST_KEY);
}

/** Project ids we submitted bids on recently (successful bids.submit jobs). */
export function recentBidProjectIds(db, { now = Date.now(), limit = 50 } = {}) {
  const since = new Date(now - BID_LOOKBACK_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT payload_json FROM jobs WHERE goal = 'bids.submit' AND status = 'succeeded' AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(since, limit);
  const ids = [];
  for (const r of rows) {
    try {
      const pid = JSON.parse(r.payload_json || '{}').projectId;
      if (pid != null && !ids.includes(String(pid))) ids.push(String(pid));
    } catch {
      /* ignore */
    }
  }
  return ids;
}

/**
 * @param {object} deps
 * @returns {Promise<{ ok: boolean, wins: object[], checked: { notifications: number, projects: number }, baseline?: boolean }>}
 */
export async function runWinWatch(deps) {
  const { db, api, roomState = null, mutations = null, now = Date.now(), maxProjectChecks = 5 } = deps;
  const seenState = kvRead(db, SEEN_KEY);
  const baseline = !seenState;
  const seen = new Set(Array.isArray(seenState?.keys) ? seenState.keys : []);
  const candidates = [];
  const checked = { notifications: 0, projects: 0 };

  // 1) Notifications
  if (api?.notifications?.list) {
    try {
      const listed = await api.notifications.list({ page: 1 });
      const list = listed.notifications || [];
      checked.notifications = list.length;
      for (const w of scanNotificationsForWins(list).wins) {
        const n = w.notification || {};
        const key = `n:${n.id || hashKey(`${n.title}|${n.body}`)}`;
        if (seen.has(key)) continue;
        const created = Date.parse(n.createdAt || '');
        // First run: don't replay old wins; only the last 24h are pushed.
        const fresh = !baseline || (Number.isFinite(created) && now - created <= BASELINE_WINDOW_MS);
        candidates.push({
          key,
          notify: fresh,
          source: 'notification',
          projectId: w.state.projectId,
          roomId: w.state.roomId,
          title: n.title || null,
          reasons: w.state.reasons,
        });
      }
    } catch (e) {
      logger.warn('win_watch_notifications_failed', { err: e.message });
    }
  }

  // 2) Status of projects we bid on (rotating, a few per run)
  if (api?.projects?.get) {
    const ids = recentBidProjectIds(db, { now }).filter((id) => !seen.has(`p:${id}`));
    if (ids.length) {
      let ownId = null;
      try {
        ownId = await getOwnUserId({ api, db });
      } catch {
        ownId = null;
      }
      if (ownId) {
        const cursor = Number(kvRead(db, CURSOR_KEY)?.i) || 0;
        const slice = [];
        for (let k = 0; k < Math.min(maxProjectChecks, ids.length); k++) slice.push(ids[(cursor + k) % ids.length]);
        kvWrite(db, CURSOR_KEY, { i: (cursor + slice.length) % Math.max(1, ids.length) });
        for (const pid of slice) {
          try {
            const { project } = await api.projects.get(pid);
            checked.projects += 1;
            if (project?.freelancerId != null && String(project.freelancerId) === String(ownId)) {
              candidates.push({
                key: `p:${pid}`,
                notify: true,
                source: 'project_status',
                projectId: pid,
                roomId: null,
                title: project.title || null,
                reasons: ['project_assigned_to_us'],
              });
            }
          } catch (e) {
            logger.warn('win_watch_project_failed', { projectId: pid, err: e.message });
          }
        }
      }
    }
  }

  // Merge duplicates (same project from both sources)
  const byProject = new Map();
  const unique = [];
  for (const c of candidates) {
    if (c.projectId && byProject.has(c.projectId)) {
      seen.add(c.key);
      continue;
    }
    if (c.projectId) byProject.set(c.projectId, c);
    unique.push(c);
  }

  const wins = [];
  for (const c of unique) {
    seen.add(c.key);
    if (c.projectId) seen.add(`p:${c.projectId}`);
    if (!c.notify) continue;
    const win = await prepareWin({ db, api, roomState, mutations, c });
    wins.push(win);
  }

  kvWrite(db, SEEN_KEY, { keys: [...seen].slice(-500), at: new Date(now).toISOString() });
  return { ok: true, wins, checked, baseline };
}

async function resolveRoom({ api, roomState, projectId }) {
  if (!projectId) return null;
  if (roomState) {
    for (const id of roomState.listPendingRoomIds?.() || []) {
      const card = roomState.getCard(id);
      if (card?.project?.id != null && String(card.project.id) === String(projectId)) {
        return { roomId: String(id), guestName: card.guestName || null, clientUserId: card.clientUserId || null };
      }
    }
  }
  if (api?.rooms?.list) {
    try {
      const { rooms } = await api.rooms.list({ page: 1 });
      const r = (rooms || []).find((x) => {
        const pid = x?.raw?.project_id ?? x?.raw?.projectId ?? x?.raw?.project?.id;
        return pid != null && String(pid) === String(projectId);
      });
      if (r) return { roomId: String(r.id), guestName: r.guestName || r.title || null, clientUserId: r.userId || null };
    } catch {
      /* soft */
    }
  }
  return null;
}

async function prepareWin({ db, api, roomState, mutations, c }) {
  let room = c.roomId ? { roomId: String(c.roomId), guestName: roomState?.getCard(c.roomId)?.guestName || null } : null;
  if (!room) room = await resolveRoom({ api, roomState, projectId: c.projectId });
  const state = advancePostWin(
    createPostWinState({ phase: 'DETECTED', projectId: c.projectId, roomId: room?.roomId || null, reasons: c.reasons }),
    { guestName: room?.guestName, projectTitle: c.title }
  );
  let approval = null;
  if (room?.roomId && mutations) {
    try {
      const out = mutations.request({
        action: 'messages.send',
        payload: {
          roomId: room.roomId,
          text: state.draftText,
          risk: 'high',
          postWin: true,
          aiReason: 'پیام اول پس از برد پروژه',
          ...(room.clientUserId ? { receptorId: String(room.clientUserId) } : {}),
        },
        gateCtx: { source: 'post_win', roomId: room.roomId, text: state.draftText, riskHint: 'high' },
        requestedBy: 'post_win',
        targetRef: room.roomId,
        forceRequireApproval: true,
        idempotencyKey: `postwin:${c.key}`,
      });
      approval = out.pendingApproval ? { approvalId: out.approval?.approval_id || null } : { status: out.denied ? 'denied' : 'error' };
      if (roomState) roomState.setDraft(room.roomId, { text: state.draftText, source: 'post_win' });
    } catch (e) {
      logger.warn('win_watch_approval_failed', { err: e.message });
    }
  }
  const record = {
    key: c.key,
    source: c.source,
    projectId: c.projectId || null,
    roomId: room?.roomId || null,
    guestName: room?.guestName || null,
    title: c.title || null,
    phase: state.phase,
    draftText: state.draftText,
    approval,
    detectedAt: state.detectedAt,
  };
  kvWrite(db, `postwin:state:${c.key}`, record);
  kvWrite(db, LATEST_KEY, record);
  return record;
}

/**
 * Persian owner notice for a detected win (Telegram + Bale).
 */
export function formatWinNotice(win = {}) {
  const lines = ['🏆 تبریک! به نظر می‌رسد پروژه را برده‌اید.'];
  if (win.title) lines.push(`• ${String(win.title).slice(0, 120)}`);
  if (win.guestName) lines.push(`• کارفرما: ${String(win.guestName).slice(0, 40)}`);
  lines.push('', '📝 پیش‌نویس پیام اول به کارفرما:', String(win.draftText || '').slice(0, 900), '');
  if (win.approval?.approvalId) {
    lines.push('این پیام بدون تأیید شما ارسال نمی‌شود. از «✅ تأییدها» تأیید یا ویرایش کنید.');
  } else if (win.roomId) {
    lines.push('از «💬 گفتگوها» پیش‌نویس را ببینید و در صورت تمایل ارسال کنید.');
  } else {
    lines.push('گفتگوی این پروژه را پیدا نکردم؛ متن بالا را در گفتگوی کارفرما استفاده کنید.');
  }
  return lines.join('\n');
}

export default { runWinWatch, formatWinNotice, getLatestPostWin, recentBidProjectIds };
