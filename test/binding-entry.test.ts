import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import slackExtension from "../index.ts";
import {LocalBinding} from "../src/binding.ts";
import {SlackTransport} from "../src/slack-transport.ts";
import {config, settle, deferred, envelope} from "./helpers.ts";
import type {RequestLog} from "../src/request-lifecycle.ts";

// Exercise the command/lifecycle entry point with real IPC ownership. Only the
// Slack network boundary and OMP context are fixtures; no credentials are read.
async function withEntry(run: (entry: ReturnType<typeof entryFixture>) => Promise<void>) {
  const entry = entryFixture();
  try {await run(entry);} finally {await entry.cleanup();}
}
function entryFixture() {
  const namespace = `omp-slack-entry-${randomUUID()}`, settings = config();
  const originalAcquire = LocalBinding.acquire;
  const originalStart = SlackTransport.prototype.start;
  const originalStop = SlackTransport.prototype.stop;
  const originalPost = SlackTransport.prototype.post;
  const originalReady = SlackTransport.prototype.isReady;
  const leases: LocalBinding[] = [], physical = new Set<SlackTransport>();
  let failStop = false, failStart = false, starts = 0, stops = 0;
  let disconnected: ((error: unknown) => void) | undefined;
  let incoming: ((body: unknown) => void) | undefined, workAllowed = false, posts = 0;
  const logs: RequestLog[] = [], work = deferred<void>();
  const manager = {appendCustomEntry: (_type: string, entry: RequestLog) => {logs.push(entry);return "fixture";}};
  const main = {sessionManager: manager, isStreaming: false, aborted: 0, messages: [] as any[],
    listener: (_event: any) => {},
    subscribe(listener: (event: any) => void) {this.listener = listener;return () => {this.listener = () => {};};},
    async prompt(text: string, options: any) {
      this.isStreaming = true;options.onPromptAdmitted?.();
      const message = {role: "user", content: [{type: "text", text}]};this.messages.push(message);
      this.listener({type: "message_start", message});await work.promise;this.isStreaming = false;
    },
    async waitForIdle() {}, async abort() {this.aborted++;this.isStreaming = false;work.resolve();},
    getQueuedMessages: () => ({followUp: [], steering: [], liveSteered: 0}), removeQueuedMessage: () => false};
  LocalBinding.acquire = async options => {
    const lease = await originalAcquire({...options, namespace, timeoutMs: 1000});
    leases.push(lease);return lease;
  };
  SlackTransport.prototype.start = async function (_event, onDisconnect) {
    ++starts;assert.equal(physical.size, 0, "new Socket Mode connection must wait for physical shutdown");
    physical.add(this);disconnected = onDisconnect;incoming = _event;
    if (failStart) throw new Error("Fixture startup failure");
    return {teamId: settings.teamId, botUserId: "UBOT"};
  };
  SlackTransport.prototype.stop = async function () {
    ++stops;
    if (failStop && physical.has(this)) throw new Error("Fixture shutdown failure");
    physical.delete(this);
  };
  SlackTransport.prototype.post = async () => {posts++;};
  SlackTransport.prototype.isReady = function () {return physical.has(this);};
  const notices: string[] = [];
  const ctx = {cwd: process.cwd(), sessionManager: manager, model: {id: "FIXTURE"},
    isIdle: () => workAllowed && !main.isStreaming, hasPendingMessages: () => false,
    ui: {notify: (message: string) => notices.push(message)}};
  let handler: (args: string, context: unknown) => Promise<void>;
  const lifecycle = new Map<string, (...args: unknown[]) => Promise<void>>();
  const zod = {string: () => ({optional: () => ({})}), object: () => ({})};
  slackExtension({pi: {AgentRegistry: {global: () => ({get: () => ({session: main})})}, MAIN_AGENT_ID: "main"},
    zod, registerTool: () => {}, registerCommand: (_name: string, command: {handler: typeof handler}) => {handler = command.handler;},
    on: (name: string, callback: (...args: unknown[]) => Promise<void>) => lifecycle.set(name, callback)} as never,
    async () => ({...settings}));
  return {
    command: (args: string) => handler!(args, ctx), notices, leases, physical, logs, main,
    beginRequest: () => {workAllowed = true;incoming?.(envelope("EvEntry"));},
    lifecycleEvent: (name: string) => lifecycle.get(name)?.(),
    get posts() {return posts;},
    get starts() {return starts;}, get stops() {return stops;},
    failStop: (value: boolean) => {failStop = value;}, failStart: (value: boolean) => {failStart = value;},
    disconnect: () => disconnected?.(new Error("Fixture disconnected")),
    claim: () => originalAcquire({key: `${settings.teamId}:${settings.appId}`, namespace, timeoutMs: 1000, onTakeover: async () => {}}),
    async cleanup() {
      failStop = false;failStart = false;
      try {await lifecycle.get("session_shutdown")?.();work.resolve();await settle();await Promise.all(leases.map(lease => lease.release()));}
      finally {LocalBinding.acquire = originalAcquire;SlackTransport.prototype.start = originalStart;SlackTransport.prototype.stop = originalStop;SlackTransport.prototype.post = originalPost;SlackTransport.prototype.isReady = originalReady;}
    },
  };
}

