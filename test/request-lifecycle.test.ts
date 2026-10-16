import test from "node:test";
import assert from "node:assert/strict";
import {SlackBridge} from "../src/bridge.ts";
import {requestError, failureReason} from "../src/request-lifecycle.ts";
import {config, deferred, envelope, FakeTransport, host, settle} from "./helpers.ts";
import {FakeClock} from "./fake-clock.ts";
import {retryNetwork} from "../src/network.ts";

test("default main-session work survives eight hours without a bridge or idle deadline", async () => {
  const clock = new FakeClock(), h = host(), transport = new FakeTransport(), gate = deferred<void>();let signal: AbortSignal | undefined;
  const b = new SlackBridge(config(), h, () => transport, async (_input, _caps, s) => {signal = s;await gate.promise;return "done";}, clock);
  // Intercept native timers too, so reintroducing the former setTimeout(...,
  // 600000) cannot evade this regression by bypassing the diagnostic clock.
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: (...args: any[]) => void, ms = 0, ...args: any[]) => clock.setTimeout(() => fn(...args), ms)) as typeof setTimeout;
  globalThis.clearTimeout = (timer => clock.clearTimeout(timer as NodeJS.Timeout)) as typeof clearTimeout;
  try {
    await b.start();b.accept(envelope("EvLong"));await settle();
    await clock.advance(8 * 60 * 60_000);assert.equal(signal?.aborted, false);assert.equal(clock.timers.size, 0);
    assert.equal(h.logs[0]?.eventId, "EvLong");gate.resolve();await settle();
    assert.equal(h.logs[1]?.reason, "completed");
    assert.equal(Date.parse(h.logs[1]!.endedAt!) - Date.parse(h.logs[0]!.startedAt), 8 * 60 * 60_000);
  } finally {gate.resolve();await b.stop();globalThis.setTimeout = originalSet;globalThis.clearTimeout = originalClear;}
});
test("off, session close and takeover preserve distinct cancellation reasons and suppress late sends", async () => {
  for (const reason of ["user_cancelled", "session_cancelled", "binding_taken_over"] as const) {
    const clock = new FakeClock(), h = host(), t = new FakeTransport(), gate = deferred<void>();let signal: AbortSignal | undefined;
    const b = new SlackBridge(config(), h, () => t, async (_i, _c, s) => {signal = s;await gate.promise;return "late";}, clock);
    await b.start();b.accept(envelope("EvCancel"));await settle();await clock.advance(1234);
    await b.stop(reason);assert.equal(signal?.aborted, true);assert.equal(signal?.reason.code, reason);
    gate.resolve();await settle();assert.equal(t.posts.length, 0);assert.equal(h.logs.at(-1)?.reason, reason);
    assert.equal(h.logs[0]!.requestId, h.logs[1]!.requestId);assert.equal(h.logs[1]!.threadId, h.logs[0]!.threadId);
    assert.equal(clock.timers.size, 0);
  }
});
test("request logs exclude text, replies, errors and tokens; unknown failures retain No automatic retry", async () => {
  const h = host(), t = new FakeTransport();
  const b = new SlackBridge(config(), h, () => t, async () => {throw Object.assign(new Error("xoxb-FAKE_SECRET_MESSAGE"), {body: "secret request details"});});
  await b.start();b.accept(envelope("EvUnknown", "C111", "xapp-FAKE_SECRET_BODY"));await settle();
  assert.equal(h.logs.at(-1)?.reason, "operation_failed");
  assert.ok(h.notifications.some(message => message.includes("No automatic retry")));
  assert.doesNotMatch(JSON.stringify(h.logs), /FAKE_SECRET|secret request|requestText|appToken|botToken/);
  assert.deepEqual(Object.keys(h.logs[1]!).sort(), ["phase", "eventId", "requestId", "teamId", "channelId", "threadId", "messageTs", "startedAt", "endedAt", "reason"].sort());
  await b.stop();
});
test("uncertain explicit delivery preserves source reads and blocks further sends and automatic final", async () => {
  const h = host(), t = new FakeTransport();let calls = 0;
  t.post = async () => {calls++;throw requestError("network_outcome_uncertain");};
  const b = new SlackBridge(config(), h, () => t, async (_i, caps, signal) => {
    await assert.rejects(caps.reply("body"));assert.equal(signal.aborted, false);
    await caps.readThread();
    await assert.rejects(caps.reply("body again"));return "try another final";
  });
  await b.start();b.accept(envelope("EvUncertain"));await settle();
  assert.equal(calls, 1);assert.equal(h.logs.at(-1)?.reason, "network_outcome_uncertain");await b.stop();
});
test("known cancellation is distinct from abort errors and unknown operation failures", () => {
  assert.equal(failureReason(requestError("session_cancelled")), "session_cancelled");
  assert.equal(failureReason(new DOMException("aborted", "AbortError")), "user_cancelled");
  assert.equal(failureReason(new Error("unknown")), "operation_failed");
});
test("unclassified mutation response failures stop bridge duplicate replies and automatic fallback", async () => {
  for (const error of [{code:"slack_webapi_request_error",original:{code:"ERR_BAD_RESPONSE"}},
    {code:"slack_webapi_request_error",original:{}},{code:"slack_webapi_request_error"},{statusCode:501},{statusCode:505}]) {
    const clock = new FakeClock(), h = host(), t = new FakeTransport();let calls = 0;
    t.post = async (route, text) => retryNetwork(async () => {
      // Simulate a committed send followed by an unusable response.
      calls++;t.posts.push({route,text});throw error;
    }, {kind:"mutation",signal:new AbortController().signal,clock});
    const b = new SlackBridge(config(),h,()=>t,async (_i,caps,signal) => {
      await assert.rejects(caps.reply("requested body"),{code:"network_outcome_uncertain"});
      assert.equal(signal.aborted,false);await caps.readThread();await assert.rejects(caps.reply("requested body again"));return "automatic fallback";
    },clock);
    await b.start();b.accept(envelope("EvAmbiguous"));await settle();
    assert.equal(calls,1);assert.deepEqual(t.posts.map(post=>post.text),["requested body"]);
    assert.equal(h.logs.at(-1)?.reason,"network_outcome_uncertain");assert.equal(b.status().busy,false);
    await b.stop();
  }
});
