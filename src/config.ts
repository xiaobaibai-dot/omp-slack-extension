import type { Config } from "./types.ts";
const USER = /^[UW][A-Z0-9]{2,}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,}$/;
const LOCAL_TOOLS = new Set(["read", "grep", "glob", "write", "edit", "bash"]);
function csv(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map(x => x.trim()).filter(Boolean))];
}
function required(env: NodeJS.ProcessEnv, key: string, pattern: RegExp): string {
  const value = env[key]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`Set a valid ${key} locally before /slack.`);
  return value;
}
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const owners = csv(env.OMP_SLACK_OWNER_IDS);
  if (!owners.length || owners.some(x => !USER.test(x))) {
    throw new Error("Default deny: OMP_SLACK_OWNER_IDS must contain trusted Slack user IDs.");
  }
  const channels = csv(env.OMP_SLACK_CHANNEL_IDS);
  if (channels.some(x => !CHANNEL.test(x))) throw new Error("Invalid OMP_SLACK_CHANNEL_IDS.");
  const localTools = csv(env.OMP_SLACK_LOCAL_TOOLS);
  if (localTools.some(x => !LOCAL_TOOLS.has(x))) {
    throw new Error("OMP_SLACK_LOCAL_TOOLS permits only read,grep,glob,write,edit,bash.");
  }
  return {
    appToken: required(env, "OMP_SLACK_APP_TOKEN", /^xapp-[^\s]+$/),
    botToken: required(env, "OMP_SLACK_BOT_TOKEN", /^xoxb-[^\s]+$/),
    teamId: required(env, "OMP_SLACK_TEAM_ID", /^T[A-Z0-9]{2,}$/),
    appId: required(env, "OMP_SLACK_APP_ID", /^A[A-Z0-9]{2,}$/),
    owners: new Set(owners), channels: new Set(channels), localTools,
    uploadRoot: env.OMP_SLACK_UPLOAD_ROOT?.trim() || undefined,
    maxQueue: 32, maxTaskMs: 10 * 60_000,
  };
}
