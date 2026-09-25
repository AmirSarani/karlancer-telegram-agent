/**
 * Wire control-panel screens into the Telegram bot (thin façades over adapters).
 */
import { writeEnvKey } from '../security/persist-access-token.js';
import {
  CP,
  controlHubKeyboard,
  eyesMenuKeyboard,
  brainMenuKeyboard,
  handsMenuKeyboard,
  securityMenuKeyboard,
  notifMenuKeyboard,
  liveAutoConfirmKeyboard,
  limitsKeyboard,
  blacklistKeyboard,
  formatControlHub,
  formatSystemOverview,
  formatEyesMenu,
  formatBrainMenu,
  formatHandsMenu,
  formatDashboardSummary,
  formatProfileCard,
  formatNotificationsCard,
  formatBookmarksCard,
  formatPlansCard,
  formatProjectSearchPrompt,
  formatProjectSearchResults,
  formatSeoMetaPrompt,
  formatSeoMetaCard,
  formatDecisionHistory,
  formatLiveAutoCard,
  formatLiveAutoWarningConfirm,
  formatLimitsCard,
  formatBlacklistCard,
  formatSecurityCard,
  formatNotifSettingsCard,
  formatBaleSetPrompt,
  formatAuditCards,
  formatControlHelp,
  collectSystemOverview,
  collectAuditRows,
  collectSecuritySnapshot,
  collectBrainHistory,
  fetchEyesDashboard,
  fetchEyesProfile,
  fetchEyesNotifications,
  fetchEyesBookmarks,
  fetchEyesPlans,
  fetchEyesSearch,
  fetchEyesSeoMeta,
  safeCardText,
} from './control-panel.js';
import { readLiveAutoBidFlag, writeLiveAutoBidFlag } from './live-auto-flag.js';
import { createAgentSettingsStore, getTodayAutoCounts } from './agent-settings.js';
import { formatFriendlyError, formatRulesCard, rulesInlineKeyboard } from './ui.js';
import {
  parseMessageRuleWizard,
  parsePricingWizard,
  MESSAGE_RULE_WIZARD_HELP,
  PRICING_WIZARD_HELP,
} from './rule-wizard.js';
import { InlineKeyboard } from 'grammy';

/**
 * @param {object} deps
 */
