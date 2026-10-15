import { randomUUID } from "node:crypto";
import type { AgentRegistry, CreateAgentSessionOptions, ExtensionContext, SessionManager, Settings, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { RunInput } from "./bridge.ts";
import type { Capabilities, Config } from "./types.ts";
export interface WorkerSession {
  prompt(text: string, options?: {expandPromptTemplates?: boolean; throwOnDrop?: boolean}): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
export interface SdkRuntime {
  create(options: CreateAgentSessionOptions): Promise<WorkerSession>;
  settings(overrides: Readonly<Record<string, unknown>>): Settings;
  sessionManager(cwd: string): SessionManager;
  registry(): AgentRegistry;
}
export interface ModelContext { cwd: string; model: ExtensionContext["model"]; modelRegistry: ExtensionContext["modelRegistry"] }
export function isolatedOptions(runtime: SdkRuntime, host: ModelContext, config: Config, tools: ToolDefinition[], policy: string): CreateAgentSessionOptions {
  if (!host.model) throw new Error("Select an OMP model before enabling Slack.");
  return {
    cwd: host.cwd, model: host.model, modelRegistry: host.modelRegistry,
    sessionManager: runtime.sessionManager(host.cwd),
    settings: runtime.settings({"advisor.enabled": false, "memory.backend": "off", "autolearn.enabled": false,
      "includeWorkspaceTree": false, "providers.cacheWarming": "off"}),
    agentRegistry: runtime.registry(),
    parentTaskPrefix: `slack-${randomUUID()}`, bindProcessState: false,
    systemPrompt: [policy], customTools: tools,
    toolNames: [...tools.map(t => t.name), ...config.localTools],
    restrictToolNames: true, allowRestrictedCustomTools: true,
    disableExtensionDiscovery: true, extensions: [], additionalExtensionPaths: [],
    skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [], additionalDirectories: [],
    enableMCP: false, enableLsp: false, enableIrc: false, skipPythonPreflight: true,
    deadline: config.maxTaskMs === undefined ? undefined : Date.now() + config.maxTaskMs,
    cacheWarming: false, hasUI: false, interactivePrompts: false, spawns: "",
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
export function finalText(event: unknown): string | undefined {
  const e = record(event);
  // SDK subscription events use isTerminal; extension on(agent_end) uses willContinue.
  if (e?.type !== "agent_end" || e.isTerminal !== true || !Array.isArray(e.messages)) return;
  const last = [...e.messages].reverse().map(record).find(m => m?.role === "assistant");
  if (!last || last.stopReason !== "stop" || !Array.isArray(last.content)) return;
  if (last.content.some(part => record(part)?.type === "toolCall")) return;
  const text = last.content.map(record).filter(part => part?.type === "text" && typeof part.text === "string").map(part => part!.text as string).join("\n").trim();
  return text || undefined;
}
export async function runIsolated(runtime: SdkRuntime, options: CreateAgentSessionOptions, input: RunInput, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const session = await runtime.create(options);
  let unsubscribe = () => {};
  const abort = () => { void session.abort().catch(() => {}); };
  try {
    // stop may have arrived while SDK construction was awaiting: never prompt a late child.
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, {once: true});
    let answer: string | undefined;
    unsubscribe = session.subscribe(event => {
      const e = record(event);
      if (e?.type === "agent_start" || (e?.type === "agent_end" && e.isTerminal === true)) answer = finalText(event);
    });
    // JSON keeps history visibly data; it never controls the route or tool authorization.
    const prompt = JSON.stringify({source: "authenticated Slack owner request", route: input.job.route,
      prior_same_route_turns: input.history, request: input.job.text});
    await session.prompt(prompt, {expandPromptTemplates: false, throwOnDrop: true});
    await session.waitForIdle();
    signal.throwIfAborted();
    if (!answer) throw new Error("No terminal successful assistant reply.");
    return answer;
  } finally {
    signal.removeEventListener("abort", abort);
    unsubscribe();
    await session.dispose();
  }
}
