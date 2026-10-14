# OMP Slack Extension

English | [简体中文](README.zh-CN.md)

Default-off Slack Socket Mode integration for oh-my-pi 18.10.4. Prototype: cloud mock tests pass; real Slack and Windows integration remain unverified.

## Behavior

- `/slack` or `/slack on` enables this terminal session; `/slack off` disconnects, clears queue/history and aborts current work. `/slack status` shows state; `/slack channels` lists bot-accessible conversations locally.
- Only configured owner IDs in the configured workspace/app may trigger work. Channel requests require an @mention every time; 1:1 DMs trigger directly. Other bots, edits, group DMs and unauthorized users are ignored.
- FIFO queue (32 pending), event deduplication, 10 minute per-request deadline. Work starts while the host is idle, without injecting or steering the host transcript.
- Each request uses an isolated in-memory SDK AgentSession and a bounded history from that same route (6 turns, 32,000 characters, 32 routes). Channel history is keyed by channel/thread; DM continuity by channel/user. Restart and off clear history.
- Replies and uploads are bound to the source conversation/thread. No arbitrary cross-channel sending. Remote conversation listing returns only the current source; the terminal can list broader bot-accessible conversations.
- Model and authenticated provider configuration come from the host. No separate model API key is required. Normal model charges/limits apply when enabled and processing messages.

## Install

Use an existing, working OMP 18.10.4 installation (its supported runtime is required). Clone/download this repository, run `npm ci`, then load `index.ts` with OMP's extension option:

```powershell
omp --extension "C:\path\to\omp-slack-extension\index.ts"
```

Confirm the extension option with `omp --help` if your installed version differs. This project's mock tests require Node >=22.6; OMP itself has its own runtime requirements. Node 24 is recommended for the test runner.

## Slack setup

Import `slack-manifest.json` for the minimum reply/DM bot. Enable Socket Mode, install to your workspace, and create an app-level token with only `connections:write`. Keep both tokens secret. Invite the bot into selected channels. No Slack slash command registration is required: `/slack` is an OMP terminal command.

Set these variables in the same terminal that launches OMP. Never paste actual secrets into chat, source files or terminal command history. PowerShell hidden input example:

```powershell
$env:OMP_SLACK_TEAM_ID = 'YOUR_WORKSPACE_ID'
$env:OMP_SLACK_APP_ID = 'YOUR_APP_ID'
$env:OMP_SLACK_OWNER_IDS = 'YOUR_SLACK_USER_ID'
$env:OMP_SLACK_CHANNEL_IDS = 'ALLOWED_CHANNEL_ID'
$secure = Read-Host 'Slack bot token' -AsSecureString
$env:OMP_SLACK_BOT_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
$secure = Read-Host 'Slack app token' -AsSecureString
$env:OMP_SLACK_APP_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
Remove-Variable secure
omp --extension "C:\path\to\omp-slack-extension\index.ts"
```

Credentials remain in the process environment; this is not a secret vault. Close the terminal or remove variables after testing. Do not enable local shell tools in an environment containing secrets unless you accept that those tools can access them.

`OMP_SLACK_CHANNEL_IDS` is optional; empty allows eligible owner requests in any channel or DM the bot receives. If populated, include desired DM conversation IDs too. An empty/missing owner list fails closed before network access.

## Optional tools and scopes

Default remote tools: origin-bound `slack_reply`, `slack_read_thread`, `slack_upload_file`, `slack_list_conversations`. No remote filesystem or shell tools are enabled by default.

- File uploads require `files:write` and `OMP_SLACK_UPLOAD_ROOT` set to a dedicated output directory. Only explicit artifact requests should use it. Relative paths, 10 MiB limit, hidden-path/traversal/symlink checks apply; no content secret scanner is guaranteed.
- Local conversation enumeration requires the corresponding `channels:read`, `groups:read`, `im:read` scopes. Add only what you need and reauthorize the app.
- The minimum manifest includes `im:history`, but no public/private channel history scopes. Current [Slack `conversations.replies` documentation](https://docs.slack.dev/reference/methods/conversations.replies/) lists `channels:history`, `groups:history` and `im:history` for bot tokens; actual access depends on scopes, conversation visibility and API restrictions. Live channel-history access remains unverified. Same-route in-memory history works independently; check current rules before extending access, and do not automatically substitute a broader user token.
- Optional `OMP_SLACK_LOCAL_TOOLS` is a comma-separated subset of `read,grep,glob,write,edit,bash`. Enabling them exposes the host filesystem/process privileges to allowlisted remote users. They inherit host settings/policy; interactive approvals are unavailable remotely. Test policy behavior before enabling writes or shell. This is NOT an OS sandbox.

Run only ONE active Socket Mode listener per Slack app across all terminals/machines. Slack can distribute events across simultaneous connections. The extension does not enforce a distributed lock.

## Verification

```powershell
npm run check
```

27 mock tests cover owner/workspace/app filtering, queueing, dedupe, route history isolation, shutdown races, SDK lifecycle, final text extraction and upload cancellation. No live Slack/model requests are made by tests. A passing suite does not prove real SDK runtime or Slack interoperability. See `docs/windows-acceptance.md` before real use.

## Sources / pinned assumptions

- https://github.com/can1357/oh-my-pi (inspected 18.10.4, source revision reported c7b809a)
- https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md
- https://github.com/can1357/oh-my-pi/blob/main/docs/sdk.md
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://docs.slack.dev/reference/methods/conversations.replies/

SDK calls are version-sensitive. The development dependency is pinned to the inspected version; revalidate before upgrading.