export function createControlHandlers(deps) {
  const {
    db,
    api,
    runtime,
    owners = [],
    editOrReply,
    menuOpts,
    wizard,
    hooks = {},
    getMorningDigest = null,
    replyOpportunitiesHub = null,
    replyOpportunityRules = null,
    replyScoringProfile = null,
    doOpportunityScan = null,
    replyPostWin = null,
  } = deps;

  function liveOn() {
    const envDefault =
      typeof hooks.getAllowLiveAutoBid === 'function'
        ? false
        : Boolean(hooks.allowLiveAutoBid);
    if (typeof hooks.getAllowLiveAutoBid === 'function') {
      return Boolean(hooks.getAllowLiveAutoBid());
    }
    return readLiveAutoBidFlag(db, { envDefault: Boolean(hooks.allowLiveAutoBid ?? envDefault) });
  }

  function baleConfigured() {
    if (typeof hooks.isBaleConfigured === 'function') return Boolean(hooks.isBaleConfigured());
    return Boolean(hooks.baleConfigured);
  }

  async function replyHub(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      safeCardText(formatControlHub()),
      { reply_markup: controlHubKeyboard() },
      { edit }
    );
  }

  async function replySys(ctx, { edit = false } = {}) {
    const snap = collectSystemOverview({
      db,
      api,
      runtime,
      owners,
      mcpHost: hooks.mcpHost,
      mcpPort: hooks.mcpPort,
      mcpApiKeySet: hooks.mcpApiKeySet,
      baleConfigured: baleConfigured(),
      envDefaultLive: Boolean(hooks.allowLiveAutoBid),
      envFile: hooks.envFile,
    });
    // Prefer live getter
    snap.liveAutoBid = liveOn();
    await editOrReply(
      ctx,
      safeCardText(formatSystemOverview(snap)),
      {
        reply_markup: (() => {
          const kb = new InlineKeyboard().text('🔄 بروزرسانی', CP.SYS);
          kb.row().text('⬅️ بازگشت', CP.HUB).text('🏠 خانه', 'nav:home');
          return kb;
        })(),
      },
      { edit }
    );
  }

  async function replyEyes(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      safeCardText(formatEyesMenu()),
      { reply_markup: eyesMenuKeyboard() },
      { edit }
    );
  }

  async function replyBrain(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      safeCardText(formatBrainMenu()),
      { reply_markup: brainMenuKeyboard() },
      { edit }
    );
  }

  async function replyHands(ctx, { edit = false } = {}) {
    const settings = db ? createAgentSettingsStore(db).get() : {};
    await editOrReply(
      ctx,
      safeCardText(
        formatHandsMenu({
          executionMode: settings.mode,
          emergencyStop: settings.emergencyStop,
          liveAutoBid: liveOn(),
        })
      ),
      { reply_markup: handsMenuKeyboard(liveOn()) },
      { edit }
    );
  }

  async function replySec(ctx, { edit = false } = {}) {
    const snap = collectSecuritySnapshot({
      api,
      owners,
      envFile: hooks.envFile,
    });
    await editOrReply(
      ctx,
      safeCardText(formatSecurityCard(snap)),
      { reply_markup: securityMenuKeyboard() },
      { edit }
    );
  }

  async function replyNotif(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      safeCardText(
        formatNotifSettingsCard({
          ownerIds: owners,
          baleConfigured: baleConfigured(),
        })
      ),
      { reply_markup: notifMenuKeyboard(baleConfigured()) },
      { edit }
    );
  }

  async function replyAudit(ctx, { edit = false } = {}) {
    const rows = collectAuditRows(db, { limit: 20 });
    const kb = new InlineKeyboard()
      .text('🔄 بروزرسانی', CP.AUDIT)
      .row()
      .text('⬅️ بازگشت', CP.HUB)
      .text('🏠 خانه', 'nav:home');
    await editOrReply(ctx, safeCardText(formatAuditCards(rows)), { reply_markup: kb }, { edit });
  }

  async function replyCpHelp(ctx, { edit = false } = {}) {
    const kb = new InlineKeyboard().text('⬅️ کنترل', CP.HUB).text('🏠 خانه', 'nav:home');
    await editOrReply(ctx, safeCardText(formatControlHelp()), { reply_markup: kb }, { edit });
  }

  async function withApiError(ctx, edit, fn) {
    try {
      await fn();
    } catch (e) {
      const { text, keyboard } = formatFriendlyError(e, {
        title: '⚠️ خطا در خواندن داده',
        retryCallback: CP.EYES,
      });
      await editOrReply(ctx, text, { reply_markup: keyboard }, { edit });
    }
  }

  async function replyEyesDash(ctx, { edit = false } = {}) {
    await withApiError(ctx, edit, async () => {
      const data = await fetchEyesDashboard(api);
      const kb = new InlineKeyboard()
        .text('🔄', CP.EYES_DASH)
        .text('⬅️', CP.EYES)
        .row()
        .text('🏠 خانه', 'nav:home');
      await editOrReply(
        ctx,
        safeCardText(formatDashboardSummary(data)),
        { reply_markup: kb },
        { edit }
      );
    });
  }

  async function replyEyesProf(ctx, { edit = false } = {}) {
    await withApiError(ctx, edit, async () => {
      const me = await fetchEyesProfile(api);
      const kb = new InlineKeyboard().text('⬅️', CP.EYES).text('🏠 خانه', 'nav:home');
      await editOrReply(ctx, safeCardText(formatProfileCard(me)), { reply_markup: kb }, { edit });
    });
  }

  async function replyEyesNotif(ctx, { edit = false } = {}) {
    await withApiError(ctx, edit, async () => {
      const data = await fetchEyesNotifications(api, 1);
      const kb = new InlineKeyboard().text('🔄', CP.EYES_NOTIF).row().text('⬅️', CP.EYES).text('🏠 خانه', 'nav:home');
      await editOrReply(
        ctx,
        safeCardText(formatNotificationsCard(data.notifications, { page: data.page })),
        { reply_markup: kb },
        { edit }
      );
    });
  }

  async function replyEyesBm(ctx, { edit = false } = {}) {
    await withApiError(ctx, edit, async () => {
      const data = await fetchEyesBookmarks(api);
      const kb = new InlineKeyboard().text('⬅️', CP.EYES).text('🏠 خانه', 'nav:home');
      await editOrReply(
        ctx,
        safeCardText(formatBookmarksCard(data)),
        { reply_markup: kb },
        { edit }
      );
    });
  }

  async function replyEyesPlans(ctx, { edit = false } = {}) {
    await withApiError(ctx, edit, async () => {
      const plans = await fetchEyesPlans(api);
      const kb = new InlineKeyboard().text('⬅️', CP.EYES).text('🏠 خانه', 'nav:home');
      await editOrReply(ctx, safeCardText(formatPlansCard(plans)), { reply_markup: kb }, { edit });
    });
  }

  async function startEyesSearch(ctx, { edit = false } = {}) {
    if (wizard) wizard.set(ctx.from?.id, { kind: 'eyes_search' });
    await editOrReply(
      ctx,
      safeCardText(formatProjectSearchPrompt()),
      {
        reply_markup: new InlineKeyboard().text('❌ لغو', CP.EYES).text('🏠 خانه', 'nav:home'),
      },
      { edit }
    );
  }

  async function startEyesSeo(ctx, { edit = false } = {}) {
    if (wizard) wizard.set(ctx.from?.id, { kind: 'eyes_seo' });
    await editOrReply(
      ctx,
      safeCardText(formatSeoMetaPrompt()),
      {
        reply_markup: new InlineKeyboard().text('❌ لغو', CP.EYES).text('🏠 خانه', 'nav:home'),
      },
      { edit }
    );
  }

  async function replyBrainHist(ctx, { edit = false } = {}) {
    const rows = collectBrainHistory(db, { limit: 15 });
    const kb = new InlineKeyboard()
      .text('🔄', CP.BRAIN_HIST)
      .row()
      .text('⬅️', CP.BRAIN)
      .text('🏠 خانه', 'nav:home');
    await editOrReply(
      ctx,
      safeCardText(formatDecisionHistory(rows)),
      { reply_markup: kb },
      { edit }
    );
  }

  async function replyLive(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      safeCardText(formatLiveAutoCard(liveOn())),
      {
        reply_markup: liveOn()
          ? liveAutoConfirmKeyboard(false)
          : new InlineKeyboard()
              .text('⚠️ روشن کردن…', 'hands:live:ask')
              .row()
              .text('⬅️', CP.HANDS)
              .text('🏠 خانه', 'nav:home'),
      },
      { edit }
    );
  }

  async function replyLiveAsk(ctx, { edit = false } = {}) {
    await editOrReply(
      ctx,
      safeCardText(formatLiveAutoWarningConfirm()),
      { reply_markup: liveAutoConfirmKeyboard(true) },
      { edit }
    );
  }

  async function doLiveSet(ctx, enabled, { edit = false } = {}) {
    if (!db) {
      await ctx.reply('ذخیره در دسترس نیست.', menuOpts());
      return;
    }
    const onChange =
      typeof hooks.setAllowLiveAutoBid === 'function' ? hooks.setAllowLiveAutoBid : null;
    writeLiveAutoBidFlag(db, enabled, {
      envFile: hooks.envFile || null,
      onChange,
      syncEnv: true,
    });
    await editOrReply(
      ctx,
      safeCardText(
        enabled
          ? '⚡ پیشنهاد زنده روشن شد.\nتوقف اضطراری همچنان می‌تواند همه را قطع کند.'
          : '🔒 پیشنهاد زنده خاموش شد.'
      ),
      { reply_markup: handsMenuKeyboard(enabled) },
      { edit }
    );
  }

  async function replyLimits(ctx, { edit = false } = {}) {
    const settings = db ? createAgentSettingsStore(db).get() : {};
    const today = db ? getTodayAutoCounts(db) : {};
    await editOrReply(
      ctx,
      safeCardText(formatLimitsCard({ limits: settings.limits, autoToday: today })),
      { reply_markup: limitsKeyboard() },
      { edit }
    );
  }

  async function replyBlacklist(ctx, { edit = false } = {}) {
    const settings = db ? createAgentSettingsStore(db).get() : {};
    await editOrReply(
      ctx,
      safeCardText(formatBlacklistCard(settings)),
      { reply_markup: blacklistKeyboard() },
      { edit }
    );
  }

  async function sendDigestNow(ctx, { edit = false } = {}) {
    const digest = typeof getMorningDigest === 'function' ? getMorningDigest() : null;
    if (!digest?.maybeSend) {
      await editOrReply(
        ctx,
        'خلاصه صبح در این اجرا در دسترس نیست.',
        { reply_markup: notifMenuKeyboard(baleConfigured()) },
        { edit }
      );
      return;
    }
    const res = await digest.maybeSend({ force: true });
    const msg = res.sent
      ? '☀️ خلاصه صبح برای مالکان ارسال شد.'
      : `ارسال نشد: ${res.reason === 'quiet' ? 'چیزی برای گزارش نبود' : res.reason || 'نامشخص'}`;
    await editOrReply(
      ctx,
      safeCardText(msg),
      { reply_markup: notifMenuKeyboard(baleConfigured()) },
      { edit }
    );
  }

  async function startBaleSet(ctx, { edit = false } = {}) {
    if (wizard) wizard.set(ctx.from?.id, { kind: 'bale_token' });
    await editOrReply(
      ctx,
      safeCardText(formatBaleSetPrompt()),
      {
        reply_markup: new InlineKeyboard().text('❌ لغو', CP.NOTIF).text('🏠 خانه', 'nav:home'),
      },
      { edit }
    );
  }

  async function clearBale(ctx, { edit = false } = {}) {
    try {
      if (hooks.envFile) writeEnvKey(hooks.envFile, 'BALE_BOT_TOKEN', '');
      process.env.BALE_BOT_TOKEN = '';
      if (typeof hooks.setBaleToken === 'function') hooks.setBaleToken('');
    } catch {
      /* ignore */
    }
    await editOrReply(
      ctx,
      '🗑 توکن بله پاک شد (configured → not).',
      { reply_markup: notifMenuKeyboard(false) },
      { edit }
    );
  }

  /**
   * Handle control-panel related callbacks. Returns true if handled.
   */
  async function handleCallback(ctx, parsed) {
    if (!parsed?.type) return false;
    const t = parsed.type;
    const edit = true;

    const routes = {
      cp_hub: () => replyHub(ctx, { edit }),
      cp_sys: () => replySys(ctx, { edit }),
      cp_eyes: () => replyEyes(ctx, { edit }),
      cp_brain: () => replyBrain(ctx, { edit }),
      cp_hands: () => replyHands(ctx, { edit }),
      cp_sec: () => replySec(ctx, { edit }),
      cp_notif: () => replyNotif(ctx, { edit }),
      cp_audit: () => replyAudit(ctx, { edit }),
      cp_help: () => replyCpHelp(ctx, { edit }),
      eyes_dash: () => replyEyesDash(ctx, { edit }),
      eyes_prof: () => replyEyesProf(ctx, { edit }),
      eyes_notif: () => replyEyesNotif(ctx, { edit }),
      eyes_bm: () => replyEyesBm(ctx, { edit }),
      eyes_plans: () => replyEyesPlans(ctx, { edit }),
      eyes_search: () => startEyesSearch(ctx, { edit }),
      eyes_seo: () => startEyesSeo(ctx, { edit }),
      brain_hist: () => replyBrainHist(ctx, { edit }),
      hands_limits: () => replyLimits(ctx, { edit }),
      hands_blacklist: () => replyBlacklist(ctx, { edit }),
      hands_live: () => replyLive(ctx, { edit }),
      hands_live_ask: () => replyLiveAsk(ctx, { edit }),
      hands_live_on: () => doLiveSet(ctx, true, { edit }),
      hands_live_off: () => doLiveSet(ctx, false, { edit }),
      notif_digest: () => sendDigestNow(ctx, { edit }),
      notif_bale: () => replyNotif(ctx, { edit }),
      notif_bale_set: () => startBaleSet(ctx, { edit }),
      notif_bale_clear: () => clearBale(ctx, { edit }),
      wiz_limits: async () => {
        if (wizard) wizard.set(ctx.from?.id, { kind: 'limits_edit' });
        await editOrReply(
          ctx,
          'دو عدد بفرستید: سقف‌پیام سقف‌پیشنهاد\nمثال: ۵ ۱۰\nلغو: /cancel',
          { reply_markup: new InlineKeyboard().text('⬅️', CP.HANDS) },
          { edit }
        );
      },
      wiz_bl_keywords: async () => {
        if (wizard) wizard.set(ctx.from?.id, { kind: 'bl_keywords' });
        await editOrReply(
          ctx,
          'کلیدواژه‌های لیست سیاه را با ویرگول بفرستید.\nلغو: /cancel',
          { reply_markup: new InlineKeyboard().text('⬅️', CP.HANDS) },
          { edit }
        );
      },
      wiz_msg_rule: async () => {
        if (wizard) wizard.set(ctx.from?.id, { kind: 'msg_rule' });
        await editOrReply(
          ctx,
          MESSAGE_RULE_WIZARD_HELP,
          { reply_markup: new InlineKeyboard().text('⬅️ قوانین', 'nav:rules') },
          { edit }
        );
      },
      wiz_pricing: async () => {
        if (wizard) wizard.set(ctx.from?.id, { kind: 'pricing' });
        await editOrReply(
          ctx,
          PRICING_WIZARD_HELP,
          { reply_markup: new InlineKeyboard().text('⬅️ قوانین', 'nav:rules') },
          { edit }
        );
      },
      wiz_bl_rooms: async () => {
        if (wizard) wizard.set(ctx.from?.id, { kind: 'bl_rooms' });
        await editOrReply(
          ctx,
          'شناسه اتاق‌های لیست سیاه را با ویرگول بفرستید.\nلغو: /cancel',
          { reply_markup: new InlineKeyboard().text('⬅️', CP.HANDS) },
          { edit }
        );
      },
    };

    // Special: hands:live:ask
    if (ctx.callbackQuery?.data === 'hands:live:ask') {
      await ctx.answerCallbackQuery();
      await replyLiveAsk(ctx, { edit });
      return true;
    }

    // Brain deep-links already handled elsewhere — bridge when we can
    if (t === 'opp_hub' || ctx.callbackQuery?.data === CP.BRAIN_OPP) {
      if (replyOpportunitiesHub) {
        await ctx.answerCallbackQuery();
        await replyOpportunitiesHub(ctx, { edit });
        return true;
      }
    }
    if (ctx.callbackQuery?.data === CP.BRAIN_PROF && replyScoringProfile) {
      await ctx.answerCallbackQuery();
      await replyScoringProfile(ctx, { edit });
      return true;
    }
    if (ctx.callbackQuery?.data === CP.BRAIN_RULES && replyOpportunityRules) {
      await ctx.answerCallbackQuery();
      await replyOpportunityRules(ctx, { edit });
      return true;
    }
    if (ctx.callbackQuery?.data === CP.BRAIN_SCAN && doOpportunityScan) {
      await ctx.answerCallbackQuery({ text: 'اسکن…' });
      await doOpportunityScan(ctx, { edit });
      return true;
    }
    if (ctx.callbackQuery?.data === CP.POSTWIN && replyPostWin) {
      await ctx.answerCallbackQuery();
      await replyPostWin(ctx, { edit });
      return true;
    }

    const fn = routes[t];
    if (!fn) return false;
    await ctx.answerCallbackQuery();
    await fn();
    return true;
  }

  /**
   * Wizard text for control-panel kinds. Returns true if handled.
   */
  async function handleWizardText(ctx) {
    if (!wizard || !db) return false;
    const st = wizard.get(ctx.from?.id);
    if (!st?.kind) return false;
    const textIn = (ctx.message?.text || '').trim();
    if (!textIn) return false;
    if (textIn === '/cancel') {
      wizard.clear(ctx.from?.id);
      await ctx.reply('لغو شد.', menuOpts());
      return true;
    }

    if (st.kind === 'eyes_search') {
      wizard.clear(ctx.from?.id);
      try {
        const { projects, query } = await fetchEyesSearch(api, textIn);
        await ctx.reply(safeCardText(formatProjectSearchResults(projects, query)), {
          ...menuOpts(),
          reply_markup: eyesMenuKeyboard(),
        });
      } catch (e) {
        const { text, keyboard } = formatFriendlyError(e, { retryCallback: CP.EYES_SEARCH });
        await ctx.reply(text, { ...menuOpts(), reply_markup: keyboard });
      }
      return true;
    }

    if (st.kind === 'eyes_seo') {
      wizard.clear(ctx.from?.id);
      try {
        const meta = await fetchEyesSeoMeta(api, textIn.trim());
        await ctx.reply(safeCardText(formatSeoMetaCard(meta)), {
          ...menuOpts(),
          reply_markup: eyesMenuKeyboard(),
        });
      } catch (e) {
        const { text, keyboard } = formatFriendlyError(e, { retryCallback: CP.EYES_SEO });
        await ctx.reply(text, { ...menuOpts(), reply_markup: keyboard });
      }
      return true;
    }

    if (st.kind === 'limits_edit') {
      const nums = textIn.replace(/,/g, '').match(/\d+/g) || [];
      if (nums.length < 2) {
        await ctx.reply('دو عدد لازم است. مثال: ۵ ۱۰', menuOpts());
        return true;
      }
      const store = createAgentSettingsStore(db);
      store.update({
        limits: {
          maxAutoMessagesPerDay: Number(nums[0]),
          maxAutoBidsPerDay: Number(nums[1]),
        },
      });
      wizard.clear(ctx.from?.id);
      await ctx.reply('✅ سقف روزانه ذخیره شد.', menuOpts());
      await replyLimits(ctx);
      return true;
    }

    if (st.kind === 'msg_rule' || st.kind === 'pricing') {
      const parsed = st.kind === 'msg_rule' ? parseMessageRuleWizard(textIn) : parsePricingWizard(textIn);
      if (!parsed.ok) {
        await ctx.reply([...parsed.errors, '', 'دوباره بفرستید یا /cancel'].join('\n'), menuOpts());
        return true;
      }
      const store = createAgentSettingsStore(db);
      const cur = store.get();
      if (st.kind === 'msg_rule') {
        store.update({ rules: { ...cur.rules, messageAuto: { ...cur.rules.messageAuto, ...parsed.patch } } });
      } else {
        store.update({ pricing: { ...cur.pricing, ...parsed.patch } });
      }
      wizard.clear(ctx.from?.id);
      await ctx.reply('✅ ذخیره شد.', menuOpts());
      await ctx.reply(formatRulesCard(store.get()), { reply_markup: rulesInlineKeyboard() });
      return true;
    }

    if (st.kind === 'bl_keywords') {
      const keywords = textIn.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
      const store = createAgentSettingsStore(db);
      const cur = store.get();
      store.update({ blacklist: { ...cur.blacklist, keywords } });
      wizard.clear(ctx.from?.id);
      await ctx.reply(`✅ کلیدواژه‌ها ذخیره شد (${keywords.length}).`, menuOpts());
      await replyBlacklist(ctx);
      return true;
    }

    if (st.kind === 'bl_rooms') {
      const rooms = textIn.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean);
      const store = createAgentSettingsStore(db);
      const cur = store.get();
      store.update({ blacklist: { ...cur.blacklist, rooms } });
      wizard.clear(ctx.from?.id);
      await ctx.reply(`✅ اتاق‌ها ذخیره شد (${rooms.length}).`, menuOpts());
      await replyBlacklist(ctx);
      return true;
    }

    if (st.kind === 'bale_token') {
      const token = textIn.trim();
      // Delete the user's message first — never echo token
      try {
        await ctx.deleteMessage();
      } catch {
        try {
          if (ctx.message?.message_id && ctx.chat?.id) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id);
          }
        } catch {
          /* best effort */
        }
      }
      wizard.clear(ctx.from?.id);
      if (!token || token.length < 10 || /\s/.test(token)) {
        await ctx.reply('توکن معتبر به نظر نمی‌رسد. دوباره از منوی اعلان‌ها تلاش کنید.', menuOpts());
        return true;
      }
      try {
        if (hooks.envFile) writeEnvKey(hooks.envFile, 'BALE_BOT_TOKEN', token);
        process.env.BALE_BOT_TOKEN = token;
        if (typeof hooks.setBaleToken === 'function') hooks.setBaleToken(token);
        await ctx.reply('✅ توکن بله ذخیره شد (هرگز تکرار نمی‌شود).', {
          ...menuOpts(),
          reply_markup: notifMenuKeyboard(true),
        });
      } catch {
        await ctx.reply('ذخیره توکن ناموفق بود (دسترسی فایل؟).', menuOpts());
      }
      return true;
    }

    return false;
  }

  return {
    replyHub,
    handleCallback,
    handleWizardText,
    liveOn,
    };
}

export default createControlHandlers;
