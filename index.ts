import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SlackBridge } from "./src/bridge.ts";
import { readConfig } from "./src/config.ts";
import { runShared } from "./src/shared-runner.ts";
import type {HostActivity} from "./src/shared-runner.ts";
import { SlackTransport } from "./src/slack-transport.ts";
import { makeSlackTools, stringArgument } from "./src/slack-tools.ts";
import { safeError } from "./src/security.ts";
import {LocalBinding} from "./src/binding.ts";
import type {CancellationReason} from "./src/request-lifecycle.ts";

export default function slackExtension(pi: ExtensionAPI, configuration = async () => readConfig(process.env)) {
  const {AgentRegistry, MAIN_AGENT_ID} = pi.pi;
  // Factory-local: OMP may bind this imported factory again for a fresh session.
  let bridge: SlackBridge | undefined;
  let context: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lifecycle = 0;
  let binding: LocalBinding | undefined;
  let bindingRequest: AbortController | undefined;
  let activeCapabilities: import("./src/types.ts").Capabilities | undefined;
  let ownedTurn = false;
  let lastActivity: HostActivity | undefined;
  const capabilities = () => {if (!ownedTurn || !activeCapabilities) throw new Error("No active Slack-owned turn."); return activeCapabilities;};
  for (const tool of makeSlackTools(pi.zod, {
    reply: text => capabilities().reply(text), readThread: cursor => capabilities().readThread(cursor),
    upload: (file, title) => capabilities().upload(file, title), listConversations: () => capabilities().listConversations(),
    download: async (fileId, target) => {const action = capabilities().download; if (!action) throw new Error("Download unavailable."); return action(fileId, target);},
  }).filter(tool => tool.name !== "slack_list_conversations")) pi.registerTool(tool);
  const stop = async (releaseBinding = true, reason: CancellationReason = "user_cancelled") => {
    ++lifecycle;
    bindingRequest?.abort(); bindingRequest = undefined;
    if (timer) { clearInterval(timer); timer = undefined; }
    const oldBinding = binding;
    await bridge?.stop(reason);
    if (releaseBinding) {
      await oldBinding?.release();
      if (binding === oldBinding) binding = undefined;
    }
  };
  pi.registerCommand("slack", {
    description: "Enable Slack Socket Mode for this session. /slack off | status | channels",
    handler: async (args, ctx) => {
      context = ctx;
      const command = args.trim().toLowerCase();
      if (command === "off") { await stop(); ctx.ui.notify("Slack is off; pending Slack requests were cancelled. Main conversation preserved.", "info"); return; }
      if (command === "status") {
        const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
        ctx.ui.notify(JSON.stringify({...bridge?.status() ?? {state: "off", queued: 0, busy: false},
          host: {idle: ctx.isIdle(), pendingMessages: ctx.hasPendingMessages(),
            streaming: session?.sessionManager === ctx.sessionManager ? session.isStreaming : null,
            lastObservedActivity: lastActivity}}), "info");return;
      }
      if (command === "channels") {
        try { const page = await bridge?.listConversations(); if (!page) throw new Error("off"); ctx.ui.notify(JSON.stringify(page), "info"); }
        catch { ctx.ui.notify("Cannot list conversations. Enable Slack and check the app's read scopes.", "warning"); }
        return;
      }
      if (command && command !== "on") { ctx.ui.notify("Usage: /slack [on|off|status|channels]", "warning"); return; }
      if (bindingRequest || (bridge?.state !== undefined && bridge.state !== "off")) { ctx.ui.notify("Slack is already enabled or connecting.", "info"); return; }
      if (binding) {
        try {await stop();}
        catch {ctx.ui.notify("The previous Slack connection has not closed. Retry /slack off or /slack.", "error");return;}
      }
      if (timer) { clearInterval(timer); timer = undefined; }
      const generation = ++lifecycle;
      let candidate: SlackBridge | undefined;
      let candidateBinding: LocalBinding | undefined;
      try {
        const config = await configuration();
        if (!ctx.model) throw new Error("Select an OMP model before /slack.");
        config.cwd = ctx.cwd;
        const mainSession = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
        if (!mainSession || mainSession.sessionManager !== ctx.sessionManager) throw new Error("This OMP session could not be identified for binding.");
        if (generation !== lifecycle) return;
        candidate = new SlackBridge(config,
          {canRun: () => Boolean(context?.isIdle() && !context.hasPendingMessages()), notify: (message, level) => context?.ui.notify(message, level ?? "info"),
            log: entry => {mainSession.sessionManager.appendCustomEntry("omp_slack_request", entry);}},
          () => new SlackTransport(config),
          async (input, capabilities, signal) => {
            const host = context;
            if (!host) throw new Error("Host session ended.");
            if (host.sessionManager !== mainSession.sessionManager) throw new Error("Bound OMP session changed.");
            activeCapabilities = capabilities;
            host.ui.notify("Slack request started in this main session.", "info");
            try {
              const reply = await runShared(mainSession, input, signal, owned => {ownedTurn = owned;}, activity => {lastActivity = activity;});
              host.ui.notify("Slack request completed in this main session.", "info");
              return reply;
            } finally {activeCapabilities = undefined; ownedTurn = false;}
          });
        bridge = candidate;
        lastActivity = undefined;
        const request = new AbortController(); bindingRequest = request;
        candidateBinding = await LocalBinding.acquire({key: `${config.teamId}:${config.appId}`,
          signal: request.signal,
          onTakeover: async () => {
            if (generation === lifecycle) {
              await stop(false, "binding_taken_over");
              ctx.ui.notify("Slack moved to another OMP conversation; this binding is off.", "info");
            } else await candidate?.stop("binding_taken_over");
            if (binding === candidateBinding) binding = undefined;
          }});
        if (bindingRequest === request) bindingRequest = undefined;
        if (generation !== lifecycle || !candidateBinding.isOwner()) {await candidateBinding.release(); return;}
        binding = candidateBinding;
        await candidate.start();
        if (generation !== lifecycle) { await candidate.stop(); await candidateBinding.release(); return; }
        if (candidate.state === "on") {
          const enabledBridge = candidate;
          const enabledTimer = setInterval(() => {
            if (enabledBridge.state === "off") {
              clearInterval(enabledTimer);
              if (timer === enabledTimer) timer = undefined;
              void enabledBridge.stop().then(async () => {
                if (binding === candidateBinding) {
                  await candidateBinding?.release();
                  if (binding === candidateBinding) binding = undefined;
                }
              }).catch(() => {});
              return;
            }
            void enabledBridge.tick().catch(() => ctx.ui.notify("Slack queue processing failed.", "warning"));
          }, 250);
          timer = enabledTimer;
          enabledTimer.unref?.();
        }
      } catch (error) {
        let closed = true;
        try {await candidate?.stop();} catch {closed = false;}
        if (generation === lifecycle) bindingRequest = undefined;
        if (closed) {
          await candidateBinding?.release();
          if (binding === candidateBinding) binding = undefined;
        }
        if (generation !== lifecycle) return;
        if (!closed) {ctx.ui.notify("Slack could not close its previous connection. Retry /slack off; ownership is retained.", "error");return;}
        const message = error instanceof Error && /^(Set a valid|Default deny|Invalid OMP|OMP_SLACK_LOCAL|Select an OMP|Slack takeover)/.test(error.message) ? error.message : `Slack could not start (${safeError(error)}). Check tokens and workspace locally.`;
        ctx.ui.notify(message, "error");
      }
    },
  });
  // Local terminal-only directory tool; never handed to remote workers.
  pi.registerTool({name: "slack_list_conversations", label: "List bot-accessible Slack conversations", loadMode: "essential", approval: "read",
    description: "List at most 100 conversations accessible to the enabled Slack bot. Local terminal only. Optional cursor for the next page; do not publish private names into a channel.",
    parameters: pi.zod.object({cursor: pi.zod.string().optional()}),
    async execute(_id, params) {
      if (!bridge) throw new Error("Run /slack first.");
      const page = activeCapabilities ? await capabilities().listConversations() : await bridge.listConversations(stringArgument(params, "cursor", true));
      return {content: [{type: "text", text: JSON.stringify(page)}], details: {}};
    }});
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", async () => { await stop(true, "session_cancelled"); context = undefined; });
  pi.on("session_before_switch", async () => { await stop(true, "session_cancelled"); });
  pi.on("session_before_branch", async () => { await stop(true, "session_cancelled"); });
  pi.on("session_before_tree", async () => { await stop(true, "session_cancelled"); });
  pi.on("session_switch", (_event, ctx) => { context = ctx; });
}
