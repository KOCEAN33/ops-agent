# Design

ops-agent is the first responder for one Kubernetes cluster and its one owner. The design sits in one file per section under `docs/design/`:

- `chosen.md`: the owner's decisions, each with what was rejected. Read it before changing shape here, and record a new decision in it.
- `shape.md`: the mechanism behind the decisions: inputs, sessions, posts, issues, the turn queue, compaction, the Write record, tools and their contract, the write boundary, credentials and spend enforcement. Read the item for the code you change.
- `threat-model.md`: what stays out of this public repository, how stranger text is handled, redaction, and the link rule. Read it before a change that reads outside input or posts outward, and hand it to the `coding-review` agent.

## Open

Decisions still due. Take an Open item to the owner before building it.

- None.
