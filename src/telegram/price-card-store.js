/**
 * Item 4: remember where the merged «💰 چه قیمتی بدهم؟» card was sent (per owner chat, all parts),
 * so after the owner sets/accepts a price the SAME card is edited into the final draft for approval.
 */
const key = (roomId) => `pricecard:${roomId}`;
const MAX_AGE_MS = 7 * 86_400_000;

export function getPriceCardMessages(db, roomId) {
  if (!db || roomId == null) return [];
  try {
    const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key(roomId));
    const v = row?.value ? JSON.parse(row.value) : null;
    if (!v || !Array.isArray(v.items)) return [];
    if (Number(v.at) && Date.now() - Number(v.at) > MAX_AGE_MS) return [];
    return v.items.filter((x) => x && x.chatId != null && Array.isArray(x.messageIds) && x.messageIds.length);
  } catch {
    return [];
  }
}

function write(db, roomId, items) {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key(roomId), JSON.stringify({ items, at: Date.now() }), new Date().toISOString());
}

/** @param {{ chatId, messageIds: number[] }[]} deliveries */
export function savePriceCardMessages(db, roomId, deliveries = []) {
  if (!db || roomId == null) return;
  const items = (deliveries || []).filter((d) => d && d.chatId != null && d.messageIds?.length);
  if (items.length) write(db, roomId, items.map((d) => ({ chatId: d.chatId, messageIds: d.messageIds.map(Number) })));
}

/** The owner pressed a price button on some card message: make sure that message is edited too. */
export function addPriceCardMessage(db, roomId, chatId, messageId) {
  if (!db || roomId == null || chatId == null || messageId == null) return;
  const items = getPriceCardMessages(db, roomId);
  const hit = items.find((x) => String(x.chatId) === String(chatId));
  if (hit) {
    if (hit.messageIds.map(String).includes(String(messageId))) return;
    // A different message in this chat (e.g. opened from the chats list): track it alone.
    hit.messageIds = [Number(messageId)];
  } else items.push({ chatId, messageIds: [Number(messageId)] });
  write(db, roomId, items);
}

export function clearPriceCardMessages(db, roomId) {
  if (!db || roomId == null) return;
  try {
    db.prepare(`DELETE FROM kv WHERE key = ?`).run(key(roomId));
  } catch {
    /* ignore */
  }
}
