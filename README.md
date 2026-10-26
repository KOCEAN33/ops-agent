# ops-agent

A DevOps agent that runs inside a homelab Kubernetes cluster and answers its alerts. When Alertmanager fires, the agent investigates, explains what it found in a Discord thread, and proposes a fix. When the fix is a manifest change, it opens a pull request on the cluster's GitOps repository. The owner stays in the loop: replying in the thread continues the investigation, and nothing changes in the cluster until the owner merges.

It fills the role of [HolmesGPT](https://github.com/HolmesGPT/holmesgpt), built for one cluster and one owner, with a conversation that lasts as long as the alert does.

## Design

- **Trigger**: Alertmanager sends every `warning` or `critical` alert group to the agent's webhook. Alert delivery to Discord does not go through the agent, so the agent being down loses no alert.
- **Session**: one alert group, keyed by `alertname` and `namespace`, is one session and one Discord thread. The owner's reply in the thread resumes that session.
- **Tools**: each tool is a fixed function, never a shell.
  - Read Kubernetes objects through a ServiceAccount bound to the `view` ClusterRole, which excludes Secrets.
  - Query logs with LogQL against Loki and metrics with PromQL against Prometheus.
  - Read the GitOps repository at `main`.
  - Open a pull request on that repository through a GitHub App scoped to it.
- **Models**: the [Vercel AI SDK](https://ai-sdk.dev) reaches Anthropic directly, OpenRouter, or any OpenAI-compatible endpoint, so the provider is a configuration choice.
- **Memory**: incident history is kept in SQLite on the agent's volume. Operating instructions are markdown in a separate private repository, reloaded on each new commit.

## Safety

- The agent changes the cluster only through a pull request the owner merges, and Argo CD applies it. The RBAC binding enforces this, not the prompt.
- The pull request tool refuses any diff that touches the production database's manifests.
- Log lines, alert annotations, and messages from anyone other than the owner are data. No tool runs a command taken from that text.
- The agent's environment holds only model API keys and the GitHub App key.

## Status

Early. The webhook endpoint accepts an Alertmanager payload and logs its group key. The agent loop, tools, Discord bot, and deployment manifests come next.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install
bun test
bun run typecheck
PORT=8080 bun start   # POST an Alertmanager webhook payload to /alertmanager
```

`test/payloads/` holds sample webhook payloads in the Alertmanager v4 format.
