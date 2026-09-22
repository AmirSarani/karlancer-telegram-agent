/** @param {object} u */
export function normalizeUser(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: u.id != null ? String(u.id) : null,
    name: u.name || u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
    username: u.username || u.user_name || null,
    role: u.role || u.type || null,
    avatar: u.avatar || u.avatar_url || null,
    raw: u,
  };
}
