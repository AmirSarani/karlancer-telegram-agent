/**
 * Playwright stubs for driving karlancer.com.
 *
 * TODOs (port from Chrome extension / reverse DOM+API):
 * - Login: open karlancer.com, manual login once, save storageState to KARLANCER_STORAGE_STATE_PATH
 * - Invitations list: replicate extension API calls or DOM scrape of همکاری/دعوت‌ها
 * - Project page: read description, budget, attachments
 * - Bid form: fill proposal textarea + price/days (HITL via Telegram /approve)
 * - Messages/rooms: gotoMessages(roomId), read new employer messages, draft reply
 * - Anti-detect: human-like delays, reuse real Chrome profile / storageState
 *
 * This module does NOT automate login or send bids in MVP — stubs only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Lazy import so `npm start` works even before playwright browsers are installed. */
async function getPlaywright() {
  const pw = await import('playwright');
  return pw.chromium;
}

/**
 * @typedef {object} KarlancerBrowserOptions
 * @property {string} storageStatePath
 * @property {boolean} [headless]
 * @property {string} [baseUrl]
 */

export class KarlancerBrowser {
  /**
   * @param {KarlancerBrowserOptions} options
   */
  constructor(options) {
    this.storageStatePath = options.storageStatePath;
    this.headless = options.headless !== false;
    this.baseUrl = options.baseUrl || 'https://www.karlancer.com';
    /** @type {import('playwright').Browser|null} */
    this.browser = null;
    /** @type {import('playwright').BrowserContext|null} */
    this.context = null;
    /** @type {import('playwright').Page|null} */
    this.page = null;
  }

  /**
   * Launch Chromium with optional saved storage state (cookies/session).
   * @returns {Promise<import('playwright').Page>}
   */
  async launch() {
    const chromium = await getPlaywright();
    this.browser = await chromium.launch({ headless: this.headless });

    const contextOpts = {
      viewport: { width: 1280, height: 800 },
      locale: 'fa-IR',
    };

    try {
      await fs.access(this.storageStatePath);
      contextOpts.storageState = this.storageStatePath;
      console.log('[browser] using storage state', this.storageStatePath);
    } catch {
      console.warn(
        '[browser] no storage state yet — login manually later and save to',
        this.storageStatePath
      );
    }

    this.context = await this.browser.newContext(contextOpts);
    this.page = await this.context.newPage();
    return this.page;
  }

  /**
   * Navigate toward messages / a specific room.
   * TODO: confirm real route from extension (e.g. /messages, /dashboard/chats, room query).
   * @param {string|number} [roomId]
   */
  async gotoMessages(roomId) {
    if (!this.page) throw new Error('Browser not launched. Call launch() first.');
    // Stub URLs — replace after inspecting karlancer.com + extension network tab
    const url =
      roomId != null
        ? `${this.baseUrl}/messages?room=${encodeURIComponent(String(roomId))}`
        : `${this.baseUrl}/messages`;
    console.log('[browser] gotoMessages stub →', url);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.page;
  }

  /**
   * Capture a screenshot for Telegram HITL review.
   * @param {string} [outPath]
   * @returns {Promise<string>} absolute path of screenshot
   */
  async screenshot(outPath) {
    if (!this.page) throw new Error('Browser not launched. Call launch() first.');
    const dest =
      outPath ||
      path.resolve(
        path.dirname(this.storageStatePath),
        '..',
        'screenshots',
        `karlancer-${Date.now()}.png`
      );
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await this.page.screenshot({ path: dest, fullPage: true });
    console.log('[browser] screenshot →', dest);
    return dest;
  }

  /**
   * Helper for one-time manual login flow (documented in README).
   * Opens homepage; caller logs in in headed mode, then we save storage state.
   */
  async saveStorageStateAfterManualLogin() {
    if (!this.context) throw new Error('Browser not launched.');
    await fs.mkdir(path.dirname(this.storageStatePath), { recursive: true });
    await this.context.storageState({ path: this.storageStatePath });
    console.log('[browser] storage state saved →', this.storageStatePath);
    return this.storageStatePath;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

export default KarlancerBrowser;
