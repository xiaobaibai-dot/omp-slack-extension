# Model quota and rate-limit notices

This feature observes the bound OMP session. It does not make a model request, probe a provider, rerun a task, change OMP retry/fallback settings, change socket reconnection or add a Slack outbox.

## Behavior

A consumed Slack request encountering an assistant quota/usage-limit error or rate-limit/429 error receives a fixed Chinese system notice in its original Slack thread. Queued-only requests and unrelated local errors are not broadcast. The notice never copies the raw error, provider/model configuration, headers, tokens, prompt, tool arguments or assistant output.

Failures are deduplicated per provider/model and exact source route until an actual successful output occurs. Up to 128 affected routes are retained within the current binding. No state is persisted. Off, takeover, close or session navigation destroys those records and revokes pending notification sends. Sender/workspace authorization and the immutable route are checked again at the transport boundary.

A same-provider/model assistant turn with actual text/tool-call output can send one recovery notice to previously notified source threads, including after the failed request already settled. A local or another source's successful response may establish model availability; its content is never copied. The text explicitly says this does not establish that the original account's quota reset: OMP may have rotated credentials. A different model's success does not clear the old model's incident. Empty output, error, aborted, length, pause_turn, a response's HTTP200 headers, a fallback selection and a retry timer are not treated as successful recovery.

System notices are not model replies. They neither consume the three explicit-reply slots nor suppress a later successful final answer. A failed/uncertain system send is not automatically replayed; recovery is only announced if the original failure notice was confirmed sent. The existing transport's bounded explicit-429 retry and uncertain-mutation rules remain unchanged. No separate Slack-rate-limit notification feature was added. Delivery is best-effort while the current transport is ready, with a bounded number of concurrent notices; no new persistent delivery queue exists.

## Error information actually available in OMP 18.10.4

`AssistantMessage` exposes `errorStatus`, `errorId`, `provider`, `model`, `errorMessage` and `errorClassificationMessage`. `turn_end` is an actual AgentSession subscription event. The plugin recognizes the pinned SDK `UsageLimit` flag and explicit HTTP429, with a narrow bounded text fallback for SDK/provider errors lacking those fields. Classification text is never sent to Slack and is never interpreted as a recovery date.

`auto_retry_start.delayMs` is OMP's scheduled backoff; it can be heuristic or change after credential/model switching. It is **not** an account-reset timestamp and is never presented as one. The plugin does not use the provider's error prose or `retry-after-ms` text marker as a trusted structured reset.

The formal `after_provider_response` hook exposes HTTP status/headers/requestId; the response model is `ctx.model`. However:

- Common OpenAI and Anthropic provider implementations reject HTTP429 before this hook is called. Missing headers are normal.
- The hook can also be used by auxiliary provider requests. Same model and nearby timing are insufficient for source attribution.
- A time hint is accepted only from a current non-2xx response with a nonempty opaque request ID exactly equal to the failed assistant's response ID, with matching status when the assistant exposes it. HTTP `x-request-id` and API response IDs usually identify different objects. Many adapters do not supply a common ID; their recovery time stays **unknown**. No ID is guessed or scraped from error text.
- Previous-turn hints are cleared, successful-response hints are not reused, and mismatched model/ID/status hints are ignored.

Thus the feature reliably reports observed quota/rate-limit failures, but **cannot promise a recovery timestamp for every provider**. It openly reports unknown rather than guessing.

## Time formatting

When the strict correlation above succeeds, only these documented header formats are recognized:

- `Retry-After`: numeric seconds or an HTTP GMT date. This takes precedence and is reported as the provider's earliest suggested retry time, not guaranteed recovery.
- [Anthropic rate-limit reset headers](https://platform.claude.com/docs/en/api/rate-limits): explicit RFC3339 dates.
- [OpenAI request/token reset headers](https://developers.openai.com/api/docs/guides/rate-limits): strict numeric unit durations such as `1m2s`.

The displayed absolute time includes **UTC**. Invalid/past/ambiguous dates, unsupported generic reset headers and values more than 366 days away are rejected. If multiple supported reset buckets are supplied, the latest is used. The plugin only reports these values; it schedules no model retry and cannot shorten OMP's own waiting policy.

## Tests and boundaries

Unit tests cover classification, redaction, per-thread dedupe, trusted/unknown timing, unrelated helper responses, successful recovery, off, uncertain-send suppression, recovery/failure races, no queued/local-error broadcast, and preservation of normal final replies.

Real OMP runtime tests use the official MockModel provider and fake Slack transport. They prove genuine AgentSession failure/success events drive notices without extra provider calls, and that a correlated synthetic response hook can supply a retry time. This does **not** establish that real OpenAI/Anthropic429 responses reach that hook. No live Slack, real account quota exhaustion, Windows deployment or paid provider request was tested.
