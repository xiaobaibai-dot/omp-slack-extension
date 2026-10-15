# Automatic reconnection

After `/slack` has successfully established its first connection, the plugin owns one cancellable reconnect loop. It uses `@slack/socket-mode` **2.0.7** with the SDK's own reconnect/HTTP retries disabled. Every attempt uses a new SDK instance and a separate abort signal. No tokens, scopes, account configuration or persistent credentials are changed.

## Policy

- Temporary socket closes, normal Slack connection refreshes, connection timeouts/resets, temporary DNS errors, HTTP 408/5xx and explicitly rate-limited connection attempts can recover automatically.
- Backoff starts with a 1-second base, doubles to a 60-second base, and waits a randomly selected 50–100% of that base. A stable connection lasting 60 seconds resets the exponent. Only one connection attempt is in progress.
- A valid `Retry-After` takes precedence when longer than the backoff; a small positive jitter is added. Long waits are split into safe timer-sized chunks without retrying early. A 429 with no usable hint conservatively waits at least 60 seconds; this is a retry policy, not a promised server recovery time. An unrepresentable hint stops for inspection rather than retrying early.
- Explicit rejected authentication/permissions/configuration (including `invalid_auth`, `token_revoked`, `token_expired`, missing connection scope, HTTP 401/403, TLS certificate-validation failures, or `link_disabled`) stops automatic reconnect and asks the operator to correct the issue and run `/slack` again. `invalid_auth` can also reflect an access policy restriction; it is not proof that a token expired. A generic `slack_webapi_request_error` alone is not an authentication diagnosis. Unclassified failures stop after three such failed reconnect attempts until a stable connection resets that counter.
- A connection attempt has a 30-second deadline. Closing an old socket allows up to 2 seconds before force-closing its handshake. Off joins any close already in progress before releasing the local binding. Late events from discarded instances cannot admit work; late authentication cannot construct a new socket.
- **Initial enable is deliberately different:** `auth.test` uses the existing bounded read-retry policy; if initial Socket Mode establishment fails, enable fails visibly and requires another `/slack`. The ongoing reconnect loop starts only after successful enable. This avoids leaving a never-established binding silently waiting indefinitely.

## Tasks, replies and commands

A temporary disconnect does **not** call `bridge.stop`, clear the host's native queues, revoke existing request routes, abort the main AgentSession, or resubmit work. `request_id` and exact workspace/channel/thread ownership remain unchanged across reconnection. Event IDs remain deduplicated. Socket receive readiness is separate from outbound HTTP permission: an existing task may still send its reply via the Web API while Socket Mode reconnects.

`/slack status` reports `connection.state`, failure count, sanitized reason and next scheduled attempt time. A received `!status` remains a transport-only response without an LLM call; it cannot be received while the socket itself is unavailable. Connection transitions are reported locally, not broadcast into every Slack thread.

`/slack off`, shutdown, session switch and takeover synchronously revoke routing and cancel waiting/in-flight connection attempts. Only precisely identifiable, still-editable native Slack queue entries can be withdrawn. Already admitted/claimed native work may continue, as before. The plugin never invokes `session.abort()` to reconnect or stop listening. A terminal transport/configuration failure uses the same route-revocation behavior; it does not terminate native work.

No offline outbox is added. Reconnection does not replay model prompts, redo tools, resend historical notifications, or reissue a message/file mutation whose delivery is uncertain. The existing HTTP operation policy remains in force: explicitly rejected 429s may wait/retry within their existing budget; timeouts, lost responses and uncertain server failures must not blindly resend. A failed result delivery during a full network outage is **not** guaranteed to be delivered after reconnection. Events never received during an outage are also not guaranteed to be recovered; any Slack retries still pass authorization and deduplication.

## Verification and diagnostic boundaries

Unit tests use a fake clock and the real SDK class at mocked network boundaries. They cover repeated transient failures, jitter/Retry-After, unknown/fatal errors, physical HTTP abort, setup timeout, late responses/payloads, old-socket cleanup, off during backoff/close/connect, bot-token failure during file lookup, and no replay of uncertain sends.

The credential-free [real OMP runtime suite](../validation/runtime/README.md) additionally runs the actual transport supervisor with faulted Slack SDK networking while real native work and heartbeat subprocesses run. It verifies that active and queued source threads survive reconnect and that off cancels reconnect without cancelling the subprocess. It does not establish real Slack or Windows reliability or simulate a production-duration outage.

Useful diagnostic fields are timestamp/version, connection state, sanitized failure category, attempt count, next attempt time, structured HTTP status/platform error and Retry-After. Do not collect raw SDK errors, tokens, Authorization headers, websocket URLs/tickets, prompts, or reply contents. Authentication errors should be distinguished from generic transport errors before redaction.

Official behavior: [Socket Mode disconnects and refreshes](https://docs.slack.dev/apis/events-api/using-socket-mode/), [connection API errors](https://docs.slack.dev/reference/methods/apps.connections.open/), [Retry-After](https://docs.slack.dev/apis/web-api/rate-limits/).
