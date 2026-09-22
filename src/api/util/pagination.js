/**
 * Laravel-style pagination helpers (Karlancer API).
 * Never trusts naked absolute URLs from upstream for follow-up fetches.
 */

/**
 * @param {object} [meta]
 * @param {{ page?: number, fallbackTotal?: number }} [opts]
 */
export function normalizePagination(meta = {}, opts = {}) {
  const page = opts.page != null ? Number(opts.page) : undefined;
  return {
    currentPage: meta.current_page ?? meta.currentPage ?? page ?? null,
    lastPage: meta.last_page ?? meta.lastPage ?? meta.total_pages ?? null,
    perPage: meta.per_page ?? meta.perPage ?? null,
    total: meta.total ?? opts.fallbackTotal ?? null,
    from: meta.from ?? null,
    to: meta.to ?? null,
    hasMore:
      meta.next_page_url != null ||
      (meta.current_page != null &&
        meta.last_page != null &&
        Number(meta.current_page) < Number(meta.last_page)) ||
      false,
  };
}

/**
 * Extract list + pagination from common Karlancer envelopes.
 * @param {object} payload
 * @param {string[]} [listKeys]
 */
export function extractLaravelPage(payload, listKeys = ['data']) {
  const root = payload?.data ?? payload ?? {};
  let list = null;
  let meta = root;
  if (Array.isArray(root)) {
    list = root;
    meta = payload ?? {};
  } else if (Array.isArray(root.data)) {
    list = root.data;
    meta = root;
  } else {
    for (const k of listKeys) {
      if (Array.isArray(root[k])) {
        list = root[k];
        meta = root;
        break;
      }
      if (root[k] && Array.isArray(root[k].data)) {
        list = root[k].data;
        meta = root[k];
        break;
      }
    }
  }
  return {
    items: Array.isArray(list) ? list : [],
    pagination: normalizePagination(meta, { fallbackTotal: Array.isArray(list) ? list.length : 0 }),
  };
}

/**
 * Build a page iterator callback without loading all pages eagerly.
 * @param {(page: number) => Promise<{ items: any[], pagination: object }>} fetchPage
 * @param {{ maxPages?: number, startPage?: number }} [opts]
 */
export async function* iteratePages(fetchPage, opts = {}) {
  const maxPages = opts.maxPages ?? 20;
  let page = opts.startPage ?? 1;
  for (let i = 0; i < maxPages; i++) {
    const result = await fetchPage(page);
    yield result;
    if (!result?.pagination?.hasMore) return;
    if (result.pagination.lastPage != null && page >= result.pagination.lastPage) return;
    page += 1;
  }
}
