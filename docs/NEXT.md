# Next

## Goal

A deployed first responder per `docs/design.md`. Step 1 is built and has run against the real API: the webhook, the session store, the model loop, and the spend guard (`src/`). The read tools come next.

## Next steps

1. **Build the read tools.** These are Kubernetes reads through `view` plus the node, PV and StorageClass role, PromQL, LogQL, and a GitOps repository read, as listed in `docs/design.md` Shape. Each follows the Tool contract in Shape, and its output is redacted before the model sees it (Threat model). Wrap, escape and cut tool output the way `src/alert.ts` does. Fix the mid-turn refusal in `docs/candidates.md` in the same step. Then measure one tool loop with `count_tokens` against the input bound, since thinking resent inside a loop is unmeasured (`docs/design.md` Shape, Spend enforcement). Done when `bun test` covers each tool and each Tool contract rule, the loop measurement is recorded in Shape, and the `coding-review` pass in `CLAUDE.md` has no open finding.

2. **Make turns durable.** Replace the in-memory queue in `src/server.ts` with the Turn queue in `docs/design.md` Shape. Done when `bun test` shows a turn that fails or is cut by a restart runs again, a turn whose firing is recorded is never lost, the attempt limit ends a turn that keeps failing or crashing, retries share one per-turn cap, and the global limit holds. The Write record in Shape lands with the first write tool, with tests that a rerun after a completed autonomous stop stops nothing new and that an approval from an ended turn authorizes nothing.

## Pointers

- A real call on Claude Sonnet 5.5 costs under a cent: `bun start`, then POST `test/payloads/kube-job-failed.json` with the webhook bearer token.
