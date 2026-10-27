# Next

## Goal

A deployed first responder per `docs/design.md`. Built and running in the cluster: the agent in `src/`, the Helm chart in `chart/`, and the image from the GHCR workflow. A test alert opened a Discord thread, an owner reply ran a second turn, and the alert group's issue holds the symptom, the cause and the actions, its body replaced on each turn. A resolved group's thread drops out of the channel's open thread list. The deployment's `stoppable` values hold the allowlist and the label domain, which reach the agent as `STOPPABLE_NAMESPACES` and `STOPPABLE_LABEL_DOMAIN`, and the stoppable workloads carry the label. No code reads either variable yet.

## Next steps

1. **Stopgap tools.** The first item of the build order in `docs/candidates.md`. The RoleBinding per allowlisted namespace ships with the tools and their admission policy, never before, since its verbs reach past the stopgaps until the policy holds them. The chart builds it from `stoppable.namespaces`.

## Pointers

- The owner lets agents push here. Check `git status -sb` before building on the remote.
- `.env` is closed to agents, but `bun` reads it on a real run. `config.yaml` holds the prod values from the GitOps repository's `ops-agent/envs/prod.yaml`, the Discord IDs included.
- A local real run: `bun start` with `DB_PATH` and `WEBHOOK_TOKEN` on the command line, so it stays off the configured database, then POST `test/payloads/kube-job-failed.json` with the bearer token. One call on Claude Sonnet 5.5 costs under a cent, and a tool loop about 4 cents with `PROMETHEUS_URL` and `LOKI_URL` pointed at a local `Bun.serve` fake. A second POST with a changed `fingerprint` edits the same issue. It opens a real issue, which the owner closes.
- A turn cut by a restart runs again after `RETRY_MS` in `src/server.ts`, not at once. The cut call stays charged at its worst case, about 0.17 USD on Sonnet 5.5 for a one-alert turn.
- A Discord token that Discord rejects logs `401: Unauthorized` once and stops the gateway while the webhook stays up.
- Not yet run against the real endpoints: the PromQL and LogQL tools, and `kube_logs`, which has run only against a local fake API server. Context compaction has run only against a mock model, so its thresholds, `COMPACTION` in `src/server.ts`, and the summary prompt in `src/agent/compact.ts` are unmeasured.
- The deployment lives in the GitOps repository named in the owner's notes. It pins the chart by release tag and the image by digest, and the workflow's deploy job moves both on each push to main. The job reads the repository's name from the `GITOPS_REPO` secret and its GitHub App from the `HOMELAB_APP_CLIENT_ID` variable and the `HOMELAB_APP_PRIVATE_KEY` secret. The GHCR package is public, so the registry's pull-through cache needs no credentials.
- The R2 keys reach the cluster through the GitOps repository's ExternalSecret from item `ops-agent-r2`. Litestream's start log prints the endpoint with the Cloudflare account ID, which Loki keeps.
- A GitHub App key in the secret store must keep its line breaks: a PEM pasted into a 1Password field through the app loses them.
- A one-off pod of the agent's image needs `KUBERNETES_SERVICE_HOST` set empty when it mounts no ServiceAccount token, or the start fails reading `ca.crt`.
- The dawarich namespace is allowlisted but its app workloads carry no stoppable label: its pinned upstream chart sets the Deployments' labels with no value to add one. They stop only through approval, and the report that Autonomous targets in `docs/design/chosen.md` requires names them.
- A smoke test, which needs `pods/portforward` in the monitoring namespace: port-forward the Alertmanager Service, POST a `severity: warning` alert with a 5-minute `endsAt` to `/api/v2/alerts`, and watch the agent's log for `alert group`. It posts to Discord and opens a real issue. Alertmanager keeps a posted alert in memory only, so a restart before `endsAt` loses it and its resolve never reaches the agent.
- The Anthropic console caps the organization's monthly spend at 100 USD, above the agent's 50 USD cap. It bounds what a seed that misses spend can cost.
- A queue or outbox test whose loop never ends can keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