test("entry retains a failed off connection and retries shutdown before enabling", () => withEntry(async entry => {
  await entry.command("on");assert.equal(entry.physical.size, 1);
  entry.failStop(true);await assert.rejects(entry.command("off"));
  assert.equal(entry.leases[0]!.isOwner(), true);
  await entry.command("on");assert.equal(entry.starts, 1);
  assert.ok(entry.notices.some(text => text.includes("previous Slack connection has not closed")));
  entry.failStop(false);await entry.command("on");
  assert.equal(entry.starts, 2);assert.equal(entry.physical.size, 1);
  assert.equal(entry.leases[0]!.isOwner(), false);assert.equal(entry.leases[1]!.isOwner(), true);
}));

test("entry preserves ownership after failed takeover and the next takeover retries it", () => withEntry(async entry => {
  await entry.command("on");entry.failStop(true);
  await assert.rejects(entry.claim(), /could not confirm/);
  assert.equal(entry.leases[0]!.isOwner(), false);assert.equal(entry.physical.size, 1);
  entry.failStop(false);
  const next = await entry.claim();
  try {assert.equal(entry.physical.size, 0);assert.equal(next.isOwner(), true);}
  finally {await next.release();}
  await entry.command("on");assert.equal(entry.starts, 2);assert.equal(entry.physical.size, 1);
}));

test("entry can use off to recover its retained reference after failed takeover", () => withEntry(async entry => {
  await entry.command("on");entry.failStop(true);
  await assert.rejects(entry.claim(), /could not confirm/);
  entry.failStop(false);await entry.command("off");assert.equal(entry.physical.size, 0);
  const next = await entry.claim();try {assert.equal(next.isOwner(), true);} finally {await next.release();}
}));

test("entry retains startup cleanup failures for a later off instead of releasing early", () => withEntry(async entry => {
  entry.failStart(true);entry.failStop(true);await entry.command("on");
  assert.equal(entry.physical.size, 1);assert.equal(entry.leases[0]!.isOwner(), true);
  assert.ok(entry.notices.some(text => text.includes("ownership is retained")));
  entry.failStart(false);entry.failStop(false);await entry.command("off");
  assert.equal(entry.physical.size, 0);await entry.command("on");assert.equal(entry.starts, 2);
}));

test("entry retains failed disconnect cleanup until physical shutdown succeeds", () => withEntry(async entry => {
  await entry.command("on");entry.failStop(true);entry.disconnect();await settle();
  assert.equal(entry.leases[0]!.isOwner(), true);assert.equal(entry.physical.size, 1);
  entry.failStop(false);await entry.command("off");assert.equal(entry.physical.size, 0);
  await entry.command("on");assert.equal(entry.starts, 2);
}));
test("entry off logs cancellation and warns admitted work may continue without aborting the main session", () => withEntry(async entry => {
  await entry.command("on");entry.beginRequest();await settle();await entry.command("status");
  const status = JSON.parse(entry.notices.findLast(text => text.startsWith('{"state"'))!);
  assert.equal(status.host.streaming, true);assert.equal(status.host.idle, false);
  await entry.command("off");await settle();assert.equal(entry.main.aborted, 0);
  assert.equal(entry.logs.at(-1)?.reason, "user_cancelled");assert.equal(entry.posts, 0);
  assert.ok(entry.notices.some(text => text.includes("Already admitted or claimed native work may continue")));
  assert.equal(entry.logs[0]!.requestId, entry.logs[1]!.requestId);
}));
test("entry session shutdown logs session cancellation without clearing the transcript", () => withEntry(async entry => {
  await entry.command("on");entry.beginRequest();await settle();
  await entry.lifecycleEvent("session_shutdown");await settle();
  assert.equal(entry.logs.at(-1)?.reason, "session_cancelled");assert.equal(entry.main.aborted, 0);
  assert.equal(entry.main.messages.length, 1);assert.equal(entry.posts, 0);
}));
test("entry IPC takeover revokes old reply permission without aborting the main turn", () => withEntry(async entry => {
  await entry.command("on");entry.beginRequest();await settle();const next = await entry.claim();
  try {await settle();assert.equal(next.isOwner(), true);assert.equal(entry.physical.size, 0);
    assert.equal(entry.main.aborted, 0);assert.equal(entry.logs.at(-1)?.reason, "binding_taken_over");assert.equal(entry.posts, 0);}
  finally {await next.release();}
}));

test("entry off/on retains event deduplication across newly constructed bridges", () => withEntry(async entry => {
  await entry.command("on");entry.beginRequest();await settle();
  assert.equal(entry.main.messages.length, 1);
  await entry.command("off");await entry.command("on");entry.beginRequest();await settle();
  assert.equal(entry.starts, 2);assert.equal(entry.main.messages.length, 1);
  assert.equal(entry.main.aborted, 0);assert.equal(entry.posts, 0);
}));
