const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

function serializeError(error) {
  if (!error || typeof error !== 'object') {
    return error;
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    status: error.status,
    statusCode: error.statusCode
  };
}

function safeStringify(payload, space) {
  const seen = new WeakSet();
  return JSON.stringify(
    payload,
    (key, value) => {
      if (value instanceof Error) {
        return serializeError(value);
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    },
    space
  );
}

function buildLogEntry(level, message, context) {
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    context: context ?? undefined
  };
}

function writeLog(level, entry) {
  const isProduction = process.env.NODE_ENV === 'production';
  const output = safeStringify(entry, isProduction ? 0 : 2);
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${output}\n`);
}

function log(level, message, context) {
  if (!LOG_LEVELS.includes(level)) {
    return;
  }
  const entry = buildLogEntry(level, message, context);
  writeLog(level, entry);
}

export const logger = {
  error: (message, context) => log('error', message, context),
  warn: (message, context) => log('warn', message, context),
  info: (message, context) => log('info', message, context),
  debug: (message, context) => log('debug', message, context)
};

export const logUtils = {
  serializeError
};
