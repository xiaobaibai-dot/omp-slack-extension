import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { readConfig } from "./config.ts";

const execute = promisify(execFile);
export async function readWindowsConfig(configPath = path.join(os.homedir(), ".omp", "agent", "slack-credentials.json")) {
  // Windows decrypts only this user's saved Slack configuration. Output stays in
  // this runtime's memory; no environment changes, terminal output, or logging.
  const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')
$c=Get-Content -LiteralPath $env:OMP_SLACK_CONFIG_FILE -Raw | ConvertFrom-Json
$values=@{}
foreach($name in @('OMP_SLACK_TEAM_ID','OMP_SLACK_APP_ID','OMP_SLACK_OWNER_IDS','OMP_SLACK_CHANNEL_IDS','OMP_SLACK_CHANNEL_ALL_USERS','OMP_SLACK_UPLOAD_MODE')) {$values[$name]=[string]$c.$name}
foreach($name in @('OMP_SLACK_BOT_TOKEN','OMP_SLACK_APP_TOKEN')) {
  $s=ConvertTo-SecureString ([string]$c.$name)
  try {$values[$name]=[System.Net.NetworkCredential]::new('', $s).Password} finally {$s.Dispose()}
}
$values | ConvertTo-Json -Compress`;
  try {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, OMP_SLACK_CONFIG_FILE: configPath };
    // PowerShell 7's inherited module path can load incompatible modules in 5.1.
    for (const name of Object.keys(childEnvironment)) if (name.toLowerCase() === "psmodulepath") delete childEnvironment[name];
    const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 15000, maxBuffer: 16384,
      env: childEnvironment,
    });
    return readConfig(JSON.parse(stdout));
  } catch {
    // execFile errors contain captured stdout; never expose the original error.
    throw new Error("Set a valid local Slack configuration using Configure-Slack.ps1 before /slack.");
  }
}
