# ops-agent

A first responder that runs inside a homelab Kubernetes cluster and answers its alerts. When Alertmanager fires, the agent investigates with a fixed set of tools and reports in a Discord thread. When a service threatens the cluster, it takes a reversible stopgap, such as scaling that service to zero. It files the root cause as an issue on the cluster's GitOps repository, where the owner takes up the fix.

It protects, in order, data, then security, then service. It is an operator, not an engineer: unlike [HolmesGPT](https://github.com/HolmesGPT/holmesgpt), it stops at containment and hands the analysis off.

## Design

Each tool is a fixed function, never a shell. Writes are limited to three reversible stopgaps in namespaces the owner allowlists, enforced by RBAC and an admission policy rather than the prompt. Every model call is held to a per-turn and a monthly spend cap. [`docs/design.md`](docs/design.md) holds the decisions, the mechanism behind them, and the threat model.

## Status

Not yet deployed. A webhook notification starts or resumes its group's session in a durable turn queue. The agent investigates with read tools for Kubernetes, PromQL, LogQL and a clone of the GitOps repository, answers in the alert's Discord thread, and hands off to an issue on the GitOps repository through a GitHub App. Sessions, the queue, spend and both outboxes live in SQLite. The stopgap tools come next.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
bun start   # POST an Alertmanager webhook payload to /alertmanager
```

`bun start` reads its configuration from the environment and exits when a required variable is missing. Copy `.env.example` to `.env`, which Bun loads and git ignores, and fill it in.

`.env.example` lists every variable with its meaning. The required ones are `ANTHROPIC_API_KEY`, `MODEL`, `TURN_CAP_USD`, `MONTHLY_CAP_USD`, `DB_PATH` and `WEBHOOK_TOKEN`. Each read source, the Discord bot and issues stay off until their variables are set.

`test/payloads/` holds sample webhook payloads in the Alertmanager v4 format.

## Deployment

`chart/` is a Helm chart: one replica on a PersistentVolumeClaim, git-sync sidecars for the GitOps and instructions repositories, a NetworkPolicy that admits the webhook from Alertmanager alone, and an optional CiliumNetworkPolicy that limits egress by host name. Credentials come from an existing Secret. `chart/values.yaml` documents each value.
