/**
 * Explainable opportunity scoring (0–100).
 * Never "AI thinks good" — always concrete reason strings.
 */

/**
 * @param {object} opportunity — ProjectOpportunity
 * @param {object} [profile] — from store.getScoringProfile()
 * @returns {{ score: number, reasons: string[], breakdown: Record<string, number> }}
 */
export function scoreOpportunity(opportunity, profile = {}) {
  const weights = {
    skills: 30,
    budget: 20,
    category: 20,
    fresh: 15,
    client: 15,
    ...(profile.weights || {}),
  };
  const preferredSkills = toList(profile.preferredSkills);
  const preferredCategories = toList(profile.preferredCategories).map(String);
  const budgetMin = num(profile.budgetMin);
  const budgetMax = num(profile.budgetMax);
  const freshHours = num(profile.freshHours) ?? 24;
  const clientMinRate = num(profile.clientMinRate) ?? 4;

  const breakdown = { skills: 0, budget: 0, category: 0, fresh: 0, client: 0 };
  /** @type {string[]} */
  const reasons = [];

  // —— Skills (up to weights.skills) ——
  const oppSkills = toList(opportunity?.skills);
  if (preferredSkills.length && oppSkills.length) {
    const hits = preferredSkills.filter((ps) =>
      oppSkills.some((os) => os.includes(ps) || ps.includes(os))
    );
    if (hits.length) {
      const ratio = Math.min(1, hits.length / Math.min(preferredSkills.length, 3));
      breakdown.skills = Math.round(weights.skills * ratio);
      reasons.push(`مهارت‌های منطبق: ${hits.slice(0, 5).join('، ')} (+${breakdown.skills})`);
    } else {
      reasons.push('هیچ مهارت ترجیحی منطبق نشد (+0)');
    }
  } else if (!preferredSkills.length) {
    // Soft partial credit when profile not configured but project has skills
    if (oppSkills.length) {
      breakdown.skills = Math.round(weights.skills * 0.3);
      reasons.push(`مهارت‌ها اعلام شده‌اند (${oppSkills.slice(0, 3).join('، ')}) (+${breakdown.skills})`);
    } else {
      reasons.push('مهارت ترجیحی پیکربندی نشده (+0)');
    }
  } else {
    reasons.push('پروژه مهارتی اعلام نکرده (+0)');
  }

  // —— Budget (up to weights.budget) ——
  const oppMin = num(opportunity?.budgetMin);
  const oppMax = num(opportunity?.budgetMax);
  const oppMid =
    oppMin != null && oppMax != null ? (oppMin + oppMax) / 2 : oppMax ?? oppMin;
  if (oppMid == null) {
    reasons.push('بودجه مشخص نیست (+0)');
  } else if (budgetMin == null && budgetMax == null) {
    breakdown.budget = Math.round(weights.budget * 0.5);
    reasons.push(`بودجه اعلام‌شده: ${fmtMoney(oppMin)}–${fmtMoney(oppMax)} (+${breakdown.budget})`);
  } else {
    const lo = budgetMin ?? 0;
    const hi = budgetMax ?? Number.POSITIVE_INFINITY;
    if (oppMid >= lo && oppMid <= hi) {
      breakdown.budget = weights.budget;
      reasons.push(`بودجه در بازه هدف (${fmtMoney(lo)}–${fmtMoney(hi)}) (+${breakdown.budget})`);
    } else if (oppMax != null && oppMax >= lo && (budgetMax == null || oppMin <= hi)) {
      breakdown.budget = Math.round(weights.budget * 0.5);
      reasons.push(`بودجه تا حدی هم‌پوشانی دارد (+${breakdown.budget})`);
    } else {
      reasons.push(`بودجه خارج از بازه هدف است (+0)`);
    }
  }

  // —— Category (up to weights.category) ——
  const cat = opportunity?.category != null ? String(opportunity.category) : '';
  if (preferredCategories.length && cat) {
    if (preferredCategories.includes(cat) || preferredCategories.includes(cat.toLowerCase())) {
      breakdown.category = weights.category;
      reasons.push(`دسته منطبق: ${cat} (+${breakdown.category})`);
    } else {
      reasons.push(`دسته نامنطبق: ${cat} (+0)`);
    }
  } else if (!preferredCategories.length) {
    if (cat) {
      breakdown.category = Math.round(weights.category * 0.3);
      reasons.push(`دسته: ${cat} (+${breakdown.category})`);
    } else {
      reasons.push('دسته ترجیحی پیکربندی نشده (+0)');
    }
  } else {
    reasons.push('دسته پروژه مشخص نیست (+0)');
  }

  // —— Freshness (up to weights.fresh) ——
  const age = num(opportunity?.ageHours);
  if (age == null) {
    if (opportunity?.pastTime) {
      breakdown.fresh = Math.round(weights.fresh * 0.4);
      reasons.push(`زمان نسبی: ${opportunity.pastTime} (+${breakdown.fresh})`);
    } else {
      reasons.push('سن آگهی مشخص نیست (+0)');
    }
  } else if (age <= freshHours / 4) {
    breakdown.fresh = weights.fresh;
    reasons.push(`خیلی تازه (${age.toFixed(1)} ساعت) (+${breakdown.fresh})`);
  } else if (age <= freshHours) {
    const ratio = 1 - age / (freshHours * 1.5);
    breakdown.fresh = Math.max(1, Math.round(weights.fresh * Math.max(0.2, ratio)));
    reasons.push(`تازه (${age.toFixed(1)} ساعت، آستانه ${freshHours}س) (+${breakdown.fresh})`);
  } else {
    reasons.push(`قدیمی‌تر از ${freshHours} ساعت (+0)`);
  }

  // —— Client (up to weights.client) — ONLY if real API fields exist ——
  const rate = num(opportunity?.client?.rate ?? opportunity?.client?.rateNum);
  const hasRealClient =
    rate != null ||
    (opportunity?.client?.id != null && String(opportunity.client.id).trim() !== '') ||
    (opportunity?.client?.country != null && String(opportunity.client.country).trim() !== '');
  if (!hasRealClient) {
    // Honest omission: do not invent client quality; redistribute weight silently as 0 with reason
    reasons.push('کیفیت کارفرما در API موجود نیست — این جزء امتیاز حذف شد');
    breakdown.client = 0;
  } else if (rate == null) {
    reasons.push('شناسه کارفرما هست ولی امتیاز عددی نیست — جزء امتیاز کارفرما صفر');
    breakdown.client = 0;
  } else if (rate >= clientMinRate) {
    const ratio = Math.min(1, (rate - clientMinRate + 1) / (5 - clientMinRate + 1));
    breakdown.client = Math.round(weights.client * Math.max(0.5, ratio));
    reasons.push(`امتیاز کارفرما ${rate} (≥${clientMinRate}) (+${breakdown.client})`);
  } else if (rate > 0) {
    breakdown.client = Math.round(weights.client * 0.2);
    reasons.push(`امتیاز کارفرما پایین (${rate}) (+${breakdown.client})`);
  } else {
    reasons.push('کارفرمای بدون امتیاز (+0)');
  }

  if (opportunity?.isUrgent) {
    // tiny bonus already reflected via fresh; add reason only
    reasons.push('پروژه فوری علامت خورده');
  }

  let score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return { score, reasons, breakdown };
}

/**
 * Whether scoring is considered "configured" so PermissionGate scoringAvailable can flip on.
 */
export function isScoringConfigured(profile) {
  if (!profile) return false;
  return (
    toList(profile.preferredSkills).length > 0 ||
    toList(profile.preferredCategories).length > 0 ||
    num(profile.budgetMin) != null ||
    num(profile.budgetMax) != null
  );
}

function toList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtMoney(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  try {
    return Number(v).toLocaleString('fa-IR');
  } catch {
    return String(v);
  }
}

export default scoreOpportunity;
