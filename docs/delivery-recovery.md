# Delivery isolation and recovery

The receiver connection and outbound delivery are separate. `connected`/`failures: 0` describes Socket Mode; it does not confirm an HTTP upload or message.

## Operations, not revoked sources

A consumed native request retains its normal immutable source capability after a delivery error. The native task is never aborted to handle uncertainty. The factory-local ledger isolates operations by workspace/channel/thread. Upload identity is a SHA-256 of bytes, not filename/title/path, so renaming a ZIP cannot bypass an unresolved send. A successful upload result is reused rather than sent again. A confirmed completion receipt is recorded even if local off/cancellation occurs immediately afterward; cancellation cannot turn a shared file into retryable rejection. Message identity uses trimmed text; any uncertain text blocks all text mutations to that thread, including paraphrases. Control replies (`!status`/usage) and provider quota/recovery notices use the same text lock and record their own uncertain outcomes. Their confirmed successes may recur for a new event; that does not bypass an uncertain operation. Local `/slack status` and source read tools remain available while outbound text is locked. Other source threads are unaffected. A concurrent operation already in flight cannot be undone; its actual completion updates only its own record.

- `in_flight`: repeat blocked until settlement.
- `delivered`: confirmed upload/message; identical requests reuse this result.
- `uncertain`: no repeated mutation. Read tools still work.
- `not_shared`: upload staging failed before `completeUploadExternal` was called. Its allocation/byte transfer may have succeeded, but this operation did not share a file.
- `rejected`: definitive rejection, or an explicitly inspected `not_shared` operation. A fresh explicit call may try again. No background retry is added.

Any failed delivery within a request suppresses its automatic final. Any unresolved operation in its source also suppresses automatic finals from later requests. A separately requested explicit message can explain an uncertain upload, but cannot bypass uncertain message delivery. There is no automatic error-message fallback.

## Inspect without resending

`slack_delivery_status` without `operation_id` lists source-only operations. With `operation_id` it performs one bounded verification (at most three verifications per request):

- A `not_shared` operation transitions to retryable `rejected` using local phase evidence. A new upload call is still required. The old complete call is never attempted.
- An uncertain completion with a known file ID may call `files.info` using existing `files:read`. Only an affirmative share under the exact source channel and thread marks it delivered. Missing scopes, unsuccessful lookup, file processing or missing/other-thread shares do not clear uncertainty.
- Uncertain text has no reliable automated reconciliation in this patch and remains blocked. Reading the thread does not silently clear it. There is no model-supplied boolean or arbitrary override that turns missing evidence into permission to repeat.

Both `/slack status` (local) and `!status` (source-scoped) expose delivery state. Operation status contains only generated ID, kind, stage, state, known file ID and allowlisted error category/status/code. No body, path, upload URL, credential, raw error or content hash is exposed. Request logs remain fixed-field; delivery records are not persisted.

## Lifecycle and limits

Successful upload never consumes a request binding. Source capabilities still end at normal native retirement, local input, off, takeover or session switch. Old request IDs cannot be revived. A new Slack message consumed in the same source thread can inspect its ledger and carry on safely; event deduplication and admission checks are unchanged.

The ledger survives off/on only within the same extension factory. It is not persisted across hot reload/process restart and not shared with other computers/factories. It cannot reconstruct outcomes from the previous version. A missing ledger record after restart is not proof of non-delivery; verify the old Slack outcome before resending. No automatic replay occurs. At 1024 operations, allocation fails closed without deleting protection. This bounded in-memory approach deliberately avoids new filesystem/config/account access, but is not durable exactly-once delivery.

Network classification retains only known HTTP codes and allowlisted platform/transport error codes. Phase evidence distinguishes allocation, binary transfer and completion; it does not diagnose proxy, DNS or server root cause without supporting evidence. SDK/HTTP retry policies remain unchanged.

## Validation

Run `npm run check` and `validation/runtime/run.sh`. The fault fixtures cover lost completion with a concurrent successful sidecar, retained reads/explicit reply, content-hash dedupe across rename/new request, pre-completion proof and explicit recovery, affirmative versus absent share evidence, missing scopes, old ID refusal, bounded ledger and redacted diagnostics. Real OMP tests execute native tool flows with mocked Slack/model network boundaries. These tests do not establish live Slack or Windows reliability.
