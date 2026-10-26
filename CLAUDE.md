# ops-agent

The owner's in-cluster first responder. It takes an Alertmanager webhook, investigates the alert, takes a reversible stopgap when a service threatens the cluster, and files the root cause as an issue on `homelab-platform`. It talks to the owner in the alert's Discord thread.

The design lives in `../homelab-platform/docs/plans/ops-agent.md`: its Chosen section holds the owner's decisions, its Open section the ones still due. Read it before changing shape here, and take an Open item to the owner before building it. Record a decision there, not in this repository.

This repository is public. Hostnames, addresses, vault paths, and anything from llm-wiki stay out of code, fixtures, and commits. Use `example.com` values in test payloads.

Operating instructions are the private repository `ops-agent-instructions`, cloned beside this one. The agent loads them at run time.

## Stack

- Bun and TypeScript. `bun test` and `bun run typecheck` both pass before a commit.
- Models go through the Vercel AI SDK: `ai` with `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider`, and `@ai-sdk/openai-compatible` for OrcaRouter. The loop, session store, and context compaction are built here.
- The webhook groups by `alertname` and `namespace`, read from `groupLabels`. One group is one session.
