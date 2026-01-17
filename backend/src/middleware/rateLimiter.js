import rateLimit from 'express-rate-limit';
import {
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_LABEL_MAX,
  RATE_LIMIT_LABEL_WINDOW_MS,
  RATE_LIMIT_READ_MAX,
  RATE_LIMIT_READ_WINDOW_MS,
  RATE_LIMIT_SYNC_MAX,
  RATE_LIMIT_SYNC_WINDOW_MS
} from '../config.js';

function getRetryAfterMinutes(req) {
  const resetTime = req.rateLimit?.resetTime instanceof Date ? req.rateLimit.resetTime.getTime() : null;
  if (!resetTime) {
    return null;
  }
  const msRemaining = resetTime - Date.now();
  return Math.max(1, Math.ceil(msRemaining / 60000));
}

function buildRateLimitHandler() {
  return (req, res, _next) => {
    const minutes = getRetryAfterMinutes(req);
    const waitMessage = minutes ? `${minutes} minute${minutes === 1 ? '' : 's'}` : 'a few minutes';
    res.status(429).json({
      error: `Rate limit exceeded. Try again in ${waitMessage}`
    });
  };
}

function createLimiter({ max, windowMs }) {
  return rateLimit({
    windowMs,
    max,
    legacyHeaders: true,
    standardHeaders: false,
    handler: buildRateLimitHandler()
  });
}

export const rateLimitEnabled = RATE_LIMIT_ENABLED;

export const syncLimiter = createLimiter({
  max: RATE_LIMIT_SYNC_MAX,
  windowMs: RATE_LIMIT_SYNC_WINDOW_MS
});

export const labelLimiter = createLimiter({
  max: RATE_LIMIT_LABEL_MAX,
  windowMs: RATE_LIMIT_LABEL_WINDOW_MS
});

export const readLimiter = createLimiter({
  max: RATE_LIMIT_READ_MAX,
  windowMs: RATE_LIMIT_READ_WINDOW_MS
});
