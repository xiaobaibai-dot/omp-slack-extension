# OMP Slack Extension

English | [简体中文](README.zh-CN.md)

For OMP 18.10.4. `/slack` manually binds Slack to the currently open main conversation. Requests and replies appear in that same transcript and use its existing context, model, tools and approvals. Startup, restart and session changes default to off; closing the conversation disconnects.

The native-channel revision is cloud-tested only and has not been deployed to Windows or exercised against live Slack/model traffic. Earlier main-session probes and Slack results do not validate this revision. See [native-channel design](docs/native-channels.md) and [Windows acceptance](docs/windows-acceptance.md).

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
| `/slack off` | Stop admission and replies; withdraw still-editable Slack queue items, without aborting the main session |
| `/slack status` | Connection, queue and busy status |
| `/slack channels` | Local conversation directory; requires the corresponding read scopes |

### Slack message delivery

| Slack message body (after the channel @mention) | Native behavior |
| --- | --- |
| Ordinary text, or `!queue TEXT` | `followUp`, the default native queue |
| `!insert TEXT` or `!steer TEXT` | Native `steer`, for intervention at OMP's supported interruption boundary |
| `!status` | Transport-only status, bypassing the model and work queue |

These prefixes are message text, not Slack slash commands. They use the same existing sender/channel authorization, including approved member/bot channels. There is no owner-only restriction on insertion. Event IDs are deduplicated before dispatch or control replies. An empty delivery command returns usage without invoking a model.

The plugin calls OMP `prompt` with the selected `streamingBehavior`: idle input starts normally, busy input enters OMP's own queue immediately. It does not wait for the previous Slack task or host to become idle. Only prompt admission is serialized to preserve submission order. Native one-at-a-time mode provides FIFO follow-ups; existing OMP batch/steering settings remain in effect. Insertion can overtake queued follow-ups. The plugin never changes those settings or calls main-session `abort`.

OMP's native steering can interrupt pure waits and can cooperatively background supported shell work. It does not promise immediate insertion into every tool. This is not permission to terminate a training process; custom tools can have their own steering behavior. Switching, branching or navigating the session tree disconnects and requires manual binding again.

For the same OS user, workspace and App on one machine, a new OMP conversation's `/slack` takes over the existing binding. It first stops old admission, withdraws still-editable Slack input, revokes old replies and closes its socket, then connects the new owner. Already admitted or claimed work may continue in the old conversation. It preserves the old OMP process and transcript. Repeated enable in the same conversation keeps the current connection. Windows uses an exclusive named pipe only while enabled: no permanent service or persistent lock file. OS cleanup permits recovery after a process crash. A stalled previous owner cannot be bypassed while its shutdown is unconfirmed.

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

All existing tools and approvals belong to the bound main session. `OMP_SLACK_LOCAL_TOOLS` no longer changes shared-mode tools. All accepted sources share the main context: this is NOT channel/thread context isolation or a filesystem sandbox. Only grant access to people/agents trusted with that context and the host's tool privileges. Reply-route checks prevent accidental destination reassignment, not semantic disclosure by a model with shared context.

Every submitted prompt has a generated `request_id` and immutable source route. Admission does not grant tools: the exact native `message_start` consumption must first be observed. All Slack tools accept optional `request_id`. For a single unambiguous consumed request it may be omitted; for insertion into ongoing local/Slack work or native batched inputs, use each consumed request's explicit ID. Queued/retired IDs are rejected. A reply cannot specify a different channel or thread.

After `slack_reply` successfully sends the requested body, the bridge does not send another final explanation for that request. A successful final answer is automatically forwarded only for a single unambiguous consumed request. Mixed, empty, truncated, error and aborted finals are not broadcast. Replies can finish at native per-turn boundaries while later follow-ups keep running; global idle is not required. Canonical `<@USER_ID>` syntax renders a real user mention.

Additional tools: `slack_reply`, `slack_read_thread`, `slack_upload_file`, `slack_download_file`, `slack_list_conversations`. Host uploads accept absolute paths or paths relative to the bound workspace, without an output-root restriction. Upload must be explicitly requested and follows normal OMP write approval. Current limits are 10 MiB per regular file and three uploads per request. Never upload credentials or unrelated files.

Downloads require `files:read` and reauthorization. `slack_download_file` takes an explicitly requested file ID shared in the source conversation and a new local path, creates required parent directories, follows write approval, avoids overwriting existing files and returns byte count and SHA-256. Each file is limited to 10 MiB.

