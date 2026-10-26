import { redact } from "../redact";

// Text bound for Discord or GitHub can come from injected alert or log text
// through the model. Redaction keeps secrets out, and links off the allowlist
// go, so neither service nor an agent given the text fetches a URL that carries
// cluster state out.
export function clean(text: string, linkHosts: ReadonlySet<string>): string {
  // No word boundary before the scheme: Discord links `_https://...` too.
  return redact(text).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, (url) => {
    try {
      if (linkHosts.has(new URL(url).hostname.toLowerCase())) return url;
    } catch {}
    return "[link removed]";
  });
}
