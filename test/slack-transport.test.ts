import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { SlackTransport } from "../src/slack-transport.ts";
import { FakeClock, flush } from "./fake-clock.ts";
import { config, deferred, settle } from "./helpers.ts";
const identity = {ok: true, team_id: "T123", user_id: "UBOT", bot_id: "BBOT"};
const require = createRequire(import.meta.url);
const SocketWebClient = createRequire(require.resolve("@slack/socket-mode"))("@slack/web-api").WebClient as typeof WebClient;
function mockApi(t: TestContext, implementation: (method: string) => Promise<unknown>) {
  // Socket Mode can resolve its own nested Web API version from the lockfile.
  for (const Client of new Set([WebClient, SocketWebClient])) t.mock.method(Client.prototype, "apiCall", implementation);
}
function deadline<T>(operation: Promise<T>, ms = 300): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test deadline exceeded")), ms);
  })]).finally(() => clearTimeout(timer!));
}
test("real SDK initial rate limit rejects promptly instead of retaining an internal retry wait", async t => {
  mockApi(t, async (method: string) => {
    if (method === "auth.test") return identity;
    throw Object.assign(new Error("fixture rate limit"), {code: "slack_webapi_rate_limited_error", retryAfter: 1});
  });
  const transport = new SlackTransport(config());
  await assert.rejects(deadline(transport.start(() => {})), /fixture rate limit/);
  await deadline(transport.stop());
  assert.equal(transport.isReady(), false);
});
test("off cancels pending SDK start and a late authenticated response cannot construct a websocket", async t => {
  const request = deferred<unknown>(); const started = deferred<void>();
  let socket: SocketModeClient | undefined;
  const originalOn = SocketModeClient.prototype.on;
  t.mock.method(SocketModeClient.prototype, "on", function(this: SocketModeClient, event: string, listener: (...args: unknown[]) => void) {
    socket = this; return originalOn.call(this, event, listener);
  });
  mockApi(t, async (method: string) => {
    if (method === "auth.test") return identity;
    if (method === "apps.connections.open") {started.resolve(); return request.promise;}
    throw new Error("network forbidden");
  });
  const transport = new SlackTransport(config());
  const starting = transport.start(() => {});
  const rejected = assert.rejects(deadline(starting), /cancelled/);
  await started.promise; await deadline(transport.stop()); await rejected;
  request.resolve({ok: true, url: "wss://127.0.0.1:1"}); await settle();
  assert.equal(socket!.websocket, undefined);
  assert.equal(transport.isReady(), false);
});
test("unknown reconnect failures stop after three failures, not forever", async t => {
  mockApi(t, async () => identity);
  const clock = new FakeClock();let socket: SocketModeClient | undefined;let starts = 0, lost = 0;
  t.mock.method(SocketModeClient.prototype, "start", async function(this: SocketModeClient) {
    socket = this;if (++starts > 1) throw new Error("PRIVATE unknown fixture");this.emit("connected");return {ok: true};
  });
  const transport = new SlackTransport(config(), clock);
  try {
    await transport.start(() => {}, () => {lost++;});socket!.emit("close");
    await clock.advance(30_000);assert.equal(starts, 4);assert.equal(lost, 1);assert.equal(transport.isReady(), false);
    assert.equal(transport.connectionStatus().state, "stopped");await clock.advance(300_000);assert.equal(starts, 4);
  } finally {await transport.stop();}
});
test("off clears a scheduled reconnect before any additional SDK start", async t => {
  mockApi(t, async () => identity);
  const clock = new FakeClock();let socket: SocketModeClient | undefined;let starts = 0;
  t.mock.method(SocketModeClient.prototype, "start", async function(this: SocketModeClient) {socket = this;++starts;this.emit("connected");return {ok: true};});
  const transport = new SlackTransport(config(), clock);
  await transport.start(() => {});socket!.emit("close");await flush();await transport.stop();
  await clock.advance(120_000);assert.equal(starts, 1);assert.equal(clock.timers.size, 0);
});
test("a supplied auth app identity from another app is refused before Socket Mode starts", async t => {
  mockApi(t, async () => ({...identity, app_id: "AOTHER"}));
  let starts = 0;
  t.mock.method(SocketModeClient.prototype, "start", async () => {++starts; return {ok: true};});
  const transport = new SlackTransport(config());
  await assert.rejects(transport.start(() => {}), /verification/);
  assert.equal(starts, 0); await transport.stop();
});
test("disconnect after handshake before start continuation cannot mark transport ready", async t => {
  mockApi(t, async () => identity);
  t.mock.method(SocketModeClient.prototype, "start", async function(this: SocketModeClient) {
    this.emit("connected"); this.emit("close"); return {ok: true};
  });
  const transport = new SlackTransport(config());
  await assert.rejects(transport.start(() => {}), /socket_closed/);
  assert.equal(transport.isReady(), false); await transport.stop();
});
