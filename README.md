# OMP Slack Extension

English | [简体中文](README.zh-CN.md)

For OMP 18.10.4. `/slack` manually binds Slack to the currently open main conversation. Requests and replies appear in that same transcript and use its existing context, model, tools and approvals. Startup, restart and session changes default to off; closing the conversation disconnects.

The shared mode still needs live Slack acceptance. A real Windows OMP SDK probe verified exact main-session identity and shared context. Earlier successful DM feedback concerned the old isolated worker implementation. See [Windows acceptance](docs/windows-acceptance.md).

## Install

```powershell
git clone https://github.com/xiaobaibai-dot/omp-slack-extension.git
cd omp-slack-extension
npm ci
omp --extension "C:\path\to\omp-slack-extension\index.ts"
```

For automatic loading, place the entry, sources and production dependencies under `~/.omp/agent/extensions/omp-slack/`. Use `windows.ts` as the entry for the optional saved Windows configuration, retaining its import of the main implementation. This uses the existing OMP installation and does not change host model or approval settings.

| Command | Behavior |
| --- | --- |
| `/slack`, `/slack on` | Bind the current main conversation and connect |
| `/slack off` | Disconnect and cancel pending Slack work; preserve the main transcript |
| `/slack status` | Connection, queue and busy status |
| `/slack channels` | Local conversation directory; requires the corresponding read scopes |

Requests wait FIFO while the host is busy; they never steer local input. Event IDs are deduplicated. Switching, branching or navigating the session tree disconnects and requires manual binding again.

For the same OS user, workspace and App on one machine, a new OMP conversation's `/slack` takes over the existing binding. It first stops old admission, cancels that conversation's Slack work and closes its socket, then connects the new owner. It preserves the old OMP process and transcript. Repeated enable in the same conversation keeps the current connection. Windows uses an exclusive named pipe only while enabled: no permanent service or persistent lock file. OS cleanup permits recovery after a process crash. A stalled previous owner cannot be bypassed while its shutdown is unconfirmed.

For the first upgrade, turn the old listener off and load the new extension in relevant OMP processes. Older versions without the handoff protocol cannot transfer ownership. There is no cross-machine exclusion; keep other machines' listeners for this App off.

## Slack app and configuration

Use an existing App with Socket Mode and Messages tab enabled. Install it in the target workspace, invite its bot to the chosen channel, and subscribe to `app_mention` and `message.im`. No Slack slash command is needed.

- Bot token: `xoxb-`, scopes `app_mentions:read`, `chat:write`, `im:history`. Upload requires `files:write` and reauthorization.
- App-level token: `xapp-`, scope `connections:write`.
- Channel requests must @mention the bot; one-to-one DMs can trigger directly.

The normal entry reads these process environment variables:

| Variable | Content |
| --- | --- |
| `OMP_SLACK_TEAM_ID`, `OMP_SLACK_APP_ID` | Workspace and App IDs |
| `OMP_SLACK_BOT_TOKEN`, `OMP_SLACK_APP_TOKEN` | The two tokens |
| `OMP_SLACK_OWNER_IDS` | Permitted DM users, comma-separated Slack IDs |
| `OMP_SLACK_CHANNEL_IDS` | Allowed channel and DM IDs; include the `D...` DM when restricting sources |
| `OMP_SLACK_CHANNEL_ALL_USERS` | Channels where all members and bots may @mention; must also be in the allowed source list |

Other sources remain owner-controlled. Member-open channels accept bot mentions as well, without an extra bot or self-identity filter. Ordinary channel messages, edits, group DMs and other workspace/app installations are ignored.

On Windows, the user can run `scripts/Configure-Slack.ps1` once with the non-secret IDs. Hidden token input is saved using Windows user encryption in `~/.omp/agent/slack-credentials.json`. The `windows.ts` entry reads it only when manually enabled, without global environment changes. Keep tokens out of chat, Git and logs.

```powershell
.\scripts\Configure-Slack.ps1 -TeamId 'T...' -AppId 'A...' -OwnerIds 'U...' -ChannelIds 'D...,C...' -ChannelAllUsers 'C...'
```

## Tools and routing

All existing tools and approvals belong to the bound main session. `OMP_SLACK_LOCAL_TOOLS` no longer changes shared-mode tools. All accepted sources share the main context. Only the active request's final answer returns to its source thread; unrelated terminal answers are not broadcast.

After `slack_reply` successfully sends the requested body, the bridge does not send another final explanation. Without an explicit reply, the final answer is sent automatically. Canonical `<@USER_ID>` syntax renders a real user mention.

Additional tools: `slack_reply`, `slack_read_thread`, `slack_upload_file`, `slack_download_file`, `slack_list_conversations`. Host uploads accept absolute paths or paths relative to the bound workspace, without an output-root restriction. Upload must be explicitly requested and follows normal OMP write approval. Current limits are 10 MiB per regular file and three uploads per request. Never upload credentials or unrelated files.

Downloads require `files:read` and reauthorization. `slack_download_file` takes an explicitly requested file ID shared in the source conversation and a new local path, creates required parent directories, follows write approval, avoids overwriting existing files and returns byte count and SHA-256. Each file is limited to 10 MiB.

Thread reads require the applicable Slack scopes; minimal scopes do not grant full channel history. Reads are limited to three pages of 15 messages per request. Remote directory results include only the source; the local directory needs extra read scopes.

The queue holds 32 requests. The main-session bridge adds no task wall-clock or idle timeout. Manual cancellation, session close/switch and binding takeover still cancel the corresponding Slack turn. Local user input mixed into an active Slack turn prevents forwarding that mixed final answer. Disconnect cannot recall writes already submitted to Slack.

Network operations have separate limits: Web API attempts time out after 10 seconds; file HTTP attempts after 30 seconds. Reads retry transient connection errors and retryable 5xx with exponential backoff and jitter, at most four attempts within two minutes. A rejected 429 waits at least [Slack's Retry-After](https://docs.slack.dev/apis/web-api/rate-limits). SDK HTTP retries are disabled to avoid nested retry loops. Authentication, permission and argument errors are not retried. Socket Mode keeps its existing bounded connection wait and managed reconnect behavior.

Message sends and file upload phases retry only an explicitly rejected 429. A lost response, timeout or ambiguous 5xx reports `network_outcome_uncertain` and stops the source turn; it never blindly repeats the mutation or automatically sends another final answer. [Upload completion can only be called once](https://docs.slack.dev/reference/methods/files.completeUploadExternal). No additional scopes or unsupported idempotency guarantees are assumed. `No automatic retry` refers to the agent task: HTTP retries do not rerun it.

The bound OMP session records `omp_slack_request` custom entries with event ID, generated request ID, source thread/message IDs, start/end timestamps and a fixed outcome reason. Request text, replies, tokens, raw errors and tool content are excluded. `/slack status` reads OMP's own idle, pending-message and streaming state, plus the last observed agent/turn/message/tool event and tool count. These snapshots are diagnostic only; long thinking or tool execution never triggers an idle abort or automatic recovery.

## Validation

Run `npm run check` for types and regressions covering routing, channel members, FIFO, duplicates, transport cancellation and reconnect, shared-turn ownership and uploads. Legacy isolated SDK code/tests remain for historical regression; the entry uses the shared runner.

Real Windows SDK fixtures verified shared main context with zero network and no paid model requests. Live Slack, non-owner channel members, uploads and existing tool approvals need separate evidence. Mock tests do not establish those outcomes. See [the acceptance checklist](docs/windows-acceptance.md).
