# Next

## Goal

A deployed first responder per `docs/design.md`. Built in `src/`: the webhook, the durable turn queue, the session store with context compaction, the model loop, the spend guard, the read tools for Kubernetes, PromQL, LogQL and the GitOps clone, the Discord bot with threads, owner replies and an outbox, and the issue hand-off through the GitHub App. Next is the build order in `docs/candidates.md`, starting with the Helm chart.

## Next steps

1. **Helm chart.** Per `docs/design.md` (Deployment, Inputs, Credentials, Spend enforcement). Done when `helm lint` passes and `helm template` with example values renders one replica with the `Recreate` strategy, a ServiceAccount bound to `view` and to a ClusterRole for `nodes`, `persistentvolumes` and `storageclasses`, a NetworkPolicy that admits ingress from Alertmanager alone, and every credential from a Secret. The stopgap RoleBindings and admission policies come with the stopgap tools.

## Pointers

- Local `main` holds commits not yet on `origin/main`. The owner pushes them: an agent's `git push` is blocked by the permission classifier. Check `git status -sb` before building on the remote.
- A real call on Claude Sonnet 5.5 costs under a cent: `bun start`, then POST `test/payloads/kube-job-failed.json` with the webhook bearer token. Set `DB_PATH` and `WEBHOOK_TOKEN` on the command line to keep the run off the configured database. A real tool loop costs about 4 cents: point `PROMETHEUS_URL` and `LOKI_URL` at a local `Bun.serve` fake.
- `.env` is closed to agents. A real run lets `bun` read it, with test values set on the command line.
- The Discord bot has run against the owner's server from a workstation: an alert opened a thread with the answer, and an owner reply in it ran a second turn on the same session. `DISCORD_*` and `LINK_ALLOWLIST` sit in `.env`. A token Discord rejects logs `401: Unauthorized` once and stops the gateway while the webhook stays up.
- A turn cut by a restart runs again after `RETRY_MS` in `src/server.ts`, 60 seconds, not at once. The cut call stays charged at its worst case, about 0.17 USD on Sonnet 5.5 for a one-alert turn.
- The read tools have run only against fakes. The first run in a pod shows whether `fetch` with `tls.ca` reaches the API server and whether its Table output matches the fixtures in `test/kube.test.ts`.
- Issues have run only against fakes. `GITHUB_APP_ID`, `GITHUB_APP_KEY` (the App's PEM) and `GITOPS_REPO` (`owner/name`) turn them on. The first real run shows whether the App's installation accepts a token scoped to issues write. GitHub's `/markdown` API rendered a sample body with only allowlisted links live.
- Context compaction has run only against a mock model. Its thresholds, `COMPACTION` in `src/server.ts`, and the summary prompt in `src/compact.ts` are unmeasured.
- A queue or outbox test whose loop never ends can keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
