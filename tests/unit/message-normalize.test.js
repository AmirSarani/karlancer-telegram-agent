import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtml,
  extractProjectSlug,
  extractAttachments,
  normalizeInboundMessage,
  dedupeMessages,
  roomNeedsFetch,
} from '../../src/agent/message-normalize.js';

test('stripHtml removes tags and keeps text', () => {
  assert.equal(stripHtml('<p>سلام<br>دنیا</p>'), 'سلام\nدنیا');
  assert.equal(stripHtml('a &amp; b'), 'a & b');
});

test('extractProjectSlug from html link', () => {
  const html =
    'پروژه: <a href="https://www.karlancer.com/projects/%D8%A7%D8%B3%D8%AA%D8%AE%D8%B1%D8%A7%D8%AC-206e">لینک</a>';
  const slug = extractProjectSlug(html);
  assert.ok(slug);
  assert.match(slug, /206e|استخراج/);
});

test('extractAttachments from raw files array', () => {
  const atts = extractAttachments({
    files: [{ url: 'https://cdn.example.com/a.png', name: 'pic' }],
  });
  assert.equal(atts.length, 1);
  assert.equal(atts[0].kind, 'photo');
  assert.equal(atts[0].name, 'pic');
});

test('normalizeInboundMessage strips html and sets fields', () => {
  const m = normalizeInboundMessage({
    id: 99,
    message: '<b>hello</b> /projects/foo-bar',
    is_me: false,
    created_at: '2026-09-20T00:00:00Z',
  });
  assert.equal(m.id, '99');
  assert.equal(m.text, 'hello /projects/foo-bar');
  assert.equal(m.isOwn, false);
  assert.equal(m.projectSlug, 'foo-bar');
});

test('dedupeMessages skips known ids', () => {
  const { fresh, seen } = dedupeMessages(
    [
      { id: '1', text: 'a' },
      { id: '2', text: 'b' },
      { id: '1', text: 'a2' },
    ],
    ['1']
  );
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].id, '2');
  assert.ok(seen.has('1') && seen.has('2'));
});

test('roomNeedsFetch unread or newer updatedAt', () => {
  assert.equal(roomNeedsFetch({ unread: 1, updatedAt: '2020-01-01' }, { lastUpdatedAt: '2026-01-01' }), true);
  assert.equal(
    roomNeedsFetch({ unread: 0, updatedAt: '2026-09-20T12:00:00Z' }, { lastUpdatedAt: '2026-09-19T12:00:00Z' }),
    true
  );
  assert.equal(
    roomNeedsFetch({ unread: 0, updatedAt: '2026-09-18T12:00:00Z' }, { lastUpdatedAt: '2026-09-19T12:00:00Z' }),
    false
  );
  assert.equal(roomNeedsFetch({ unread: 0, updatedAt: '2026-09-20' }, null), true);
});
