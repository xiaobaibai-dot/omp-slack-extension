import test from "node:test";
import assert from "node:assert/strict";
import {WebClient} from "@slack/web-api";
import {SocketModeClient} from "@slack/socket-mode";
import {SlackTransport} from "../src/slack-transport.ts";
import {config, job, settle} from "./helpers.ts";
import {FakeClock, flush} from "./fake-clock.ts";
const identity = {ok: true, team_id: "T123", user_id: "UBOT", bot_id: "BBOT"};
type TestMocks = {mock: {method(target: any, name: string, implementation: any): void}};
// Bun 1.3 does not implement node:test's MockTracker. Restore explicit fixture
// patches in finally so these same boundary tests run on both Node and Bun.
function fixtureTest(name: string, body: (t: TestMocks) => Promise<void>) {
  test(name, async () => {
    const undo: (() => void)[] = [];
    const t: TestMocks = {mock: {method(target, key, implementation) {
      const original = target[key];undo.push(() => {target[key] = original;});target[key] = implementation;
    }}};
    try {await body(t);} finally {for (const restore of undo.reverse()) restore();}
  });
}
function setup(t: TestMocks, api: (method: string, args: any) => Promise<unknown>) {
  t.mock.method(SocketModeClient.prototype, "start", async function (this: SocketModeClient) {this.emit("connected");return {ok: true};});
  t.mock.method(SocketModeClient.prototype, "disconnect", async function (this: SocketModeClient) {this.emit("disconnected");});
  t.mock.method(WebClient.prototype, "apiCall", async function (this: WebClient, method: string, args: any) {
    assert.equal((this as any).retryConfig.retries, 0);assert.equal((this as any).rejectRateLimitedCalls, true);
    return method === "auth.test" ? identity : api(method, args);
  });
}
fixtureTest("transport retries rejected 429 post after its delay, but loses no duplicate successful message", async t => {
  const clock = new FakeClock();let calls = 0;
  setup(t, async method => {assert.equal(method, "chat.postMessage");if (++calls === 1) throw {code: "slack_webapi_rate_limited_error", retryAfter: 2};return {ok: true};});
  const transport = new SlackTransport(config(), clock);await transport.start(() => {});
  try {const pending = transport.post(job().route, "body");await flush();await clock.advance(2000);assert.equal(calls, 1);
    await clock.advance(100);await pending;assert.equal(calls, 2);}
  finally {await transport.stop();}
});
fixtureTest("transport post lost response is uncertain and is never resent", async t => {
  let calls = 0;setup(t, async () => {calls++;throw {code: "slack_webapi_request_error", original: {code: "ECONNRESET"}};});
  const transport = new SlackTransport(config(), new FakeClock());await transport.start(() => {});
  try {await assert.rejects(transport.post(job().route, "body"), {code: "network_outcome_uncertain"});assert.equal(calls, 1);}
  finally {await transport.stop();}
});
fixtureTest("upload completion 5xx stops without reallocating, reuploading or repeating completion", async t => {
  const calls: string[] = [];let bytes = 0;
  setup(t, async method => {calls.push(method);
    if (method === "files.getUploadURLExternal") return {ok: true, upload_url: "https://files.slack.com/upload/FOUTPUT", file_id: "FOUTPUT"};
    assert.equal(method, "files.completeUploadExternal");throw {statusCode: 503};
  });
  t.mock.method(globalThis, "fetch", async () => {bytes++;return new Response("ok");});
  const transport = new SlackTransport(config(), new FakeClock());await transport.start(() => {});
  try {await assert.rejects(transport.upload(job().route, Buffer.from("fixture"), "fixture.txt", "fixture", new AbortController().signal), {code: "network_outcome_uncertain"});
    assert.deepEqual(calls, ["files.getUploadURLExternal", "files.completeUploadExternal"]);assert.equal(bytes, 1);}
  finally {await transport.stop();}
});
fixtureTest("off cancels a transport read backoff before another API call", async t => {
  const clock = new FakeClock();let calls = 0;setup(t, async method => {assert.equal(method, "conversations.replies");calls++;throw {statusCode: 503};});
  const transport = new SlackTransport(config(), clock);await transport.start(() => {});
  const pending = transport.readThread(job().route);void pending.catch(() => {});await flush();await transport.stop();
  await assert.rejects(pending);await clock.advance(120_000);assert.equal(calls, 1);assert.equal(clock.timers.size, 0);
});
fixtureTest("real WebClient request interceptor physically aborts its Axios adapter on off", async t => {
  const original = WebClient.prototype.apiCall;let calls = 0, adapterSignal: AbortSignal | undefined;
  t.mock.method(SocketModeClient.prototype, "start", async function (this: SocketModeClient) {this.emit("connected");return {ok: true};});
  t.mock.method(SocketModeClient.prototype, "disconnect", async function (this: SocketModeClient) {this.emit("disconnected");});
  t.mock.method(WebClient.prototype, "apiCall", function (this: WebClient, method: string, args: any) {
    if (method === "auth.test") return Promise.resolve(identity);
    (this as any).axios.defaults.adapter = (request: any) => {
      calls++;adapterSignal = request.signal;
      return new Promise((_resolve, reject) => {request.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("fixture adapter cancellation"), {request: {}, code: "ERR_CANCELED"})), {once: true});});
    };
    return original.call(this, method, args);
  });
  const transport = new SlackTransport(config(), new FakeClock());await transport.start(() => {});
  const pending = transport.list();void pending.catch(() => {});await settle();assert.equal(calls, 1);
  await transport.stop();await assert.rejects(pending);assert.equal(adapterSignal?.aborted, true);assert.equal(calls, 1);
});
