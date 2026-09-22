import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTelegramOwnerChatIds } from '../../src/config.js';
import { resolveOwnerChatIds, isOwnerContext } from '../../src/telegram/bot.js';

test('parseTelegramOwnerChatIds: empty / invalid', () => {
  assert.deepEqual(parseTelegramOwnerChatIds(''), []);
  assert.deepEqual(parseTelegramOwnerChatIds('   '), []);
  assert.deepEqual(parseTelegramOwnerChatIds('abc'), []);
  assert.deepEqual(parseTelegramOwnerChatIds(',,'), []);
});

test('parseTelegramOwnerChatIds: single id', () => {
  assert.deepEqual(parseTelegramOwnerChatIds('1366010187'), [1366010187]);
  assert.deepEqual(parseTelegramOwnerChatIds(' 1366010187 '), [1366010187]);
});

test('parseTelegramOwnerChatIds: comma-separated allowlist', () => {
  assert.deepEqual(parseTelegramOwnerChatIds('1366010187,1773932361'), [1366010187, 1773932361]);
  assert.deepEqual(parseTelegramOwnerChatIds('1366010187, 1773932361 ,1366010187'), [1366010187, 1773932361]);
  assert.deepEqual(parseTelegramOwnerChatIds('1366010187,bad,1773932361'), [1366010187, 1773932361]);
});

test('resolveOwnerChatIds prefers ownerChatIds array', () => {
  assert.deepEqual(resolveOwnerChatIds({ ownerChatId: 1, ownerChatIds: [2, 3] }), [2, 3]);
  assert.deepEqual(resolveOwnerChatIds({ ownerChatId: 1 }), [1]);
  assert.deepEqual(resolveOwnerChatIds({}), []);
});

test('isOwnerContext: multi-owner allowlist', () => {
  const owners = [1366010187, 1773932361];
  assert.equal(isOwnerContext({ chat: { id: 1366010187 }, from: { id: 1366010187 } }, owners), true);
  assert.equal(isOwnerContext({ chat: { id: 1773932361 }, from: { id: 1773932361 } }, owners), true);
  assert.equal(isOwnerContext({ chat: { id: 999 }, from: { id: 1773932361 } }, owners), true);
  assert.equal(isOwnerContext({ chat: { id: 999 }, from: { id: 888 } }, owners), false);
  assert.equal(isOwnerContext({ chat: { id: 999 }, from: { id: 888 } }, []), false);
});
