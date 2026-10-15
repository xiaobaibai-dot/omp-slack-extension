import test from "node:test";
import assert from "node:assert/strict";
import {retryNetwork} from "../src/network.ts";
import {requestError} from "../src/request-lifecycle.ts";
import {FakeClock, flush} from "./fake-clock.ts";
const rateLimit = (seconds: number) => Object.assign(new Error("fixture"), {code: "slack_webapi_rate_limited_error", retryAfter: seconds});
test("read retries transient 5xx at most four times with bounded exponential jitter", async () => {
  const clock = new FakeClock(), times: number[] = [];
  const result = retryNetwork(async () => {times.push(clock.now());throw {statusCode: 503};}, {kind: "read", signal: new AbortController().signal, clock});
  void result.catch(() => {});await clock.advance(100_000);await assert.rejects(result, {code: "network_retry_exhausted"});
  assert.equal(times.length, 4);assert.deepEqual(times.slice(1).map((time, i) => time - times[i]!), [350, 700, 1400]);assert.equal(clock.timers.size, 0);
});
test("429 obeys Retry-After before retrying even a mutation", async () => {
  const clock = new FakeClock(), times: number[] = [];
  const result = retryNetwork(async () => {times.push(clock.now());if (times.length === 1) throw rateLimit(2);return "ok";}, {kind: "mutation", signal: new AbortController().signal, clock});
  await flush();await clock.advance(1999);assert.equal(times.length, 1);await clock.advance(101);
  assert.equal(await result, "ok");assert.equal(times.length, 2);assert.ok(times[1]! - times[0]! >= 2000);
});
test("authentication, permissions and parameters are never retried", async () => {
  for (const error of [new TypeError("fixture invalid parameter"), {statusCode: 401}, {statusCode: 403}, {statusCode: 400}, ...["invalid_auth", "missing_scope", "invalid_arguments"].map(code => ({code: "slack_webapi_platform_error", data: {error: code}}))]) {
    let calls = 0;const clock = new FakeClock();
    await assert.rejects(retryNetwork(async () => {calls++;throw error;}, {kind: "read", signal: new AbortController().signal, clock}), {code: "network_failed"});
    assert.equal(calls, 1);assert.equal(clock.timers.size, 0);
  }
});
test("cancelling a backoff is immediate and clears its timer without another call", async () => {
  const clock = new FakeClock(), controller = new AbortController();let calls = 0;
  const result = retryNetwork(async () => {calls++;throw rateLimit(20);}, {kind: "read", signal: controller.signal, clock});
  void result.catch(() => {});await flush();controller.abort(requestError("session_cancelled"));
  await assert.rejects(result, {code: "session_cancelled"});assert.equal(calls, 1);assert.equal(clock.timers.size, 0);
  await clock.advance(120_000);assert.equal(calls, 1);
});
test("a read attempt has a physical abortable deadline and at most four attempts", async () => {
  const clock = new FakeClock(), attempts: AbortSignal[] = [];
  const result = retryNetwork(async signal => {attempts.push(signal);return new Promise(() => {});}, {kind: "read", signal: new AbortController().signal, clock, timeoutMs: 1000});
  void result.catch(() => {});await clock.advance(20_000);await assert.rejects(result, {code: "network_retry_exhausted"});
  assert.equal(attempts.length, 4);assert.ok(attempts.every(signal => signal.aborted));assert.equal(clock.timers.size, 0);
});
test("mutation timeout, lost response and 5xx report uncertain success without resending", async () => {
  for (const error of [{statusCode: 503}, {code: "slack_webapi_request_error", original: {code: "ECONNRESET"}}, undefined]) {
    let calls = 0;const clock = new FakeClock();
    const result = retryNetwork(async () => {calls++;if (error) throw error;return new Promise(() => {});}, {kind: "mutation", signal: new AbortController().signal, clock, timeoutMs: 1000});
    void result.catch(() => {});await clock.advance(5000);await assert.rejects(result, {code: "network_outcome_uncertain"});assert.equal(calls, 1);
  }
});
test("cancelling an in-flight read aborts its signal immediately and never retries", async () => {
  const clock = new FakeClock(), controller = new AbortController();let inner: AbortSignal | undefined, calls = 0;
  const result = retryNetwork(async signal => {inner = signal;calls++;return new Promise(() => {});}, {kind: "read", signal: controller.signal, clock});
  void result.catch(() => {});await flush();controller.abort(requestError("user_cancelled"));
  await assert.rejects(result, {code: "user_cancelled"});assert.equal(inner?.aborted, true);assert.equal(clock.timers.size, 0);assert.equal(calls, 1);
});
test("Retry-After larger than retry budget stops instead of retrying too early", async () => {
  let calls = 0;const clock = new FakeClock();
  await assert.rejects(retryNetwork(async () => {calls++;throw rateLimit(3600);}, {kind: "read", signal: new AbortController().signal, clock}), {code: "network_retry_exhausted"});
  assert.equal(calls, 1);assert.equal(clock.timers.size, 0);
});
test("mutation uncertainty is independent of which transport/server errors reads may retry", async () => {
  const errors = [
    {code:"slack_webapi_request_error", original:{code:"ERR_BAD_RESPONSE"}},
    {code:"slack_webapi_request_error", original:{}},
    {code:"slack_webapi_request_error"},
    {code:"slack_webapi_http_error", statusCode:501},
    {statusCode:505}, {response:{status:599}},
    {code:"slack_webapi_platform_error", data:{error:"unknown_server_error"}},
    new Error("fixture unknown transport failure"),
  ];
  for (const error of errors) {
    const clock = new FakeClock();let calls = 0;
    await assert.rejects(retryNetwork(async () => {calls++;throw error;}, {kind:"mutation",signal:new AbortController().signal,clock}), {code:"network_outcome_uncertain"});
    assert.equal(calls,1);assert.equal(clock.timers.size,0);
    await assert.rejects(retryNetwork(async () => {throw error;}, {kind:"read",signal:new AbortController().signal,clock}), {code:"network_failed"});
  }
});
test("explicit mutation rejection is certain, fatal and never retried", async () => {
  for (const error of [{statusCode:400},{statusCode:401},{statusCode:403},
    ...["invalid_auth","missing_scope","invalid_arguments"].map(code => ({code:"slack_webapi_platform_error",data:{error:code}}))]) {
    const clock = new FakeClock();let calls = 0;
    await assert.rejects(retryNetwork(async () => {calls++;throw error;}, {kind:"mutation",signal:new AbortController().signal,clock}), {code:"network_failed"});
    assert.equal(calls,1);assert.equal(clock.timers.size,0);
  }
});
