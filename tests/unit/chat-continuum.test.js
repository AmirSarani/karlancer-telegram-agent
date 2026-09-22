import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/memory/db.js';
import { createRoomState } from '../../src/agent/room-state.js';
import { createAgentSettingsStore, CHAT_AI_MODES, defaultAgentSettings } from '../../src/telegram/agent-settings.js';
import { createChatContinuum } from '../../src/agent/chat-continuum.js';
import { suggestChatPrice } from '../../src/agent/chat-price.js';
import { createPermissionGate } from '../../src/telegram/permission-gate.js';
import { chatAiModeLabelFa, parseCallbackData } from '../../src/telegram/ui.js';
import { parseRoomCallback, roomPickKeyboard } from '../../src/telegram/room-card.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-ai-'));
  return openDb(path.join(dir, 't.sqlite'));
}

const sampleCard = {
  roomId: '7',
  guestName: 'رضا',
  draftText: 'سلام',
  messages: [{ text: 'سلام، هزینه چقدر؟', isOwn: false }],
  project: { title: 'وب‌اپ', minBudget: 8_000_000, maxBudget: 15_000_000 },
};

test('CHAT_AI_MODES defaults to full_manual', () => {
  assert.deepEqual(CHAT_AI_MODES, ['full_manual', 'pick_to_answer', 'full_auto']);
  assert.equal(defaultAgentSettings().chatAiMode, 'full_manual');
});

test('settings store persists chatAiMode', () => {
  const db = tmpDb();
  const store = createAgentSettingsStore(db);
  store.setChatAiMode('pick_to_answer');
  assert.equal(createAgentSettingsStore(db).get().chatAiMode, 'pick_to_answer');
});

test('thread memory markAnswered + continuum phase', () => {
  const db = tmpDb();
  const rs = createRoomState(db);
  rs.setDraft('7', { text: 'پاسخ' });
  rs.markAnswered('7', { lastSentText: 'پاسخ' });
  assert.equal(rs.getThread('7').phase, 'answered');
  assert.deepEqual(rs.listAnsweredRoomIds(), ['7']);
  rs.touchInbound('7');
  assert.equal(rs.getThread('7').phase, 'active_thread');
});

test('suggestChatPrice from project budget', () => {
  const p = suggestChatPrice({ minBudget: 10_000_000, maxBudget: 20_000_000 });
  assert.ok(p.amount > 0);
  assert.ok(p.labelFa.includes('تومان'));
  assert.equal(p.includeInDraft, false);
});

test('continuum full_manual notifies only', async () => {
  const db = tmpDb();
  const roomState = createRoomState(db);
  createAgentSettingsStore(db).setChatAiMode('full_manual');
  const c = createChatContinuum({ db, roomState, llm: null, gate: null, mutations: null });
  const out = await c.processInboundCard(sampleCard);
  assert.equal(out.continuumAction, 'notify_only');
  assert.equal(out.pickPrompt, false);
});

test('continuum pick_to_answer builds pick card', async () => {
  const db = tmpDb();
  const roomState = createRoomState(db);
  createAgentSettingsStore(db).setChatAiMode('pick_to_answer');
  const c = createChatContinuum({ db, roomState, llm: null, gate: createPermissionGate(db), mutations: null });
  const out = await c.processInboundCard(sampleCard);
  assert.equal(out.continuumAction, 'pick_to_answer');
  assert.equal(out.pickPrompt, true);
  assert.ok(out.draftText);
  assert.ok(out.suggestedPrice);
});

test('continuum full_auto respects gate → HITL without live flag', async () => {
  const db = tmpDb();
  const roomState = createRoomState(db);
  const store = createAgentSettingsStore(db);
  store.setChatAiMode('full_auto');
  store.setMode('auto');
  store.setToggle('autoReplyMessages', true);
  const c = createChatContinuum({
    db,
    roomState,
    llm: null,
    gate: createPermissionGate(db),
    mutations: null,
    getAllowLiveAutoSend: () => false,
  });
  const out = await c.processInboundCard(sampleCard);
  assert.equal(out.continuumAction, 'auto_hitl');
  assert.equal(out.pickPrompt, true);
});

test('UI + room pick callbacks', () => {
  assert.equal(chatAiModeLabelFa('pick_to_answer').includes('انتخابی'), true);
  assert.equal(parseCallbackData('chatmode:full_auto').type, 'set_chat_ai_mode');
  assert.equal(parseCallbackData('goto:answered').type, 'goto_answered');
  assert.equal(parseRoomCallback('room:pick:99').type, 'room_pick');
  assert.ok(roomPickKeyboard(99).inline_keyboard.flat().some((b) => /جواب/.test(b.text)));
});
