# Next

## Goal

A deployed first responder per `docs/design.md`. Step 1 is built: the webhook, the session store, the model loop, and the spend guard (`src/`). The read tools come next.

## Next steps

1. **Compare the owner's notes with the design.** Use the `wiki-lookup` skill to find the owner's notes on agent sandbox or harness design for Kubernetes. Compare them with `docs/design.md`. Report to the owner the patterns the design lacks and the decisions that conflict, one line each with the note and the design section. Done when the owner has the report and has said which items to adopt. Adopted items go into `docs/design.md` in general terms, since this repository is public.
2. **Run one real model call.** This needs `ANTHROPIC_API_KEY` and `WEBHOOK_TOKEN` in `.env`, so ask the owner if they are missing. Start `bun start` and POST `test/payloads/kube-job-failed.json` with the bearer token. Done when the log shows a `turn` line with model text and the `spend` table shows a nonzero row.
3. **Probe the input bound.** The spend middleware assumes a call bills no more input tokens than the UTF-8 bytes of its prompt and tools plus `INPUT_ALLOWANCE_TOKENS` (`src/agent.ts`). It also assumes that thinking signatures in history are no smaller than the thinking they stand for. Count a stored multi-turn session with Anthropic's free `count_tokens` endpoint and compare the result with the bound. Done when the result is recorded in `docs/design.md` Shape, or the bound is fixed if the count exceeds it.
4. **Build the read tools.** These are Kubernetes reads through `view` plus the node, PV and StorageClass role, PromQL, LogQL, and a GitOps repository read, as listed in `docs/design.md` Shape. Wrap, escape and cut tool output the way `src/alert.ts` does. Fix the mid-turn refusal in `docs/candidates.md` in the same step. Done when `bun test` covers each tool and a separate agent's security review has no open finding.
