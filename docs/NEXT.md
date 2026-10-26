# Next

## Goal

A deployed first responder per `docs/design.md`. Built and running in the cluster: the agent in `src/`, the Helm chart in `chart/`, and the image from the GHCR workflow. A test alert opened a Discord thread, an owner reply ran a second turn, and the issue opened and took a comment on the default GitOps repository. Next are the steps below, then the build order in `docs/candidates.md`.

## Next steps

1. **Issue as a summary.** The issue holds the symptom, the cause found and the actions taken, kept current by replacing its body, per Hand-off and Issues in `docs/design.md`. Today each turn comments its full answer, queries and alert data. Build the record-only summary tool, the fallback for a turn with no call, and the body replacement. `BASE_INSTRUCTIONS` in `src/agent/turn.ts` must tell the model that its summary becomes the issue: the first live answer said it opened no issue while that answer became the issue body. Done when a test alert and an owner reply leave one issue with the three sections and no comments.
2. **Container logs tool.** The agent reads pods and events but no container log, so on the first live run it guessed a crash cause from events alone. Add a read tool for a container's current and previous log, tail-capped, redacted like other tool output. ClusterRole `view` already grants `pods/log`. Record it under Tools in `docs/design.md` before building, since log text is stranger text. Done when a turn reads a crashed container's previous log.
3. **Typing indicator.** The owner sees nothing in the thread while a turn runs. Send Discord's typing indicator to the session's thread every 8 seconds from the turn's start until its post is queued, since one call lasts 10 seconds. A failed typing call is ignored. Done when a reply in a thread shows the bot typing until the answer posts.
4. **Metrics.** Build `/metrics` per Metrics in `docs/design.md`, the chart's PodMonitor and the NetworkPolicy rule for the scraper. It changes a boundary, so the `coding-review` pass follows the commit. Done when Grafana shows a test alert's turn spend.
5. **SQLite durability.** Build the Litestream sidecar and restore per SQLite durability in `docs/design.md`. The bucket and its Object Read & Write token go in OpenTofu, proxmox-talos-lab `terraform/cloudflare`, beside the `disk-usage` bucket and tokens there. That root also writes the token's 1Password item with fields `endpoint`, `bucket`, `access_key` and `secret_key`. `make cloudflare-plan` and `make cloudflare-apply` wait for the owner's 1Password desktop approval. It changes the credentials and egress, so the `coding-review` pass follows the commit. Done when a pod started on an empty volume restores the file. Due before the stopgap tools.
6. **Spend seed.** Build the seed per Spend seed after a lost file in `docs/design.md`, after step 4 exports the counter. Done when a start on an empty file with no restore seeds the month's spend from the counter.

## Pointers

- The Anthropic console limits the organization's monthly spend to 100 USD, above the agent's 50 USD cap. It bounds what a lost SQLite file can cost, since the agent's own monthly cap would restart at zero.
- Check `git status -sb` before building on the remote. The owner has let agents push here.
- A real call on Claude Sonnet 5.5 costs under a cent: `bun start`, then POST `test/payloads/kube-job-failed.json` with the webhook bearer token. Set `DB_PATH` and `WEBHOOK_TOKEN` on the command line to keep the run off the configured database. A real tool loop costs about 4 cents: point `PROMETHEUS_URL` and `LOKI_URL` at a local `Bun.serve` fake.
- `.env` is closed to agents. A real run lets `bun` read it, with test values set on the command line.
- The Discord bot has run against the owner's server from a workstation: an alert opened a thread with the answer, and an owner reply in it ran a second turn on the same session. `DISCORD_*` and `LINK_ALLOWLIST` sit in `.env`. A token Discord rejects logs `401: Unauthorized` once and stops the gateway while the webhook stays up.
- A turn cut by a restart runs again after `RETRY_MS` in `src/server.ts`, 60 seconds, not at once. The cut call stays charged at its worst case, about 0.17 USD on Sonnet 5.5 for a one-alert turn.
- In the pod, `kube_list` reached the API server with the ServiceAccount's CA and parsed its Table output. The PromQL and LogQL tools have not run against the real endpoints yet.
- The workflow builds linux/amd64 alone, which matches the cluster's nodes. The GHCR package is public, so the registry's pull-through cache needs no credentials. The image is tagged `sha-<full commit>`.
- The chart runs in the cluster: git-sync clones every repository with the App's token, the probes pass under the NetworkPolicy, and the Discord gateway connects through Cilium's FQDN egress. git-sync needs `--git-config=safe.directory:/git`, because the emptyDir is root-owned with fsGroup's group.
- The deployment lives in the GitOps repository named in the owner's notes, which pins the chart by commit and the image by digest. A chart fix reaches the cluster only when that pin moves.
- A smoke test: port-forward the Alertmanager Service, POST a `severity: warning` alert with a 5-minute `endsAt` to `/api/v2/alerts`, and watch the agent's log for `alert group`. It posts to Discord and opens a real issue.
- Issues run live: the installation accepts a token scoped to issues write on one repository. `GITHUB_APP_ID`, `GITHUB_APP_KEY` and `GITOPS_REPOS` turn them on. The key in the secret store must keep its line breaks: a PEM pasted into a 1Password field through the app loses them.
- Context compaction has run only against a mock model. Its thresholds, `COMPACTION` in `src/server.ts`, and the summary prompt in `src/agent/compact.ts` are unmeasured.
- A queue or outbox test whose loop never ends can keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
