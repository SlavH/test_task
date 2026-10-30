let upstashRatelimit = null;
let upstashRedis = null;

async function loadUpstash() {
  if (upstashRatelimit) return upstashRatelimit;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const { Redis } = await import("@upstash/redis");
    const { Ratelimit } = await import("@upstash/ratelimit");
    upstashRedis = new Redis({ url, token });
    upstashRatelimit = new Ratelimit({
      redis: upstashRedis,
      limiter: Ratelimit.slidingWindow(5, "60 s"),
      analytics: false,
    });
    return upstashRatelimit;
  } catch {
    return null;
  }
}

export function createRateLimiter(config) {
  const limit = Number(config?.webCallRateLimit || process.env.WEB_CALL_RATE_LIMIT || 5);
  const hits = new Map();
  let upstash = null;
  loadUpstash().then((value) => {
    upstash = value;
  });

  return async (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    if (upstash) {
      try {
        const result = await upstash.limit(key);
        if (!result.success) {
          res.setHeader("Retry-After", Math.ceil((result.reset - Date.now()) / 1000));
          return res.status(429).json({
            error: "rate_limited",
            message: "Too many demo calls. Please wait a minute and try again.",
          });
        }
        return next();
      } catch {
        // Fall through to in-memory limiting.
      }
    }

    const now = Date.now();
    const list = (hits.get(key) || []).filter((time) => now - time < 60_000);
    if (list.length >= limit) {
      res.setHeader("Retry-After", "60");
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many demo calls. Please wait a minute and try again.",
      });
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    next();
  };
}
