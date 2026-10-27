// The agent's metrics in Prometheus's text format, scraped from their own
// port (docs/design.md, Metrics). Label values come only from fixed sets, the
// model, how a turn ended and the tool name, so no alert group adds series.

export type TurnEnd = "done" | "budget" | "monthly-cap" | "failed";

type Labels = Record<string, string>;

const key = (l: Labels) => JSON.stringify(Object.entries(l).sort());

function labelText(l: Labels): string {
  const parts = Object.entries(l).map(([k, v]) => `${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels, by = 1) {
    const k = key(labels);
    const v = this.values.get(k) ?? { labels, value: 0 };
    v.value += by;
    this.values.set(k, v);
  }

  text(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${labelText(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Histogram {
  private values = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private buckets: number[],
  ) {}

  observe(labels: Labels, x: number) {
    const k = key(labels);
    const v = this.values.get(k) ?? { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (x <= b) v.counts[i]!++;
    });
    v.sum += x;
    v.count++;
    this.values.set(k, v);
  }

  text(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.values.values()) {
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket${labelText({ ...labels, le: String(b) })} ${counts[i]}`));
      lines.push(`${this.name}_bucket${labelText({ ...labels, le: "+Inf" })} ${count}`);
      lines.push(`${this.name}_sum${labelText(labels)} ${sum}`);
      lines.push(`${this.name}_count${labelText(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

export class Metrics {
  // What the store charges: a call's reported cost, or its worst case when
  // the call may have run unreported. The month's spend is increase() over
  // it, which absorbs a restart's reset.
  readonly spend = new Counter("ops_agent_spend_usd_total", "Model spend in USD, as charged against the caps.");
  readonly turns = new Counter("ops_agent_turns_total", "Turn attempts by how they ended.");
  readonly toolCalls = new Counter("ops_agent_tool_calls_total", "Tool calls by tool.");
  // Observed when a turn ends, done or stopped by its cap. Spend covers every
  // attempt of the turn, duration and tokens the attempt that ended it.
  readonly turnSpend = new Histogram("ops_agent_turn_spend_usd", "Spend of one turn in USD.", [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5]);
  readonly turnSeconds = new Histogram("ops_agent_turn_duration_seconds", "Duration of a turn's last attempt.", [5, 10, 20, 30, 60, 120, 300, 600]);
  readonly turnInputTokens = new Histogram("ops_agent_turn_input_tokens", "Input tokens of a turn's last attempt.", [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5]);
  readonly turnOutputTokens = new Histogram("ops_agent_turn_output_tokens", "Output tokens of a turn's last attempt.", [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4]);

  text(): string {
    const all = [this.spend, this.turns, this.toolCalls, this.turnSpend, this.turnSeconds, this.turnInputTokens, this.turnOutputTokens];
    return `${all.map((m) => m.text()).join("\n")}\n`;
  }
}
