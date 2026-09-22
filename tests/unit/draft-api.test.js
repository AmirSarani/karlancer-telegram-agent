import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftReply } from '../../src/agent/draft-api.js';
import { mergeNoteIntoDraft, createRoomState } from '../../src/agent/room-state.js';
import { adaptDraftWithNote } from '../../src/agent/analyze-llm.js';
import { cleanHumanReply } from '../../src/agent/reply-clean.js';
import { openDb } from '../../src/memory/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('buildDraftReply is deterministic human template without LLM', () => {
  const ctx = {
    roomId: 1,
    guestName: 'علی',
    project: { title: 'ربات تلگرام', minBudget: 100, maxBudget: 200, jobDuration: 7, isFulltime: false },
    messages: [{ text: 'نیاز به ربات دارم', isOwn: false }],
  };
  const a = buildDraftReply(ctx);
  const b = buildDraftReply(ctx);
  assert.equal(a.text, b.text);
  assert.equal(a.source, 'template');
  assert.match(a.text, /علی/);
  // Must sound human — no title dump / robotic wrappers
  assert.doesNotMatch(a.text, /پروژه\s*[«"']/);
  assert.doesNotMatch(a.text, /با توجه به درخواستتان/);
  assert.doesNotMatch(a.text, /آماده‌?ام همکاری کنم/);
  assert.doesNotMatch(a.text, /می‌باشد/);
  assert.match(a.text, /سلام/);
  assert.match(a.text, /متوجه|خواندم|مرور/);
});

test('buildDraftReply does not auto-price unless asked', () => {
  const silent = buildDraftReply({
    guestName: 'ب',
    proposal: { price: 5_000_000, days: 3 },
    messages: [{ text: 'سلام پروژه را ببینید', isOwn: false }],
  });
  assert.doesNotMatch(silent.text, /۵|5|تومان|هزینه/);

  const asked = buildDraftReply({
    guestName: 'ب',
    includePrice: true,
    proposal: { price: 5_000_000 },
    messages: [{ text: 'قیمت چقدر است؟', isOwn: false }],
  });
  assert.match(asked.text, /تومان|هزینه|پیشنهاد/);
});

test('cleanHumanReply strips robotic wrappers and tech leaks', () => {
  const raw = [
    'سلام.',
    'پروژه «ساخت سایت» را دیدم.',
    'با توجه به درخواستتان («لطفاً فوری») آماده‌ام همکاری کنم.',
    'راهکار ما می‌باشد.',
    'blocked_by_missing_api roomId=99',
    'Bearer SECRETTOKEN',
  ].join('\n');
  const out = cleanHumanReply(raw);
  assert.doesNotMatch(out, /پروژه «/);
  assert.doesNotMatch(out, /با توجه به درخواستتان/);
  assert.doesNotMatch(out, /آماده‌ام همکاری/);
  assert.doesNotMatch(out, /می‌باشد/);
  assert.doesNotMatch(out, /blocked_by_missing_api|roomId|SECRETTOKEN/);
  assert.match(out, /سلام/);
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
