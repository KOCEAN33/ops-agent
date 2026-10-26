# Next

## Goal

A deployed first responder per `docs/design.md`. Built in `src/` and run against the real API: the webhook, the session store, the model loop, the spend guard, and the read tools for Kubernetes, PromQL, LogQL and the GitOps clone. Durable turns come next, then the build order in `docs/candidates.md`.

## Next steps

1. **Make turns durable.** Replace the in-memory queue in `src/server.ts` with the Turn queue in `docs/design.md` Shape. Done when `bun test` shows a turn that fails or is cut by a restart runs again, a turn whose firing is recorded is never lost, the attempt limit ends a turn that keeps failing or crashing, retries share one per-turn cap, and the global limit holds. The Write record in Shape lands with the first write tool, with tests that a rerun after a completed autonomous stop stops nothing new and that an approval from an ended turn authorizes nothing.

## Pointers

- Local `main` holds design commits not yet on `origin/main`. The owner pushes them: an agent's `git push` is blocked by the permission classifier. Check `git status -sb` before building on the remote.
- A real call on Claude Sonnet 5.5 costs under a cent: `bun start`, then POST `test/payloads/kube-job-failed.json` with the webhook bearer token. A real tool loop costs about 4 cents: point `PROMETHEUS_URL` and `LOKI_URL` at a local `Bun.serve` fake.
- The read tools have run only against fakes. The first run in a pod shows whether `fetch` with `tls.ca` reaches the API server and whether its Table output matches the fixtures in `test/kube.test.ts`.
