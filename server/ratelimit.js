// Simple in-memory sliding-window rate limit per client IP.
// There is no login, so this only keeps one person (or a bot) from
// running up the vision model. Restarting the server resets it.

export function createRateLimiter({ limit, windowMs, message }) {
  const hits = new Map(); // ip -> array of timestamps (ms)

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }, 60_000);
  sweep.unref();

  function middleware(req, res, next) {
    if (!limit) return next(); // 0 disables the limit
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (times.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((times[0] + windowMs - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      hits.set(ip, times);
      return res.status(429).json({ error: message });
    }
    times.push(now);
    hits.set(ip, times);
    next();
  }

  middleware.reset = () => hits.clear();
  return middleware;
}
