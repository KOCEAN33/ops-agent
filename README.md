# ops-agent

A first responder that runs inside a homelab Kubernetes cluster and answers its alerts. When Alertmanager fires, the agent investigates with a fixed set of tools and reports in a Discord thread. When a service threatens the cluster, it takes a reversible stopgap, such as scaling that service to zero. It files the root cause as an issue on the cluster's GitOps repository, where a stronger agent picks up the fix.

It protects, in order, data, then security, then service. It is an operator, not an engineer: unlike [HolmesGPT](https://github.com/HolmesGPT/holmesgpt), it stops at containment and hands the analysis off.

## Design

- **Trigger**: Alertmanager sends every `warning` or `critical` alert group to the agent's webhook. Alert delivery to Discord does not go through the agent, so the agent being down loses no alert.
- **Session**: one alert group, keyed by `alertname` and `namespace`, is one session, one Discord thread, and one issue. The owner's reply in the thread resumes that session.
- **Tools**: each tool is a fixed function, never a shell.
  - Read Kubernetes objects through a ServiceAccount bound to the `view` ClusterRole, which excludes Secrets.
  - Query logs with LogQL against Loki and metrics with PromQL against Prometheus.
  - Read the GitOps repository at `main`.
  - Open or comment on an issue in that repository through a GitHub App scoped to it.
  - Stopgaps: scale a workload to zero, suspend a CronJob, or restart a Pod.
- **Stopgap autonomy**: the agent acts on its own only when its own metric queries show a cluster-wide threat, such as node pressure or shared storage near full. Every other stopgap waits for the owner's approval button in the thread.
- **Models**: the [Vercel AI SDK](https://ai-sdk.dev) reaches Anthropic directly, OpenRouter, or any OpenAI-compatible endpoint, so the provider is a configuration choice.
- **Memory**: incident history is kept in SQLite on the agent's volume. Operating instructions are markdown in a separate private repository, reloaded on each new commit.

## Safety

- RBAC and an admission policy limit writes to the three stopgaps, in namespaces on an owner-set allowlist. Databases, backups, and the platform itself are never on it. The prompt enforces nothing.
- Every stopgap keeps volumes and is undone by one reverse action, so the worst case of a wrong stop is downtime. The agent does not undo its own stopgap: the owner approves the undo.
- Log lines, alert annotations, and messages from anyone other than the owner are data. No tool runs a command taken from that text, and the cluster-wide threat test reads only metrics the agent queried.
- The agent's environment holds only model API keys and the GitHub App key.

## Status

Early. A webhook notification starts or resumes its group's session, and the agent answers with a model call. Sessions and spend are stored in SQLite. Tools, the Discord bot, and issues come next.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
bun start   # POST an Alertmanager webhook payload to /alertmanager
```

`bun start` reads its configuration from the environment and exits when a required variable is missing.

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `MODEL` | Anthropic model ID |
| `PRICE_INPUT`, `PRICE_OUTPUT`, `PRICE_CACHE_READ`, `PRICE_CACHE_WRITE` | the model's price, USD per million tokens |
| `TURN_CAP_USD` | spend at which one turn stops |
| `MONTHLY_CAP_USD` | spend at which the agent stops calling models until the month turns (UTC) |
| `DB_PATH` | SQLite file for sessions and spend |
| `INSTRUCTIONS_DIR` | optional, a clone of the operating instructions, read on each turn |
| `PORT` | optional, default 8080 |

`test/payloads/` holds sample webhook payloads in the Alertmanager v4 format.
