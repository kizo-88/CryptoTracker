// Tiny in-memory TTL cache with stale-on-error fallback.
const fresh = new Map(); // key -> { value, expires }
const stale = new Map(); // key -> last good value (never expires)

function get(key) {
  const e = fresh.get(key);
  if (e && e.expires > Date.now()) return e.value;
  return null;
}

function set(key, value, ttlMs) {
  fresh.set(key, { value, expires: Date.now() + ttlMs });
  stale.set(key, value);
}

/**
 * Run fn() with caching. On fetch failure, serve the last good value if we have one.
 */
async function cached(key, ttlMs, fn) {
  const hit = get(key);
  if (hit !== null) return hit;
  try {
    const value = await fn();
    set(key, value, ttlMs);
    return value;
  } catch (err) {
    if (stale.has(key)) {
      console.warn(`[cache] ${key} refresh failed (${err.message}), serving stale data`);
      return stale.get(key);
    }
    throw err;
  }
}

module.exports = { cached };
