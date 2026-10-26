# Next

## Goal

A deployed first responder per `docs/design.md`. Built in `src/`: the webhook, the durable turn queue, the session store, the model loop, the spend guard, the read tools for Kubernetes, PromQL, LogQL and the GitOps clone, and the Discord bot with threads, owner replies and an outbox. Context compaction and issues come next, then the build order in `docs/candidates.md`.

## Next steps

1. **Compact session context.** Session history grows without bound, and owner replies lengthen it, so a long-lived session's worst case eventually passes `TURN_CAP_USD` and every turn in it is refused. Replace old tool output with a short marker first, and summarize only past a higher threshold: measured on coding benchmarks, that order cost least at an equal success rate. Done when `bun test` shows a session whose history passes a size threshold sends old tool output as a short marker, a session past a higher threshold sends a summary in place of its oldest turns, and the stored messages stay whole so a later change of threshold applies to them.
2. **Open issues.** Per `docs/design.md` (Hand-off, Credentials, Threat model). Done when `bun test` shows a session's first finished turn opens one issue on the GitOps repository through the GitHub App, a later turn on the session comments on that issue, stranger text sits in fenced blocks marked as quoted alert data, and the body is redacted and loses links and images whose host is off `LINK_ALLOWLIST`. Issue writes go through a durable queue like the Discord outbox in `src/discord.ts`.

## Pointers

- Local `main` holds commits not yet on `origin/main`. The owner pushes them: an agent's `git push` is blocked by the permission classifier. Check `git status -sb` before building on the remote.
- A real call on Claude Sonnet 5.5 costs under a cent: `bun start`, then POST `test/payloads/kube-job-failed.json` with the webhook bearer token. Set `DB_PATH` and `WEBHOOK_TOKEN` on the command line to keep the run off the configured database. A real tool loop costs about 4 cents: point `PROMETHEUS_URL` and `LOKI_URL` at a local `Bun.serve` fake.
- `.env` is closed to agents. A real run lets `bun` read it, with test values set on the command line.
- The Discord bot has run against the owner's server from a workstation: an alert opened a thread with the answer, and an owner reply in it ran a second turn on the same session. `DISCORD_*` and `LINK_ALLOWLIST` sit in `.env`. A token Discord rejects logs `401: Unauthorized` once and stops the gateway while the webhook stays up.
- A turn cut by a restart runs again after `RETRY_MS` in `src/server.ts`, 60 seconds, not at once. The cut call stays charged at its worst case, about 0.17 USD on Sonnet 5.5 for a one-alert turn.
- The read tools have run only against fakes. The first run in a pod shows whether `fetch` with `tls.ca` reaches the API server and whether its Table output matches the fixtures in `test/kube.test.ts`.
- A queue or outbox test whose loop never ends can keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
