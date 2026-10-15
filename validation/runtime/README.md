# Real OMP cloud runtime tests

This is a credential-free, reproducible Linux x86_64 integration harness. It uses official OMP **18.10.4**, official Bun **1.4.3**, and a package lock with npm integrity hashes. It runs the actual checked-out plugin source, real `createAgentSession`, `initializeExtensions`, native queues, built-in `wait`, AsyncJobManager, tool calls and local IPC takeover. SDK events are observed, never manually emitted.

## Run

Prerequisites: Linux x86_64, Bash, Node >=22.6 (verified 24.19.0), npm, and official npm registry access for installation.

```sh
cd validation/runtime
./setup.sh
./run.sh
```

`setup.sh` installs only into this directory, with package scripts disabled and blank npm config. It never reads provider keys or Slack tokens. If an existing trusted npm cache is available, `OMP_VALIDATION_NPM_CACHE=/path/to/cache ./setup.sh --offline` also works. The offline-cache restoration was verified in a second empty directory. A fresh machine still needs npm access; the restricted validation shell's fresh download attempt encountered DNS `EAI_AGAIN`.

`run.sh` uses an empty environment and local HOME/config/cache/data folders. `prepare-candidate.mjs` copies only the repository's `index.ts` and regular `src/*.ts` into ignored `candidate/`, then hashes them. No machine configuration or workspace data is copied. Model/auth storage is in-memory. The placeholder mock key cannot authenticate to a service. Optional provider helpers, extension discovery, MCP, skills, memory, advisor, titles and cache warming are disabled. `fetch` is blocked before SDK import and the suite asserts zero attempts; this check is not an OS network sandbox.

Model content comes from the official MockModel adapter; the Slack transport network boundary is mocked. The real agent loop consumes those model responses, executes tools and emits its own events. No Slack connection or paid model call occurs.

## Verified result

On 2026-10-15 the native candidate passed **10/10** real-runtime tests; an independent copy passed the same suite, and another clean cached install reproduced it. Plugin unit/type checks passed **127/127 + tsc**. Source baseline: local `2d443f385c268746ce2965bef81825c932fc6d44`, identical Git tree `374ecc024fb4e8abcd706e9a7fac2bcc9c517c41` published as [cdcfdf4](https://github.com/xiaobaibai-dot/omp-slack-extension/commit/cdcfdf4c541d6aa4d09b28ce6374c6749c1d1ba5).

Covered:

- Native default/explicit followUp FIFO; four exact channel/thread routes; status without an LLM call.
- Approved non-owner `!insert` during built-in wait. Wait reports interrupted, but its actual background heartbeat subprocess completes **60 ticks / exit 0 / signal aborts 0**, with exactly one explicit reply.
- `!steer` during a normal foreground side effect waits for the safe boundary; the real subprocess completes **16 ticks / exit 0 / signal aborts 0**.
- Off with pending work preserves unrelated local input; off with consumed work and actual IPC takeover suppress late replies while each subprocess completes **16 ticks / exit 0 / signal aborts 0**.
- Status bypasses outstanding-request bounds; unauthorized commands never reach the model.
- Actual SDK session switch clears old queued work and disables the binding. Explicit SDK `newSession()` itself aborts once; the plugin adds no abort. Other scenarios have zero session aborts before cleanup.
- Native idle preflight can continue after off, but cannot regain reply permission.
- Cross-enable event dedupe and stale callback rejection.

The suite writes synthetic observations, provider inputs, post routes and heartbeat PID/exit/tick/signal evidence to ignored `logs/runtime-events.json`. The source hashes there identify exactly what was tested. Keep logs private by default; the harness inputs are synthetic, but future edits might not be. Do not commit credentials or real user transcripts.

## Limits

This does not validate live Slack, real LLM reasoning/tool-calling, Windows, a real training program, every tool's cancellation semantics or prolonged network outages. All Slack sources share the host conversation and tools; safe reply routing does not provide semantic context isolation. The reconnect revision adds a real transport supervisor at a faulted SDK network boundary; it does not verify a live Slack connection.

An independent anonymous OpenCode free-model smoke returned HTTP **403 / FreeTierError** on the first text request: “OpenCode's free tier can only be used from within OpenCode.” It was stopped without retries, impersonation, IP changes, credentials or paid fallback. No live tool-call test passed, and the response does not establish an IP rate limit. This harness never repeats that rejected external request.

## Additional model-limit coverage

The quota-notification revision adds two scenarios (12 total): actual error/success AgentSession events trigger sanitized same-thread notices, repeated failures dedupe, later natural success sends recovery without extra provider calls, and off blocks later notices. The second test uses an explicitly correlated synthetic MockModel response/request ID plus Retry-After to verify the optional header path. Common real providers do not expose failed HTTP429 headers or a common response/request ID, so their recovery time remains unknown. See [provider-notice limits](../../docs/provider-notices.md).

## Additional reconnection coverage

The reconnect revision passed **157 unit tests + typecheck** and **14/14 real-runtime scenarios** in the cloud. It adds two scenarios (**14 total**): the actual plugin transport supervisor retries an SDK connection reset while a real OMP foreground heartbeat runs and another source waits in the native queue. Both final replies retain their original threads, the subprocess completes **150 ticks / exit 0 / signal aborts 0**, and exactly two remote user prompts are consumed with no rerun. The other scenario closes the listener during real transport backoff; no reconnect happens afterward, replies remain revoked, and the subprocess completes **40 ticks / exit 0 / signal aborts 0**. Both scenarios call the actual transport lifecycle, replacing only the Slack SDK network methods. Provider content remains MockModel. `socketFaults` and heartbeat evidence are included in the ignored event log.

The prior twelve scenarios retain their higher-level SlackTransport fake. Therefore only the final two test the actual reconnect supervisor together with AgentSession; the fake-clock unit suite supplies additional socket fault and cancellation coverage. See the [reconnection limits](../../docs/reconnect.md), including first-enable behavior and no offline outbox.
