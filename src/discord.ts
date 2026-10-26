import { Client, GatewayDispatchEvents, GatewayIntentBits, MessageFlags, RESTJSONErrorCodes } from "@discordjs/core";
import { DiscordAPIError, REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { redact } from "./redact";
import type { Post, Store } from "./store";

export interface Message {
  content: string;
  flags: number;
  allowed_mentions: { parse: [] };
}

export interface DiscordApi {
  // Opens a thread named name on a message in the channel. Discord gives the
  // thread the message's ID.
  openThread(channelId: string, messageId: string, name: string): Promise<string>;
  // Returns the message's ID.
  send(channelId: string, message: Message): Promise<string>;
}

// Discord refused the request for good, so sending it again changes nothing.
export class Refused extends Error {}

// The channel, thread or starter message is gone, such as one the owner
// deleted.
export class UnknownChannel extends Error {}

const MAX_CHARS = 2_000;
const MAX_THREAD_NAME = 100;

// Text in a post can come from injected alert or log text through the model.
// Redaction keeps secrets out. Embeds stay off and links off the allowlist go,
// so Discord fetches no URL that carries cluster state out, and no mention in
// the text pings anyone.
export function clean(text: string, linkHosts: ReadonlySet<string>): string {
  // No word boundary before the scheme: Discord links `_https://...` too.
  return redact(text).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, (url) => {
    try {
      if (linkHosts.has(new URL(url).hostname.toLowerCase())) return url;
    } catch {}
    return "[link removed]";
  });
}

function message(content: string): Message {
  return { content, flags: MessageFlags.SuppressEmbeds, allowed_mentions: { parse: [] } };
}

// Splits at the last line break that fits, or mid-line when none does.
export function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    const cut = rest.lastIndexOf("\n", MAX_CHARS);
    const at = cut > 0 ? cut : MAX_CHARS;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  // Discord refuses an empty message.
  return [...out, rest].filter(Boolean);
}

export interface OutboxDeps {
  store: Store;
  api: DiscordApi;
  channelId: string;
  linkHosts: ReadonlySet<string>;
}

// Sends the store's posts in order: a session's first post opens its thread,
// and a post without a session goes to the channel. A post stays queued until
// Discord takes or refuses it, so an outage delays posts and loses none.
export class Outbox {
  private busy = false;

  constructor(private d: OutboxDeps) {}

  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let post = this.d.store.nextPost(); post; post = this.d.store.nextPost()) {
        try {
          await this.deliver(post);
          this.d.store.postSent(post.id);
        } catch (e) {
          console.error(JSON.stringify({ msg: "discord post failed", postId: post.id, error: String(e) }));
          // A lost thread is replaced by a new one. A lost channel is a
          // configuration error, retried like an outage.
          const thread = post.sessionId !== null && this.d.store.thread(post.sessionId);
          if (e instanceof UnknownChannel && thread) this.d.store.forgetThread(post.sessionId!);
          else if (e instanceof Refused) this.d.store.postDropped(post.id);
          // The next flush tries again, so posts keep their order.
          else return;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // A crash between a send and its record repeats that one message.
  private async deliver(post: Post) {
    const channel = post.sessionId === null ? this.d.channelId : await this.thread(post.sessionId);
    const parts = chunks(clean(post.text, this.d.linkHosts));
    for (let i = post.sentChunks; i < parts.length; i++) {
      await this.d.api.send(channel, message(parts[i]!));
      this.d.store.postProgress(post.id, i + 1);
    }
  }

  private async thread(sessionId: number): Promise<string> {
    const known = this.d.store.thread(sessionId);
    if (known?.threadId) return known.threadId;
    const { alertname, namespace } = this.d.store.groupKey(sessionId);
    const name = clean(`${alertname} / ${namespace ?? "cluster"}`, this.d.linkHosts).slice(0, MAX_THREAD_NAME);
    let starter = known?.starterId;
    if (!starter) {
      starter = await this.d.api.send(this.d.channelId, message(name));
      this.d.store.setStarter(sessionId, starter);
    }
    const thread = await this.d.api.openThread(this.d.channelId, starter, name);
    this.d.store.setThread(sessionId, thread);
    return thread;
  }
}

export interface ReplyDeps {
  store: Store;
  ownerId: string;
  kick: () => void;
}

// Queues a turn for a message in an alert's thread. The owner's user ID is the
// only command source, so a message from anyone else, a bot included, does
// nothing.
export function onMessage(d: ReplyDeps, m: { channelId: string; authorId: string; content: string }) {
  if (m.authorId !== d.ownerId || !m.content.trim()) return;
  const sessionId = d.store.sessionForThread(m.channelId);
  if (sessionId === null) return;
  d.store.addTurn(sessionId, `The owner replied in this alert's Discord thread:\n\n${m.content}`);
  d.kick();
}

// Wait between gateway connection attempts.
const GATEWAY_RETRY_MS = 30_000;

// Returns the REST calls the outbox makes and connects to the gateway in the
// background, retrying, so a Discord outage at start never holds back the
// webhook. Replies arrive over the gateway, so nothing outside the cluster
// connects in.
export function connect(token: string, onMessage: (m: { channelId: string; authorId: string; content: string }) => void): DiscordApi {
  const rest = new REST({ version: "10" }).setToken(token);
  const gateway = new WebSocketManager({
    token,
    // Message Content is privileged: the bot's settings must enable it, or
    // replies arrive empty.
    intents: GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
    rest,
  });
  const client = new Client({ rest, gateway });
  client.on(GatewayDispatchEvents.MessageCreate, ({ data }) =>
    onMessage({ channelId: data.channel_id, authorId: data.author.id, content: data.content }),
  );
  gateway.on(WebSocketShardEvents.Error, (e) => console.error(JSON.stringify({ msg: "discord gateway error", error: String(e) })));
  // Once connected, @discordjs/ws reconnects by itself.
  const open = (): Promise<void> =>
    gateway.connect().then(
      () => console.log(JSON.stringify({ msg: "discord gateway connected" })),
      (e) => {
        console.error(JSON.stringify({ msg: "discord gateway connect failed", error: String(e) }));
        // @discordjs/rest drops a token Discord rejects, so only a restart
        // with a new one helps. Posts wait in the store until then.
        if (e instanceof DiscordAPIError && e.status === 401) return;
        return Bun.sleep(GATEWAY_RETRY_MS).then(open);
      },
    );
  void open();

  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof DiscordAPIError) {
        if (e.code === RESTJSONErrorCodes.UnknownChannel || e.code === RESTJSONErrorCodes.UnknownMessage) {
          throw new UnknownChannel(e.message);
        }
        // @discordjs/rest waits out a 429 itself.
        if (e.status >= 400 && e.status < 500) throw new Refused(e.message);
      }
      throw e;
    }
  };
  return {
    openThread: (channelId, messageId, name) =>
      call(async () => {
        try {
          return (await client.api.channels.createThread(channelId, { name }, messageId)).id;
        } catch (e) {
          // An earlier attempt opened it, and the process died before
          // recording it.
          if (e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage) return messageId;
          throw e;
        }
      }),
    send: (channelId, msg) => call(async () => (await client.api.channels.createMessage(channelId, msg)).id),
  };
}
