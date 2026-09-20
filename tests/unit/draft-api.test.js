import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftReply } from '../../src/agent/draft-api.js';
import { mergeNoteIntoDraft, createRoomState } from '../../src/agent/room-state.js';
import { adaptDraftWithNote } from '../../src/agent/analyze-llm.js';
import { openDb } from '../../src/memory/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('buildDraftReply is deterministic template without LLM', () => {
  const a = buildDraftReply({
    roomId: 1,
    guestName: 'علی',
    project: { title: 'ربات تلگرام', minBudget: 100, maxBudget: 200, jobDuration: 7, isFulltime: false },
    messages: [{ text: 'نیاز به ربات دارم', isOwn: false }],
  });
  const b = buildDraftReply({
    roomId: 1,
    guestName: 'علی',
    project: { title: 'ربات تلگرام', minBudget: 100, maxBudget: 200, jobDuration: 7, isFulltime: false },
    messages: [{ text: 'نیاز به ربات دارم', isOwn: false }],
  });
  assert.equal(a.text, b.text);
  assert.equal(a.source, 'template');
  assert.match(a.text, /علی/);
  assert.match(a.text, /ربات تلگرام/);
});

test('mergeNoteIntoDraft appends owner note', () => {
  const m = mergeNoteIntoDraft({ text: 'پایه' }, 'قیمت را کمتر بگو');
  assert.match(m.text, /پایه/);
  assert.match(m.text, /قیمت را کمتر بگو/);
  assert.equal(m.source, 'template+note');
});

test('adaptDraftWithNote falls back without llm', async () => {
  const out = await adaptDraftWithNote({
    roomContext: { guestName: 'ب' },
    currentDraft: 'سلام',
    ownerNote: 'مودب‌تر باش',
    llm: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.llmUsed, false);
  assert.match(out.text, /مودب/);
});

test('room-state cursor dedupe persist in sqlite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-state-'));
  const db = openDb(path.join(dir, 't.sqlite'));
  const rs = createRoomState(db);
  rs.setCursor('7241431', { lastUpdatedAt: '2026-09-20T10:00:00Z', lastMessageId: '1' });
  assert.equal(rs.getCursor('7241431').lastMessageId, '1');
  rs.addSeenIds('7241431', ['10', '11']);
  assert.ok(rs.getSeenIds('7241431').has('10'));
  rs.setDraft('7241431', { text: 'hi', source: 'template' });
  assert.equal(rs.getDraft('7241431').text, 'hi');
  rs.setDecision('7241431', { status: 'pending' });
  assert.ok(rs.listPendingRoomIds().includes('7241431'));
  rs.setDecision('7241431', { status: 'rejected' });
  assert.ok(!rs.listPendingRoomIds().includes('7241431'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