Thread reads require the applicable Slack scopes; minimal scopes do not grant full channel history. Reads are limited to three pages of 15 messages per request. Remote directory results include only the source; the local directory needs extra read scopes.

The bridge tracks at most 32 outstanding requests; this is an admission bound, not a private execution queue. It adds no task wall-clock or idle timeout. Local input revokes prior remote tool/reply association rather than aborting local work.

**Off/disconnect/takeover is not an execution kill switch.** Admission closes and reply capabilities are revoked immediately. Only the plugin's exact, still-editable native pending messages are removed, from either native lane (including TUI-promoted follow-ups). Already admitted idle preflight, claimed/live-steered or consumed work may continue. No main-session abort occurs and unrelated native queue items are retained. Session switches invalidate old routes; native generation checks and the admission guard prevent stale submission in the new session. A write already sent to Slack cannot be recalled. Turning the listener on again never replays revoked requests.

Network operations have separate limits: Web API attempts time out after 10 seconds; file HTTP attempts after 30 seconds. Reads retry transient connection errors and retryable 5xx with exponential backoff and jitter, at most four attempts within two minutes. A rejected 429 waits at least [Slack's Retry-After](https://docs.slack.dev/apis/web-api/rate-limits). SDK HTTP retries are disabled to avoid nested retry loops. Authentication, permission and argument errors are not retried. After successful enable, Socket Mode now reconnects temporary failures with cancellable exponential backoff and jitter, honoring Retry-After. Fatal credential/configuration errors stop; initial enable still fails visibly if its first Socket Mode setup fails. Existing native work/routes survive temporary outages. See [reconnection policy and limits](docs/reconnect.md).

Message sends and file upload phases retry only an explicitly rejected 429. A lost response, timeout or ambiguous 5xx reports `network_outcome_uncertain` and revokes that source request’s reply permission; it never blindly repeats the mutation or automatically sends another final answer. [Upload completion can only be called once](https://docs.slack.dev/reference/methods/files.completeUploadExternal). No additional scopes or unsupported idempotency guarantees are assumed. `No automatic retry` refers to the agent task: HTTP retries do not rerun it.

The bound OMP session records `omp_slack_request` custom entries with event ID, generated request ID, source thread/message IDs, start/end timestamps and a fixed outcome reason. Request text, replies, tokens, raw errors and tool content are excluded. `/slack status` reads OMP's own idle, pending-message and streaming state, plus the last observed agent/turn/message/tool event and tool count. Slack `!status` returns only the caller's source-thread/requester counts, plus global streaming and observed activity counts/timestamps, without prompt text, tool arguments or other channel IDs. It works even at the outstanding-request bound, subject to Slack connectivity/rate limits and a four-control-reply concurrency cap. `claimed` means admitted but not in an editable queue or observed consumed state; it can include preflight or a removed item awaiting settlement. Tool activity is observed since enable, not independent training-process verification. These snapshots are diagnostic only; long thinking or tool execution never triggers an idle abort or automatic recovery.

## Validation

Run `npm run check` for types and regressions covering native admission/consumption, queue/steer modes, multi-source reply ownership, direct status, existing member/bot authorization, dedupe, late admission/session-switch races, off without main-session abort, transport behavior and files. Legacy isolated SDK code/tests remain for historical regression only; the entry uses `NativeSession`.

Native-channel tests use public-API protocol fixtures and pinned SDK type/source checks, not a real OMP model loop. Live Slack, native wait/background behavior, Windows, non-owner channel members, files and existing tool approvals need separate evidence. Mock tests do not establish those outcomes. See [the acceptance checklist](docs/windows-acceptance.md).

### Reproducible cloud runtime

[Run the real OMP 18.10.4 integration suite](validation/runtime/README.md) on Linux with no Slack or model credentials. Fourteen scenarios exercise native scheduling, real wait/subprocess behavior, routing, off/takeover, session switching, model-limit notices and transport reconnection. The model and Slack network boundaries are mocked; the reconnect scenarios run the actual transport supervisor.

### Model quota and rate-limit notices

Consumed Slack requests receive deduplicated, sanitized quota/429 notices in their original thread. Recovery is announced only after an actual successful same-model response, with no extra probe or task retry. A missing or uncorrelated provider reset time is explicitly unknown; OMP backoff is never advertised as quota recovery. See [interfaces and limits](docs/provider-notices.md).
