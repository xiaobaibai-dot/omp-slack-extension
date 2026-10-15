# Native Slack message channels

This revision targets OMP 18.10.4. It is a cloud-only implementation, not evidence of a Windows deployment, live Slack round trip, live model call or a real training process surviving intervention.

## Contract

- Ordinary messages and `!queue TEXT` use native `followUp`.
- `!insert TEXT` and `!steer TEXT` use native `steer`.
- `!status` is an authenticated, deduplicated, bounded transport reply. It never submits a model prompt.
- Authorization is unchanged: configured DM owners and configured owner/member/bot channel access apply equally to both delivery modes and status.
- `SlackBridge` retains at most 32 outstanding request records. It does not schedule execution, poll for idle or hold the next request behind the current model run.
- `NativeSession` serializes only admission to retain event ordering. As soon as `onPromptAdmitted` runs, the next request can enter OMP while earlier work continues. This is not a separate task FIFO. OMP's native queue/batching/steering settings govern consumption.
- The production main-session path never calls `abort`, `clearQueue`, or reconstructs the host's queue. It does not change tool approval or steering settings.

## Verified public interfaces

Pinned upstream source: [OMP v18.10.4, commit 687892d1046ecaf18829b45f5b86928a308258f4](https://github.com/can1357/oh-my-pi/tree/687892d1046ecaf18829b45f5b86928a308258f4).

1. [AgentSession.prompt](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/agent-session.ts#L7237-L7258) starts idle input and selects `steer`/`followUp` while streaming. Both `runCommands:false` and `expandPromptTemplates:false` are specified. We do not use omitted `sendUserMessage` delivery, which can steer busy input, or idle `followUp` alone, which need not wake an empty transcript.
2. `onPromptAdmitted` marks queue acceptance or the beginning of idle preflight. It does not mean the model consumed that request. `subscribe`'s `message_start` supplies the consumed user input. This is the SDK subscription surface; extension `pi.on("agent_end")` has different terminal metadata.
3. [getQueuedMessages / removeQueuedMessage](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/coding-agent/src/session/agent-session.ts#L9025-L9099) expose queue chips and exact individual removal. The display's steering prefix includes claimed live-steered messages, which are not editable. Removal matches original raw submitted text even after OMP transforms its displayed text. A TUI-promoted follow-up is removed by checking both lanes.
4. [Native steering tool behavior](https://github.com/can1357/oh-my-pi/blob/687892d1046ecaf18829b45f5b86928a308258f4/packages/agent/src/agent-loop.ts#L3227-L3247) distinguishes interruptible waits from ordinary side-effecting foreground tools. The latter receive a cooperative steering signal, not the steering hard-abort signal. Tool-specific opt-ins and native settings still matter. The bridge does not terminate training or signal an OS process.

## Admission, consumption and reply ownership

Each request receives a fresh random ID, a fixed instruction header and an immutable team/channel/thread/sender route. OMP may expand a `^model` mention in the payload even when prompt template expansion is off. Therefore ownership requires an active generated ID at the first line plus the complete fixed header, not a full-body equality check and not an arbitrary marker found inside user text. Queue removal still uses the exact original raw prompt.

Before consumption, even a known request ID cannot use a Slack tool. Consumed requests may invoke origin-bound tools with `request_id`. Without an ID, tools are available only for a single unambiguous consumed owner. Every invocation and asynchronous completion rechecks current binding, consumption and ownership. Local user/custom input revokes prior remote ownership. Agent-attributed background notices do not become local input. Retired Slack messages do not gain local-only conversation-directory privileges.

A successful, tool-free, nonempty `stop` answer can be forwarded for a single clean owner. Model `length`, error, aborted and `stopDetails.type=pause_turn` outputs are not successful finals. An assistant answer before the last consumed user input cannot be reused. A clean final is settled when the next input begins or when a terminal SDK `agent_end` confirms completion; normal native follow-ups need not wait for global idle.

For steer mixed into local/other-source work, live-steered provider input or native all-at-once batches, the model must send separate `slack_reply` calls with the consumed request IDs. Combined automatic finals are suppressed. A successful explicit reply suppresses the automatic final for that request, preserving the prior v5 explicit-send behavior.

Error/aborted `turn_end` may start native recovery, so owners remain active until a real terminal settle. Nonterminal `agent_end` clears a potential final boundary while retaining its owners. This intentionally conservative rule also covers the SDK's late queue-arrival race (`isTerminal:false`, `yielded:true`): a completed prior request and a tail-arriving follow-up may require explicit per-ID replies rather than automatic replies. The bridge prefers missing an automatic reply over assigning mixed content to a guessed source. Suppression is reported locally as `reply_ambiguous`; it does not rerun work or send an extra Slack notification.

## Off, disconnect and session changes

Off closes new admission and revokes all reply/file capabilities before awaiting socket shutdown. It precisely withdraws still-editable plugin messages and leaves unrelated native pending items alone. Pending preflight, claimed/live-steered and consumed work cannot be individually recalled through these public APIs. They may continue after off; the command result says so. No whole-session abort is used as a workaround.

Late queue admission is guarded and its exact item withdrawn before asynchronous execution can proceed. Native session identity/generation and the binding generation prevent stale preflight from running in a newly selected conversation. A session switch/branch/tree navigation stops the binding; the new conversation requires manual enable. No old request is replayed or rebound. A late event, held tool, transport result or prior enable generation cannot regain a reply destination.

A network mutation whose result is uncertain revokes that request's reply permissions without aborting host work or automatically retrying the task. Work already consumed remains an unattributed participant until a clean boundary, so a later insert cannot acquire its combined final. Writes already submitted to Slack can complete; they cannot be recalled. Socket reconnect policy itself is unchanged in this revision.

## Status and limits

`!status` returns the current sender/source-thread's `submitting`, editable `followUp`/`steering`, `consumed` and `claimed` counts. `claimed` also includes admitted preflight or removed-but-not-yet-settled items; it is not proof that a model is actively executing. Global streaming and observed event/tool counts contain no message bodies, tool arguments, output, other source IDs or session transcript. Counts reflect observations since enable. This cannot verify whether a training process exists or is making progress.

Status bypasses the 32-work-request limit, but only four control replies can be in flight, and Slack availability/rate limits still apply. Dedupe is bounded to 2,048 event IDs and ten minutes, in memory within one extension factory. It survives off/on bridge recreation, but is not persisted across a process restart or a freshly loaded factory. There is no new task or idle timeout.

## Security and acceptance boundaries

All accepted sources deliberately share the existing main-session context, model, tools, filesystem privileges and approvals. Fixed route capabilities prevent accidental channel/thread reassignment; they do not provide semantic context isolation or stop a model from quoting information already in that shared transcript. Explicit request IDs are routing selectors for currently consumed work, not secrets or independent authorization credentials. Only trust appropriate senders with this shared main session.

The tests use a public-API protocol fixture for AgentSession and fake Slack/model inputs. Real Slack SDK transport/IPC regression tests remain, but they do not establish real native tool scheduling. `docs/windows-acceptance.md` lists the required live checks. No Windows update/restart or GitHub publication is part of this implementation task.
