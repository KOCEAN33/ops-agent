# Candidates

Deferred work: each item names what triggers it.

- **Build order after issues**: the Helm chart in `chart/` with its values in the GitOps repository, then the stopgap tools with their RBAC and admission policy. The stopgap tools bring the Write record in `docs/design.md` Shape, with tests that a rerun after a completed autonomous stop stops nothing new and that an approval from an ended turn authorizes nothing. Each step passes the `coding-review` pass that `CLAUDE.md` requires.
- **Minimum share measurement**: the 20% minimum share in `docs/design.md` (Autonomous targets) is unmeasured. Before autonomous stops are turned on, have approval-path turns compute and report each candidate's share without stopping, and set the value from what real pressure shows.
- **Prompt caching**: worth adding once tool loops resend long histories within a turn. The spend math already prices cache reads and 5-minute cache writes.
- **Org-level pricing modifiers**: `cost()` assumes list prices. An organization default of `inference_geo: "us"` (1.1x) or a 1-hour cache TTL would make it underbill. Check the owner's Anthropic organization settings before deployment.
- **Other providers**: add OpenRouter and OrcaRouter when their keys exist, each with its own price source for the spend middleware.
- **Outbox log volume**: during a Discord outage the outbox logs a failed post on every 2-second poll. When logs ship to Loki and an outage floods them, log once per outage instead.
- **Posts dropped on a revoked permission**: every 4xx drops a post, so a 403 after the bot loses a permission drops each post until the owner fixes it. If posts are lost this way, keep 403 posts queued like an outage.
- **Crash attempts on healthy turns**: a crash counts an attempt on every turn running at the time, so three crashes caused by one turn can end a healthy turn beside it at the attempt limit. Raise it with the owner if that happens.
