/**
 * Request / Response / Socket Event Logger
 *
 * API calls  → [API REQ] / [API RES]
 * Socket IN  → [SOCKET ←]
 * Socket OUT → [SOCKET →]
 */

const SENSITIVE_KEYS = ['password', 'token', 'fcm_token', 'secret'];

function maskSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const masked = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(masked)) {
    if (SENSITIVE_KEYS.some((k) => key.toLowerCase().includes(k))) {
      masked[key] = '***';
    } else if (typeof masked[key] === 'object') {
      masked[key] = maskSensitive(masked[key]);
    }
  }
  return masked;
}

function fmt(data) {
  try {
    return JSON.stringify(maskSensitive(data));
  } catch {
    return String(data);
  }
}

// ─── HTTP API Logger Middleware ───────────────────────────────────────────────
function apiLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl } = req;

  const body = req.body && Object.keys(req.body).length ? req.body : null;
  const query = req.query && Object.keys(req.query).length ? req.query : null;

  console.log(`\n[API ←] ${method} ${originalUrl}`);
  if (query) console.log(`  query : ${fmt(query)}`);
  if (body)  console.log(`  body  : ${fmt(body)}`);

  // Response intercept
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    const ms = Date.now() - start;
    console.log(`[API →] ${method} ${originalUrl} ${res.statusCode} (${ms}ms)`);
    console.log(`  res   : ${fmt(data)}`);
    return originalJson(data);
  };

  next();
}

// ─── Socket Event Logger ──────────────────────────────────────────────────────
function attachSocketLogger(socket) {
  const uid = `user:${socket.userId}`;

  // Incoming — every event from this client
  socket.onAny((event, ...args) => {
    console.log(`\n[SOCKET ←] ${event} | ${uid}`);
    args.forEach((arg, i) => {
      if (arg !== undefined) console.log(`  arg[${i}]: ${fmt(arg)}`);
    });
  });

  // Outgoing — wrap socket.emit (direct sends to this client)
  const _emit = socket.emit.bind(socket);
  socket.emit = function (event, ...args) {
    // skip internal socket.io events
    if (!event.startsWith('$') && event !== 'connect' && event !== 'disconnect') {
      console.log(`\n[SOCKET →] ${event} | ${uid}`);
      args.forEach((arg, i) => {
        if (arg !== undefined) console.log(`  arg[${i}]: ${fmt(arg)}`);
      });
    }
    return _emit(event, ...args);
  };
}

module.exports = { apiLogger, attachSocketLogger };
