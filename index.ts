import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SlackBridge } from "./src/bridge.ts";
import { readConfig } from "./src/config.ts";
import { isolatedOptions, runIsolated } from "./src/sdk-runner.ts";
import type { SdkRuntime } from "./src/sdk-runner.ts";
import { SlackTransport } from "./src/slack-transport.ts";
import { makeSlackTools, stringArgument } from "./src/slack-tools.ts";
import { safeError } from "./src/security.ts";

export default function slackExtension(pi: ExtensionAPI) {
  const {AgentRegistry, createAgentSession, SessionManager} = pi.pi;
  // Factory-local: OMP may bind this imported factory again for a fresh session.
  let bridge: SlackBridge | undefined;
  let context: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let lifecycle = 0;
  const runtime: SdkRuntime = {
    create: async options => (await createAgentSession(options)).session,
    settings: overrides => pi.pi.settings.overlay(overrides),
    sessionManager: cwd => SessionManager.inMemory(cwd), registry: () => new AgentRegistry(),
  };
  const stop = async () => {
    ++lifecycle;
    if (timer) { clearInterval(timer); timer = undefined; }
    await bridge?.stop();
  };
  pi.registerCommand("slack", {
    description: "Enable Slack Socket Mode for this session. /slack off | status | channels",
    handler: async (args, ctx) => {
      context = ctx;
      const command = args.trim().toLowerCase();
      if (command === "off") { await stop(); ctx.ui.notify("Slack is off; queued requests and thread memory were cleared.", "info"); return; }
      if (command === "status") { ctx.ui.notify(JSON.stringify(bridge?.status() ?? {state: "off", queued: 0, busy: false}), "info"); return; }
      if (command === "channels") {
        try { const page = await bridge?.listConversations(); if (!page) throw new Error("off"); ctx.ui.notify(JSON.stringify(page), "info"); }
        catch { ctx.ui.notify("Cannot list conversations. Enable Slack and check the app's read scopes.", "warning"); }
        return;
      }
      if (command && command !== "on") { ctx.ui.notify("Usage: /slack [on|off|status|channels]", "warning"); return; }
      if (bridge?.state !== undefined && bridge.state !== "off") { ctx.ui.notify("Slack is already enabled or connecting.", "info"); return; }
      const generation = ++lifecycle;
      let candidate: SlackBridge | undefined;
      try {
        const config = readConfig(process.env);
        if (!ctx.model) throw new Error("Select an OMP model before /slack.");
        const policy = await fs.readFile(new URL("./src/remote-policy.txt", import.meta.url), "utf8");
        if (generation !== lifecycle) return;
        candidate = new SlackBridge(config,
          {canRun: () => Boolean(context?.isIdle() && !context.hasPendingMessages()), notify: (message, level) => context?.ui.notify(message, level ?? "info")},
          () => new SlackTransport(config),
          async (input, capabilities, signal) => {
            const host = context;
            if (!host) throw new Error("Host session ended.");
            const tools = makeSlackTools(pi.zod, capabilities);
            return runIsolated(runtime, isolatedOptions(runtime, host, config, tools, policy), input, signal);
          });
        bridge = candidate;
        await candidate.start();
        if (generation !== lifecycle) { await candidate.stop(); return; }
        if (candidate.state === "on") {
          const enabledBridge = candidate;
          timer = setInterval(() => { void enabledBridge.tick().catch(() => ctx.ui.notify("Slack queue processing failed.", "warning")); }, 250);
          timer.unref?.();
        }
      } catch (error) {
        await candidate?.stop().catch(() => {});
        if (generation !== lifecycle) return;
        const message = error instanceof Error && /^(Set a valid|Default deny|Invalid OMP|OMP_SLACK_LOCAL|Select an OMP)/.test(error.message) ? error.message : `Slack could not start (${safeError(error)}). Check tokens and workspace locally.`;
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
      const page = await bridge.listConversations(stringArgument(params, "cursor", true));
      return {content: [{type: "text", text: JSON.stringify(page)}], details: {}};
    }});
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", async () => { await stop(); context = undefined; });
  pi.on("session_before_switch", async () => { await stop(); });
  pi.on("session_before_branch", async () => { await stop(); });
  pi.on("session_before_tree", async () => { await stop(); });
  pi.on("session_switch", (_event, ctx) => { context = ctx; });
}
