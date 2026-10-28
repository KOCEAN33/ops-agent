import { redact } from "./redact";
import type { Store, Turn } from "./store";
import { notices } from "./owner/notices";

export interface QueueDeps {
  store: Store;
  run: (turn: Turn) => Promise<{ text: string } | { skipped: "monthly-cap" | "budget" }>;
  now: () => Date;
  // Turns running at once, across sessions.
  limit: number;
  // Wait before a failed or deferred turn runs again.
  retryMs: number;
  maxAttempts: number;
}

// Runs the pending turns in the store. Turns on one session run in order, so
// each sees the last one's messages, and a turn waits for the one before it to
// end. Turns on different sessions run in parallel up to the limit. The store
// holds every turn's state, so a new queue on the same file picks up where a
// crashed one stopped.
export class TurnQueue {
  private running = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private d: QueueDeps) {}

  // Starts every turn that may start now, and sets a timer for the earliest
  // one that may not yet. Call it after queueing a turn and at start.
  kick() {
    clearTimeout(this.timer);
    const now = this.d.now().getTime();
    let wake = Infinity;
    const seen = new Set<number>();
    for (const head of this.d.store.pending()) {
      if (seen.has(head.sessionId)) continue;
      seen.add(head.sessionId);
      if (this.running.has(head.sessionId)) continue;
      if (head.nextAt > now) {
        wake = Math.min(wake, head.nextAt);
        continue;
      }
      // A turn that ends kicks again, so a turn left here is not stranded.
      if (this.running.size >= this.d.limit) break;
      const turn = this.d.store.claim(head.id, now, this.d.retryMs, this.d.maxAttempts);
      if (!turn) {
        console.error(JSON.stringify({ msg: "turn ended at attempt limit", sessionId: head.sessionId }));
        // The next turn on the session may start now.
        seen.delete(head.sessionId);
        continue;
      }
      this.start(turn);
    }
    if (wake < Infinity) {
      this.timer = setTimeout(() => this.kick(), wake - now);
      this.timer.unref?.();
    }
  }

  private start(turn: Turn) {
    this.running.add(turn.sessionId);
    const sessionId = turn.sessionId;
    this.d
      .run(turn)
      .then(
        (r) => {
          if ("skipped" in r && r.skipped === "monthly-cap") {
            const now = this.d.now();
            this.d.store.defer(turn.id, now.getTime() + this.d.retryMs);
            this.d.store.noticeOnce(`monthly-cap ${now.toISOString().slice(0, 7)}`, notices.monthlyCap);
          }
          console.log(JSON.stringify({ msg: "turn", sessionId, ...("text" in r ? { text: redact(r.text) } : r) }));
        },
        (e) => console.error(JSON.stringify({ msg: "turn failed", sessionId, error: String(e) })),
      )
      .finally(() => {
        this.running.delete(sessionId);
        this.kick();
      });
  }
}
