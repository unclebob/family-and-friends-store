import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { backoff, keepLink } from "./link.mjs";

class FakeSocket extends EventTarget {
  readyState = 0;
  sent = [];
  send(text) {
    this.sent.push(text);
  }
  close() {
    this.readyState = 3;
  }
  breakSending() {
    this.send = () => {
      throw new Error("socket gone");
    };
    this.close = () => {
      throw new Error("socket gone");
    };
  }
  fire(type, extra = {}) {
    if (type === "open") this.readyState = 1;
    this.dispatchEvent(Object.assign(new Event(type), extra));
  }
}

function fakeTimers() {
  const clock = { t: 0, intervals: [], timeouts: [] };
  return {
    clock,
    now: () => clock.t,
    timers: {
      setInterval: (fn) => clock.intervals.push(fn) && fn,
      clearInterval: (fn) => (clock.intervals = clock.intervals.filter((f) => f !== fn)),
      setTimeout: (fn, ms) => clock.timeouts.push({ fn, ms }),
    },
  };
}

function setup() {
  const sockets = [];
  const logs = [];
  const fake = fakeTimers();
  const link = keepLink({
    open: () => sockets[sockets.push(new FakeSocket()) - 1],
    onOpen: (ws) => ws.send("auth"),
    onMessage: () => {},
    log: (text) => logs.push(text),
    now: fake.now,
    timers: fake.timers,
  });
  return { sockets, logs, link, ...fake };
}

test("backoff doubles from 1s and caps at 60s", () => {
  assert.deepEqual([0, 1, 2, 5, 6, 10].map(backoff), [1000, 2000, 4000, 32000, 60000, 60000]);
});

test("authenticates on open and pings on the interval", () => {
  const { sockets, clock, logs } = setup();
  sockets[0].fire("open");
  clock.t = 30_000;
  clock.intervals[0]();
  assert.deepEqual(sockets[0].sent, ["auth", '{"op":"heartbeat"}']);
  assert.deepEqual(logs, ["connected"]);
});

test("reconnects with growing backoff after close", () => {
  const { sockets, clock } = setup();
  sockets[0].fire("close", { code: 1006 });
  sockets[0].fire("error");
  assert.equal(clock.timeouts.length, 1);
  assert.equal(clock.timeouts[0].ms, 1000);
  clock.timeouts[0].fn();
  sockets[1].fire("error");
  assert.equal(clock.timeouts[1].ms, 2000);
});

test("auth_ok resets the backoff", () => {
  const { sockets, clock } = setup();
  sockets[0].fire("close", { code: 1006 });
  clock.timeouts[0].fn();
  sockets[1].fire("open");
  sockets[1].fire("message", { data: '{"op":"auth_ok"}' });
  sockets[1].fire("close", { code: 1006 });
  assert.equal(clock.timeouts[1].ms, 1000);
});

test("drops a silent socket after 90s and reconnects", () => {
  const { sockets, clock, logs, link } = setup();
  sockets[0].fire("open");
  clock.t = 91_000;
  clock.intervals[0]();
  assert.equal(sockets[0].readyState, 3);
  assert.equal(clock.intervals.length, 0);
  assert.match(logs[1], /no heartbeat reply/);
  clock.timeouts[0].fn();
  sockets[1].fire("open");
  link.send("reply");
  assert.deepEqual(sockets[1].sent, ["auth", "reply"]);
});

test("a reply sent while disconnected is dropped, not thrown", () => {
  const { sockets, link } = setup();
  link.send("early");
  sockets[0].fire("open");
  sockets[0].fire("close", { code: 1006, reason: "" });
  link.send("late");
  assert.deepEqual(sockets[0].sent, ["auth"]);
});

test("a socket that throws on send and close still reconnects", () => {
  const { sockets, clock, logs, link } = setup();
  sockets[0].fire("open");
  sockets[0].breakSending();
  link.send("reply");
  sockets[0].fire("close", { code: 4000, reason: "replaced" });
  assert.match(logs[1], /closed 4000 replaced/);
  assert.equal(clock.timeouts.length, 1);
});

test("logs connects and disconnects to stderr by default", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const socket = new FakeSocket();
  const { timers, now } = fakeTimers();
  keepLink({ open: () => socket, onOpen: () => {}, onMessage: () => {}, timers, now });
  socket.fire("open");
  socket.fire("error");
  const lines = errors.mock.calls.map(([line]) => line);
  errors.mockRestore();
  assert.match(lines[0], /merit link connected$/);
  assert.match(lines[1], /merit link disconnected \(error\), reconnecting in 1000ms$/);
});

test("keeps a socket that last spoke exactly 90s ago and drops it 1ms later", () => {
  const { sockets, clock } = setup();
  clock.t = 500_000;
  sockets[0].fire("open");
  clock.t = 590_000;
  clock.intervals[0]();
  assert.equal(sockets[0].readyState, 1);
  assert.equal(sockets[0].sent.at(-1), '{"op":"heartbeat"}');
  clock.t = 590_001;
  clock.intervals[0]();
  assert.equal(sockets[0].readyState, 3);
});
