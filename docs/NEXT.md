# Next

## Goal

A deployed first responder per `docs/design.md`. Built in `src/` and run against the real API: the webhook, the durable turn queue, the session store, the model loop, the spend guard, and the read tools for Kubernetes, PromQL, LogQL and the GitOps clone. The Discord bot comes next, then the build order in `docs/candidates.md`.

## Next steps

1. **Build the Discord bot.** Threads, owner replies and approval buttons per `docs/design.md` (Owner channel, Session, Credentials, Threat model). Done when `bun test` shows an alert's first turn opens a thread and later turns post in it, a reply from the owner's ID queues a turn on that session and a reply from any other ID queues nothing, posts go out with embeds suppressed and off-allowlist links stripped, and a turn ended by the attempt limit or deferred by the monthly cap says so once in the thread. `src/queue.ts` logs both today, at `turn ended at attempt limit` and in the `monthly-cap` branch.

## Pointers

- Local `main` holds design commits not yet on `origin/main`. The owner pushes them: an agent's `git push` is blocked by the permission classifier. Check `git status -sb` before building on the remote.
- A real call on Claude Sonnet 5.5 costs under a cent: `bun start`, then POST `test/payloads/kube-job-failed.json` with the webhook bearer token. Set `DB_PATH` and `WEBHOOK_TOKEN` on the command line to keep the run off the configured database. A real tool loop costs about 4 cents: point `PROMETHEUS_URL` and `LOKI_URL` at a local `Bun.serve` fake.
- A turn cut by a restart runs again after `RETRY_MS` in `src/server.ts`, 60 seconds, not at once. The cut call stays charged at its worst case, about 0.17 USD on Sonnet 5.5 for a one-alert turn.
- The read tools have run only against fakes. The first run in a pod shows whether `fetch` with `tls.ca` reaches the API server and whether its Table output matches the fixtures in `test/kube.test.ts`.
- A queue test whose turn never ends can spin in microtasks and keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
