import { logger, logUtils } from '../logger.js';

const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie']);

function sanitizeHeaders(headers = {}) {
  const sanitized = {};
  Object.entries(headers).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (REDACTED_HEADERS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = value;
    }
  });
  return sanitized;
}

function buildRequestContext(req) {
  return {
    method: req.method,
    path: req.originalUrl,
    params: req.params,
    query: req.query,
    body: req.body,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    headers: sanitizeHeaders(req.headers)
  };
}

function buildUserContext(req) {
  const user = req.user;
  if (!user || typeof user !== 'object') {
    return null;
  }
  return {
    id: user.id ?? user.userId ?? null,
    email: user.email ?? null,
    role: user.role ?? null
  };
}

function isValidationError(err) {
  if (!err || typeof err !== 'object') {
    return false;
  }
  if (err.name === 'ValidationError') {
    return true;
  }
  if (err.type === 'entity.parse.failed') {
    return true;
  }
  if (err.status === 400 || err.statusCode === 400) {
    return true;
  }
  return false;
}

function isNotFoundError(err) {
  return err?.status === 404 || err?.statusCode === 404;
}

export class AppError extends Error {
  constructor(message, { statusCode = 500, isOperational = true, details } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
  }
}

export function notFoundHandler(req, res, next) {
  next(
    new AppError('Not found.', {
      statusCode: 404,
      isOperational: true,
      details: { path: req.originalUrl }
    })
  );
}

export function registerProcessHandlers() {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      operation: 'process.unhandledRejection',
      error: logUtils.serializeError(reason)
    });
  });
}

export function errorHandler(err, req, res, next) {
  const statusCode =
    err?.statusCode ||
    err?.status ||
    (isValidationError(err) ? 400 : null) ||
    (isNotFoundError(err) ? 404 : null) ||
    500;

  const isOperational =
    err?.isOperational === true ||
    isValidationError(err) ||
    isNotFoundError(err) ||
    (statusCode >= 400 && statusCode < 500);

  logger.error('Request failed', {
    operation: 'http.request',
    statusCode,
    isOperational,
    request: buildRequestContext(req),
    user: buildUserContext(req),
    error: err
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const response = {
    error: isOperational ? err?.message || 'Request failed.' : 'Internal server error.'
  };

  if (!isProduction && err?.details) {
    response.details = err.details;
  }
  if (!isProduction && err?.stack) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}
