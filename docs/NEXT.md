# Next

## Goal

A deployed first responder per `docs/design.md`. Built and running in the cluster: the agent in `src/`, the Helm chart in `chart/`, and the image from the GHCR workflow. A test alert opened a Discord thread, an owner reply ran a second turn, and the alert group's issue holds the symptom, the cause and the actions, its body replaced on each turn. Next are the steps below, then the build order in `docs/candidates.md`.

## Next steps

1. **Stoppable namespaces and label.** The deployment holds neither the allowlist from Stoppable namespaces nor the label prefix from Autonomous targets in `docs/design/chosen.md`, and no workload carries the label. The owner picks the namespaces and the prefix's domain, and labels the workloads in the GitOps repositories. The chart takes both as values and passes them to the agent's environment. The RoleBinding per allowlisted namespace ships with the stopgap tools and their admission policy, never before, since its verbs reach past the stopgaps until the policy holds them. Due before the stopgap tools. Done when the deployment values hold both and the stoppable workloads in each allowlisted namespace carry the label.
2. **Archive resolved threads.** The outbox archives a session's thread once it sends a post while the session has no firing fingerprints left, and a thread opens with a 3-day auto-archive. Both sit in `src/owner/discord.ts` and have run only against the fake API in `test/discord.test.ts`. A failed archive logs `discord archive failed` and is ignored. Archiving takes Manage Threads, which the bot's role on the owner's server still lacks. Left: the owner grants it, the GitOps repository's image pin moves to a build with this code, and a smoke alert runs. Done when a resolved smoke alert's thread drops out of the channel's open thread list, and a reply in it runs a turn.

## Pointers

- The owner lets agents push here. Check `git status -sb` before building on the remote.
- `.env` is closed to agents, but `bun` reads it on a real run. `config.yaml` holds the prod values from the GitOps repository's `ops-agent/envs/prod.yaml`, the Discord IDs included.
- A local real run: `bun start` with `DB_PATH` and `WEBHOOK_TOKEN` on the command line, so it stays off the configured database, then POST `test/payloads/kube-job-failed.json` with the bearer token. One call on Claude Sonnet 5.5 costs under a cent, and a tool loop about 4 cents with `PROMETHEUS_URL` and `LOKI_URL` pointed at a local `Bun.serve` fake. A second POST with a changed `fingerprint` edits the same issue. It opens a real issue, which the owner closes.
- A turn cut by a restart runs again after `RETRY_MS` in `src/server.ts`, not at once. The cut call stays charged at its worst case, about 0.17 USD on Sonnet 5.5 for a one-alert turn.
- A Discord token that Discord rejects logs `401: Unauthorized` once and stops the gateway while the webhook stays up.
- Not yet run against the real endpoints: the PromQL and LogQL tools, and `kube_logs`, which has run only against a local fake API server. Context compaction has run only against a mock model, so its thresholds, `COMPACTION` in `src/server.ts`, and the summary prompt in `src/agent/compact.ts` are unmeasured.
- The deployment lives in the GitOps repository named in the owner's notes. It pins the chart by commit and the image by digest, so a chart fix reaches the cluster only when that pin moves. The pins sit at the commit that records the spend seed rollout. The GHCR package is public, so the registry's pull-through cache needs no credentials.
- The R2 keys reach the cluster through the GitOps repository's ExternalSecret from item `ops-agent-r2`. Litestream's start log prints the endpoint with the Cloudflare account ID, which Loki keeps.
- A GitHub App key in the secret store must keep its line breaks: a PEM pasted into a 1Password field through the app loses them.
- A one-off pod of the agent's image needs `KUBERNETES_SERVICE_HOST` set empty when it mounts no ServiceAccount token, or the start fails reading `ca.crt`.
- A smoke test, which needs `pods/portforward` in the monitoring namespace: port-forward the Alertmanager Service, POST a `severity: warning` alert with a 5-minute `endsAt` to `/api/v2/alerts`, and watch the agent's log for `alert group`. It posts to Discord and opens a real issue.
- The Anthropic console caps the organization's monthly spend at 100 USD, above the agent's 50 USD cap. It bounds what a seed that misses spend can cost.
- A queue or outbox test whose loop never ends can keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
