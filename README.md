# ops-agent

A first responder that runs inside a homelab Kubernetes cluster and answers its alerts. When Alertmanager fires, the agent investigates with a fixed set of tools and reports in a Discord thread. When a service threatens the cluster, it takes a reversible stopgap, such as scaling that service to zero. It files the root cause as an issue on the cluster's GitOps repository, where the owner takes up the fix.

It protects, in order, data, then security, then service. It is an operator, not an engineer: unlike [HolmesGPT](https://github.com/HolmesGPT/holmesgpt), it stops at containment and hands the analysis off.

## Design

Each tool is a fixed function, never a shell. Writes are limited to three reversible stopgaps in namespaces the owner allowlists, enforced by RBAC and an admission policy rather than the prompt. Every model call is held to a per-turn and a monthly spend cap. [`docs/design.md`](docs/design.md) holds the decisions, the mechanism behind them, and the threat model.

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

`bun start` reads its configuration from the environment and exits when a required variable is missing. Copy `.env.example` to `.env`, which Bun loads and git ignores, and fill it in.

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `MODEL` | Anthropic model ID. The price comes from a table in `src/config.ts`, and an unlisted model stops the start. |
| `PRICE_INPUT`, `PRICE_OUTPUT`, `PRICE_CACHE_READ`, `PRICE_CACHE_WRITE` | optional, all four or none, USD per million tokens. Overrides the table. |
| `TURN_CAP_USD` | spend at which one turn stops |
| `MONTHLY_CAP_USD` | spend at which the agent stops calling models until the month turns (UTC) |
| `DB_PATH` | SQLite file for sessions and spend |
| `WEBHOOK_TOKEN` | the bearer token every webhook request must carry |
| `INSTRUCTIONS_DIR` | optional, a clone of the operating instructions, read on each turn |
| `PORT` | optional, default 8080 |

`test/payloads/` holds sample webhook payloads in the Alertmanager v4 format.
