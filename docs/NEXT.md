# Next

## Goal

Give the deployed agent its stopgaps, per `docs/design/chosen.md` Stopgap autonomy, Stopgap actions, Stoppable namespaces and Autonomous targets. The chart passes `STOPPABLE_NAMESPACES` and `STOPPABLE_LABEL_DOMAIN` to the agent, and no code in `src/` reads either yet.

## Next steps

1. **Stopgap tools.** Build the tools with the Write record in `docs/design/shape.md`, their RBAC and their admission policy. The RoleBinding per allowlisted namespace ships with the tools and the policy, never before, since its verbs reach past the stopgaps until the policy holds them. The chart builds it from `stoppable.namespaces`. Done when `bun test` covers two cases, both passing: a rerun after a completed autonomous stop stops nothing new, and an approval from an ended turn authorizes nothing.

## Pointers

- `.env` is closed to agents, but `bun` reads it on a real run. `config.yaml` holds the prod values from the GitOps repository's `ops-agent/envs/prod.yaml`, the Discord IDs included. Both files are gitignored.
- A local real run: `bun start` with `DB_PATH` and `WEBHOOK_TOKEN` on the command line, so it stays off the configured database, then POST `test/payloads/kube-job-failed.json` with the bearer token. Point `PROMETHEUS_URL` and `LOKI_URL` at a local `Bun.serve` fake for a tool loop. A second POST with a changed `fingerprint` edits the same issue. The run opens a real issue.
- Not yet run against the real endpoints: the PromQL and LogQL tools, and `kube_logs` (unverified, written before the first deployment).
- The dawarich namespace is allowlisted but its app workloads carry no stoppable label: its pinned upstream chart sets the Deployments' labels with no value to add one. They stop only through approval, and the report that Autonomous targets in `docs/design/chosen.md` requires names them.
- A smoke test, which needs `pods/portforward` in the monitoring namespace: port-forward the Alertmanager Service, POST a `severity: warning` alert with a 5-minute `endsAt` to `/api/v2/alerts`, and watch the agent's log for `alert group`. It posts to Discord and opens a real issue. Alertmanager keeps a posted alert in memory only, so a restart before `endsAt` loses it and its resolve never reaches the agent.
- A queue or outbox test whose loop never ends can keep `bun test` from exiting. Run such a test under `perl -e 'alarm 20; exec @ARGV' bun test ...`, since macOS has no `timeout`.
