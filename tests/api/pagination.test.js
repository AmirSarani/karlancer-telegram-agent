import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePagination, extractLaravelPage } from '../../src/api/util/pagination.js';

test('normalizePagination detects hasMore', () => {
  const page = normalizePagination({ current_page: 1, last_page: 3, per_page: 20, total: 55 });
  assert.equal(page.currentPage, 1);
  assert.equal(page.hasMore, true);
});

test('extractLaravelPage reads data.data', () => {
  const { items, pagination } = extractLaravelPage({
    status: 'success',
    data: { current_page: 2, last_page: 2, per_page: 10, total: 12, data: [{ id: 1 }, { id: 2 }] },
  });
  assert.equal(items.length, 2);
  assert.equal(pagination.currentPage, 2);
  assert.equal(pagination.hasMore, false);
});
