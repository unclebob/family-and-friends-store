// Keeps one outbound socket to MeritLink alive: heartbeat, dead-socket detection, reconnect with backoff.
const OPEN = 1;
const HEARTBEAT = JSON.stringify({ op: "heartbeat" });

export function backoff(attempt) {
  return Math.min(1000 * 2 ** attempt, 60_000);
}

// options: open, onOpen, onMessage, and optionally log, pingMs, deadMs, timers, now.
export function keepLink(options) {
  const link = { log: logStderr, pingMs: 30_000, deadMs: 90_000, timers: globalThis, now: Date.now, ...options };
  link.attempt = 0;
  connect(link);
  return { send: (text) => safeSend(link.current, text) };
}

function connect(link) {
  const ws = link.open();
  const conn = { link, ws, lastSeen: link.now(), pinger: null, done: false };
  link.current = ws;
  ws.addEventListener("open", () => opened(conn));
  ws.addEventListener("message", (event) => received(conn, event));
  ws.addEventListener("close", (event) => drop(conn, closeReason(event)));
  ws.addEventListener("error", () => drop(conn, "error"));
}

function opened(conn) {
  const { link } = conn;
  conn.lastSeen = link.now();
  link.log("connected");
  link.onOpen(conn.ws);
  conn.pinger = link.timers.setInterval(() => tick(conn), link.pingMs);
}

function received(conn, event) {
  conn.lastSeen = conn.link.now();
  if (isAuthOk(event)) conn.link.attempt = 0;
  conn.link.onMessage(event);
}

function tick(conn) {
  if (conn.link.now() - conn.lastSeen > conn.link.deadMs) return drop(conn, "no heartbeat reply");
  safeSend(conn.ws, HEARTBEAT);
}

function drop(conn, why) {
  if (conn.done) return;
  conn.done = true;
  stopPinger(conn);
  quietly(() => conn.ws.close());
  retry(conn.link, why);
}

function stopPinger(conn) {
  if (conn.pinger) conn.link.timers.clearInterval(conn.pinger);
}

function retry(link, why) {
  const delay = backoff(link.attempt++);
  link.log(`disconnected (${why}), reconnecting in ${delay}ms`);
  link.timers.setTimeout(() => connect(link), delay);
}

function closeReason(event) {
  return `closed ${event.code} ${event.reason}`.trim();
}

function isAuthOk(event) {
  return String(event.data).includes('"auth_ok"');
}

function safeSend(ws, text) {
  if (ws.readyState === OPEN) quietly(() => ws.send(text));
}

function quietly(action) {
  try {
    action();
  } catch {}
}

function logStderr(text) {
  console.error(`${new Date().toISOString()} merit link ${text}`);
}
