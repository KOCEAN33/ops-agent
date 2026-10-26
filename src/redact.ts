// Pattern redaction for text bound for the model, a log, Discord or GitHub.
// It catches secrets in known token formats, URL passwords, bearer headers and
// values under keys that end in a secret's name. It misses a bare secret under
// an innocent key, so a tool that reads structured objects also redacts by
// field, as src/kube.ts does for env values.
const RULES: [RegExp, string][] = [
  // A block cut before its END line is redacted to the end of the text.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*)/g, "[redacted private key]"],
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]+/g, "[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{20,})/g, "[redacted]"],
  [/\bsk-[\w-]{20,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bxox[abposr]-[\w-]{10,}/g, "[redacted]"],
  [/\b[MNO][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,}/g, "[redacted]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+):[^\s/@"']+@/gi, "$1:[redacted]@"],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]"],
  // `secretName` or `tokenExpirationSeconds` names a secret without holding
  // one, so the key must end in the word. A value opening an object, a list or
  // a template is skipped. A quote may carry escapes, as in JSON logged inside
  // a JSON string. A value stops at a backslash, so redacting JSON never
  // breaks an escaped quote.
  [
    /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?)(?![{[$\s"'\\])[^\s"',}\\]+/gi,
    "$1[redacted]",
  ],
];

export function redact(text: string): string {
  return RULES.reduce((t, [re, to]) => t.replace(re, to), text);
}
