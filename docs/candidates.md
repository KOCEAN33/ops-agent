# Candidates

Deferred work: each item names what triggers it.

- **Build order after the read tools**: the Discord bot with threads, replies and approval buttons, then issues, then deployment manifests in the private deployment repository, then the stopgap tools with their RBAC and admission policy. Each step passes the security review that `CLAUDE.md` requires.
- **Mid-turn refusal drops the turn**: when a reservation is refused in the middle of a tool loop, `runTurn` in `src/agent.ts` throws `OverBudget` and discards the turn's messages, including a stopgap the turn already ran. Fix it with the first tool, before any write tool exists.
- **Turn-cap stop test**: the `overBudget` stop condition in `src/agent.ts` has no test, because a turn without tools is one step. Add one with the first tool.
- **Context compaction**: session history grows without bound, so a long-lived session's worst case eventually passes `TURN_CAP_USD`, and every turn in it is refused. Build it with the Discord bot, when owner replies lengthen sessions. Replace old tool output with a short marker first, and summarize only past a higher threshold: measured on coding benchmarks, that order cost least at an equal success rate.
- **Prompt caching**: worth adding once tool loops resend long histories within a turn. The spend math already prices cache reads and 5-minute cache writes.
- **Org-level pricing modifiers**: `cost()` assumes list prices. An organization default of `inference_geo: "us"` (1.1x) or a 1-hour cache TTL would make it underbill. Check the owner's Anthropic organization settings before deployment.
- **Other providers**: add OpenRouter and OrcaRouter when their keys exist, each with its own price source for the spend middleware.
