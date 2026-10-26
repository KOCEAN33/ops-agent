// Alertmanager webhook payload, version 4. Only the fields read here are typed.
// https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
interface WebhookPayload {
  groupLabels: Record<string, string>;
}

// One alert group maps to one session. The route groups by alertname and
// namespace (homelab-platform config/alertmanager/alertmanager.yaml), so both
// arrive in groupLabels. A cluster-wide alert has no namespace label.
export interface GroupKey {
  alertname: string;
  namespace: string | null;
}

function groupKey(body: unknown): GroupKey | null {
  const alertname = (body as WebhookPayload | null)?.groupLabels?.alertname;
  if (typeof alertname !== "string") return null;
  const namespace = (body as WebhookPayload).groupLabels.namespace ?? null;
  return { alertname, namespace };
}

export async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (req.method !== "POST" || pathname !== "/alertmanager") {
    return new Response(null, { status: 404 });
  }
  const key = groupKey(await req.json().catch(() => null));
  if (!key) return new Response(null, { status: 400 });
  console.log(JSON.stringify({ msg: "alert group", ...key }));
  return Response.json(key);
}

if (import.meta.main) {
  const server = Bun.serve({ port: Number(process.env.PORT ?? 8080), fetch: handle });
  console.log(`listening on ${server.url}`);
}
