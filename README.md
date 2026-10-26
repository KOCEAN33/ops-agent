# ops-agent

An in-cluster DevOps agent for a homelab Kubernetes cluster. It receives Alertmanager webhooks, investigates each alert group, and proposes fixes. Work in progress.

```bash
bun install
bun test
PORT=8080 bun start   # POST an Alertmanager webhook payload to /alertmanager
```
