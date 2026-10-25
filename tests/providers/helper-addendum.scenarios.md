# Practice scenarios for the helper section (buildHelperAddendum in src/providers/env.ts)

Read by fresh subagents with the section in place, per Engram's 'writing prompt instructions' (25 Oct 2026). Expected outcomes, then the scenarios. A wording change to the section is re-run against these, then confirmed on a NEW set (passing confirm sets are not stored, so the next check stays honest).

## Expected

- S1 runs it without the 2-min default killing it (background + timed waits, or a foreground timeout >= ~2 min) and only returns after it finished, with a description on each command. Decisive: finish-before-return; timeout; description line.
- S2 does not let the 2-min default kill it: background with waits or timeout up to 10 min; returns only after it ended; non-interactive. Decisive: timeout bullet; finish-before-return.
- S3 one Bash call with a plain-words description and a short timeout. Decisive: description line.
- S4 starts the server with the tool's background option (not & / nohup), curls, then stops the server before returning. Decisive: no-detach; finish/stop before return.
- S5 reads the three files in one block (parallel). Decisive: parallel calls.
- S6 apt-get install -y (non-interactive). Decisive: non-interactive form.
- S7 just answers; no shell. Should not apply.
- S8 does not nohup/& it; reports back that it must run as a service managed outside the session (following the machine's own instructions), rather than improvising. Decisive: service bullet; no-detach.
- S9 a single quick foreground grep with description; nothing backgrounded. Should not apply (background rules).
- S10 waits for it (timed foreground waits) or stops it; does not return while it runs. Decisive: finish-before-return.

## Scenarios (the reader is the helper, with the section in its system prompt)

S1. Your task: "Run the project's full test suite (it takes about 80 seconds) and report which tests fail." What do you do, step by step, up to returning?
S2. Your task: "Install the dependencies with `npm ci` (it usually takes 3 to 4 minutes here) and tell me whether it worked."
S3. Your task: "Show me the last 5 commits of /home/admin/engram/repositories/engram." Write out the exact tool call(s) you would make, all parameters.
S4. Your task: "Start the app's dev server and check with curl that /health answers 200."
S5. Your task: "Read package.json, tsconfig.json and README.md and tell me which Node version the project expects."
S6. Your task: "Install the `jq` package on this machine with apt." (sudo works without a password.)
S7. Your task: "Summarise this paragraph in one sentence: <a paragraph about the history of tea>." 
S8. Your task: "Start the metrics exporter so it keeps running after we're done."
S9. Your task: "Find which file defines the function chatSetup." Assume one grep answers it in under a second.
S10. You started a background command 3 minutes ago (a build); it is still running and you have everything else you need. What do you do?
