import { z } from "zod";
import { readTool, ToolError, type ReadTool } from "./contract";

export interface QueryDeps {
  // The base URL, without a trailing slash.
  url: string;
  now: () => Date;
}

const SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 } as const;
const DURATION = /^(\d+)([smhdw])$/;
const seconds = (d: string) => {
  const [, n, unit] = DURATION.exec(d)!;
  return Number(n) * SECONDS[unit as keyof typeof SECONDS];
};

const time = z
  .string()
  .refine((s) => DURATION.test(s) || !Number.isNaN(Date.parse(s)), "a duration such as 30m, or an RFC 3339 timestamp")
  .describe("A duration before now, such as 30m or 2d, or an RFC 3339 timestamp.");

// Unix seconds.
const at = (t: string | undefined, now: Date, otherwise: number) =>
  t === undefined ? now.getTime() / 1000 - otherwise : DURATION.test(t) ? now.getTime() / 1000 - seconds(t) : Date.parse(t) / 1000;

const iso = (s: number) => new Date(s * 1000).toISOString();

function range(start: string | undefined, end: string | undefined, now: Date) {
  const r = { start: at(start, now, 3_600), end: at(end, now, 0) };
  if (r.start >= r.end) throw new ToolError(`start ${iso(r.start)} is not before end ${iso(r.end)}`, "Call again with start before end.");
  return r;
}

const MAX_SERIES = 50;
const MAX_POINTS = 250;
const MAX_LINE = 500;

async function get(base: string, path: string, params: Record<string, string>, signal: AbortSignal, what: string) {
  const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, { signal });
  const body = await res.text();
  if (res.ok) return JSON.parse(body).data;
  // Prometheus answers in JSON, Loki in plain text.
  let message = body;
  try {
    message = JSON.parse(body).error ?? body;
  } catch {}
  message = message.slice(0, 2_000);
  if (res.status === 400 || res.status === 422) {
    throw new ToolError(`${what} rejected the query: ${message}`, "Fix or narrow the query and call again.");
  }
  throw new ToolError(`${what} answered ${res.status}: ${message}`, "Try a narrower query, or answer with what you have.");
}

type Sample = [number | string, string];
interface Series {
  metric?: Record<string, string>;
  stream?: Record<string, string>;
  value?: Sample;
  values?: Sample[];
}

// Loki reports nanoseconds as a string.
const nsToIso = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

function series(data: { resultType: string; result: unknown }) {
  if (data.resultType === "scalar" || data.resultType === "string") {
    return { resultType: data.resultType, result: (data.result as Sample)[1] };
  }
  const all = data.result as Series[];
  const result = all.slice(0, MAX_SERIES).map((s) => {
    if (data.resultType === "streams") {
      return { labels: s.stream, lines: s.values!.map(([ns, line]) => [nsToIso(String(ns)), line.slice(0, MAX_LINE)]) };
    }
    return s.value ? { labels: s.metric, value: s.value[1] } : { labels: s.metric, values: s.values };
  });
  return { resultType: data.resultType, result, ...(all.length > MAX_SERIES ? { omittedSeries: all.length - MAX_SERIES } : {}) };
}

export function promTools(d: QueryDeps): Record<string, ReadTool> {
  return {
    promql: readTool({
      description: "Run a PromQL instant query. Returns each series' labels and value.",
      input: z.object({ query: z.string().max(2_000), time: time.optional().describe("Defaults to now.") }),
      run: async ({ query, time: t }, signal) => {
        const s = at(t, d.now(), 0);
        const data = await get(d.url, "/api/v1/query", { query, time: String(s) }, signal, "PromQL");
        return { query, time: iso(s), ...series(data) };
      },
    }),
    promql_range: readTool({
      description: `Run a PromQL range query. Returns each series' [unix seconds, value] samples, at most ${MAX_POINTS} per series.`,
      input: z.object({
        query: z.string().max(2_000),
        start: time.optional().describe("Defaults to 1h."),
        end: time.optional().describe("Defaults to now."),
        step: z.string().regex(DURATION).optional().describe("Such as 30s or 5m. Defaults to about 120 points over the range."),
      }),
      run: async ({ query, start, end, step }, signal) => {
        const r = range(start, end, d.now());
        const span = r.end - r.start;
        const stepS = step ? seconds(step) : Math.max(15, Math.ceil(span / 120));
        const points = Math.floor(span / stepS) + 1;
        if (points > MAX_POINTS) {
          throw new ToolError(
            `a ${stepS}s step returns ${points} points per series, over the limit of ${MAX_POINTS}`,
            `Use a step of at least ${Math.ceil(span / (MAX_POINTS - 1))}s, or a shorter range.`,
          );
        }
        const params = { query, start: String(r.start), end: String(r.end), step: String(stepS) };
        const data = await get(d.url, "/api/v1/query_range", params, signal, "PromQL");
        return { query, start: iso(r.start), end: iso(r.end), step: `${stepS}s`, ...series(data) };
      },
    }),
  };
}

const ns = (s: number) => String(BigInt(Math.round(s * 1000)) * 1_000_000n);

export function lokiTools(d: QueryDeps): Record<string, ReadTool> {
  return {
    logql: readTool({
      description: `Run a LogQL query against Loki. A log query returns the newest lines first, each cut to ${MAX_LINE} characters. A metric query returns series.`,
      input: z.object({
        query: z.string().max(2_000),
        start: time.optional().describe("Defaults to 1h."),
        end: time.optional().describe("Defaults to now."),
        limit: z.number().int().min(1).max(200).optional().describe("Lines to return. Defaults to 50."),
      }),
      run: async ({ query, start, end, limit = 50 }, signal) => {
        const r = range(start, end, d.now());
        const params = { query, start: ns(r.start), end: ns(r.end), limit: String(limit), direction: "backward" };
        const data = await get(d.url, "/loki/api/v1/query_range", params, signal, "Loki");
        const out = series(data);
        const lines = data.resultType === "streams" ? (data.result as Series[]).reduce((n, s) => n + s.values!.length, 0) : 0;
        return {
          query,
          start: iso(r.start),
          end: iso(r.end),
          ...out,
          ...(lines >= limit ? { more: "The limit was reached, so older lines exist. Narrow the query or the range." } : {}),
        };
      },
    }),
  };
}
