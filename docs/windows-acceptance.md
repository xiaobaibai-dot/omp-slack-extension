# Windows live acceptance (pending)

Use a dedicated test channel, explicit owner/channel allowlists and no local shell/file tools initially. Have the operator provide credentials privately. Do not use production messages as fixtures.

1. Confirm OMP version/runtime, dependency installation and extension loading. `/slack status` must be off, with no Slack WebSocket before enable.
2. Run `/slack`; verify workspace and configured app. Send an owner @mention in a test channel and a 1:1 DM. Both should receive a final reply in the source thread.
3. Trigger two distinct channel threads and a DM; ask each about unique context. Confirm no host transcript or other route context leaks. Same-route followup must preserve bounded continuity.
4. Verify other users/bots cannot trigger the model. While host is busy, requests should queue without changing host input. Original host conversation must remain intact after worker disposal.
5. `/slack off` during a long task must clear queue/history and suppress later replies. A request already sent to Slack cannot be recalled. Retry enable and check no stale callbacks run.
6. Confirm restart/session switch returns to off. Run only one listener for the app across machines.
7. Test optional upload only after explicit `files:write` approval and dedicated output-root setup. Check Windows paths, hidden paths, traversal and cancellation. Requests already submitted may still complete; cancellation prevents subsequent phases, not server-side rollback.
8. Only then consider local tools. Verify host approval rules remain effective; missing remote approval UI must not silently bypass them. These tools are not filesystem-sandboxed and share process privileges.
9. Record actual OMP/runtime versions, results and redacted error categories. Never attach environment dumps or tokens.

Current status: not run on Windows, no real Slack roundtrip or live model invocation verified.
