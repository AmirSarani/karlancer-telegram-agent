/**
 * File helpers — metadata-safe.
 * HAR shows public SEO assets under /api/file/seoContents/... and POST /api/publics/file.
 * We never return private storage URLs for arbitrary download.
 */
import { normalizeFileMeta } from '../models/project.js';
import { KarlancerApiError } from '../errors.js';

export function createFilesAdapter(client) {
  return {
    /** Describe a known public seoContents path (no auth). */
    async publicSeoMeta(pathOrName) {
      const name = String(pathOrName || '').replace(/^.*\//, '');
      if (!name || name.includes('..') || name.includes('/')) {
        throw new KarlancerApiError('invalid_input', 'unsafe file name');
      }
      return {
        kind: 'public_seo',
        name,
        pathHint: `/api/file/seoContents/${name}`,
        note: 'Public marketing/SEO asset path only — not a private attachment download API',
      };
    },

    /** Normalize attachment metadata from project/message payloads. */
    normalize(meta) {
      return normalizeFileMeta(meta);
    },
  };
}
