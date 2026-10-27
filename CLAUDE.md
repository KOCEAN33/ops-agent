# ops-agent

NEXT SESSION: read `docs/NEXT.md` FIRST.

The owner's in-cluster first responder. It takes an Alertmanager webhook, investigates the alert, takes a reversible stopgap when a service threatens the cluster, and files the root cause as an issue on the cluster's GitOps repository. It talks to the owner in the alert's Discord thread.

`docs/design.md` indexes the design: the owner's decisions in `docs/design/chosen.md`, the mechanism in `docs/design/shape.md`, the threat model in `docs/design/threat-model.md`, and the decisions still due in Open. Read the decisions before changing shape here, take an Open item to the owner before building it, and record a new decision in `chosen.md`. Deferred work, each item with its trigger, is `docs/candidates.md`.

This repository is public. The threat model in `docs/design/threat-model.md` lists what stays out of code, fixtures, docs and commits. Use `example.com` values and generic names in test payloads. Code reads every in-cluster URL, namespace name and credential from the environment.

A separate agent runs the `coding-review` skill, which covers security, at two points: when a feature is done, meaning a `docs/NEXT.md` step meets its Done line, over the diff since the step began; and right after a commit that changes a boundary in `docs/design/`, such as permissions, the network, the deployment path, or who reads outside input. Give the reviewer the diff and the threat model, not your conclusions. Fix what it finds, or tell the owner why not.

## Stack

- Bun and TypeScript. `bun test` and `bun run typecheck` both pass before a commit.
- Models go through the Vercel AI SDK, `ai` with `@ai-sdk/anthropic`. OpenRouter and OrcaRouter join through `@openrouter/ai-sdk-provider` and `@ai-sdk/openai-compatible` when their keys exist.
- Every model call goes through the spend middleware in `src/agent/turn.ts`. A call made around it escapes both caps.
- `src/` groups code by concern: `agent/` holds the model loop and context compaction, `tools/` the tool contract and the read tools, `owner/` what reaches the owner (Discord and issues). Wiring, config, the store, the turn queue and the webhook parser sit at the top.
- The webhook groups by `alertname` and `namespace`, read from `groupLabels`. One group is one session.
