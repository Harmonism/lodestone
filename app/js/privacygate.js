// privacygate.js — what should not reach a model, found on this device before a
// message leaves it (1.12, after Lode's privacy gate, src/privacygate.js there).
//
// Before a message goes to a model that runs elsewhere (a rented model, the
// harmonism.io account), its words and the text of its attachments are scanned
// for private keys, API keys and tokens, password lines, card numbers
// (Luhn-checked) and IBANs (checksum-checked). Found, the practitioner sees what
// was found, masked, and chooses: leave them out (each replaced by a short
// marker), send as written, or go back. A model on this computer sends nothing
// away, so nothing is asked there.
//
// Whatever was chosen, keys and private keys are never kept: the copy of a
// message and its attachments stored in the conversation (and so synced and
// exported) has them replaced (redact()).

const mask = s => { s = String(s); return s.length <= 8 ? s[0] + "…" : s.slice(0, 4) + "…" + s.slice(-2); };

export function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = +digits[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
}
export function ibanOk(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let m = 0; for (const ch of r) m = (m * 10 + +ch) % 97;
  return m === 1;
}
const cardCheck = m => {
  // A number followed by its expiry or code is tried again without the groups after it.
  const groups = m.split(/[ .-]/);
  for (let k = groups.length; k >= 1; k--) { const d = groups.slice(0, k).join("").replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) return true; if (groups.length === 1) break; }
  return false;
};

// `value`: the group holding the secret itself, when the match carries a label before it.
const RULES = [
  { kind: "private-key", label: "a private key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g, key: true },
  { kind: "xai", label: "an xAI key", re: /\bxai-[A-Za-z0-9]{20,}/g, key: true },
  { kind: "aws-secret", label: "an AWS secret key", re: /\b(aws_secret_access_key["']?\s*[:=]\s*["']?)([A-Za-z0-9/+]{30,})/gi, value: 2, key: true },
  { kind: "openrouter", label: "an OpenRouter key", re: /\bsk-or-v1-[a-f0-9]{48,}\b/g, key: true },
  { kind: "anthropic", label: "an Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, key: true },
  { kind: "openai", label: "an OpenAI key", re: /\bsk-(?:proj-)?(?!or-v1-|ant-)[A-Za-z0-9_-]{32,}/g, key: true },
  { kind: "github", label: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/g, key: true },
  { kind: "aws", label: "an AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, key: true },
  { kind: "google", label: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, key: true },
  { kind: "slack", label: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, key: true },
  { kind: "groq", label: "a Groq key", re: /\bgsk_[A-Za-z0-9]{40,}\b/g, key: true },
  { kind: "huggingface", label: "a Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/g, key: true },
  { kind: "stripe", label: "a Stripe secret key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g, key: true },
  { kind: "telegram", label: "a Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, key: true },
  { kind: "jwt", label: "a signed token (JWT)", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, key: true },
  // Also DB_PASSWORD=…, "password": "…", mot de passe : …
  // The value must look like one (1.13.1): a digit or a sign in it, so "my
  // password was changed" and "Secret: the meeting" are prose, not secrets.
  // The label is looked for only where a word begins (a lookbehind, 1.13.1): the
  // old "(?:^|[^A-Za-z])(?:[A-Za-z0-9]*_)?" rescanned every run of digits, and
  // 80 KB of them took 13 seconds.
  { kind: "password", label: "a password", re: /((?<![A-Za-z0-9])(?:[A-Za-z0-9]*_)?(?:password|passwd|pwd|passphrase|secret|mot de passe|mdp|contraseña|passwort)["']?\s*[:=]\s*["']?)((?=[^\s"']*[^\p{L}\s"'])[^\s"']{4,})/giu, value: 2 },
  { kind: "password", label: "a password", re: /((?<![A-Za-z0-9])(?:my\s+|mon\s+|mi\s+)?(?:password|mot de passe|mdp|contraseña|passwort)\s+(?:is|was|est|es|ist|era|c'est)\s+)((?=[^\s"']*[^\p{L}\s"'])[^\s"']{4,})/giu, value: 2 },
  { kind: "url-password", label: "a password in an address", re: /(\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@\/]{1,64}:)([^\s@\/]{3,128})(?=@)/gi, value: 2, key: true },
  { kind: "bearer", label: "a bearer token", re: /\b(Bearer\s+)([A-Za-z0-9._~+\/-]{20,}=*)/g, value: 2, key: true },
  { kind: "env-secret", label: "a key or token", re: /((?<![A-Za-z0-9])[A-Za-z0-9_]*(?:API_KEY|APIKEY|_TOKEN|_SECRET|ACCESS_KEY|PRIVATE_KEY)["']?\s*[:=]\s*["']?)([^\s"']{8,})/gi, value: 2, key: true },
  { kind: "google-oauth", label: "a Google access token", re: /\bya29\.[0-9A-Za-z_-]{20,}/g, key: true },
  { kind: "discord", label: "a Discord token", re: /\b[MNO][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/g, key: true },
  { kind: "slack-webhook", label: "a Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/g, key: true },
  { kind: "card", label: "a card number", re: /\b[3-6]\d{3}(?:[ .-]?\d){9,15}\b/g, check: cardCheck },
  { kind: "iban", label: "an IBAN", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi, check: ibanOk },
];

/** Every finding in a text: [{ kind, label, start, end, sample, line }], start/end of the secret itself. */
function findAll(text, max = 200) {
  const s = String(text || ""), out = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(s)) && out.length < max) {
      if (m[0] === "") { r.re.lastIndex++; continue; }
      if (r.check && !r.check(m[0])) continue;
      const v = r.value ? m[r.value] : m[0];
      const start = r.value ? m.index + m[0].length - v.length : m.index;
      out.push({ kind: r.kind, label: r.label, key: !!r.key, start, end: start + v.length, value: v });
    }
  }
  // Overlaps (a JWT inside a password line, say): the earlier, longer one is kept.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const f of out) if (!kept.length || f.start >= kept[kept.length - 1].end) kept.push(f);
  return kept;
}

/** What is in a text, for the practitioner to see: masked, each once, at most `max`. */
export function scanText(text, { where = "your message", max = 20 } = {}) {
  const seen = new Set(), out = [];
  const s = String(text || "");
  for (const f of findAll(s)) {
    const k = f.kind + ":" + f.value;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: f.kind, label: f.label, sample: f.kind === "private-key" ? "-----BEGIN … PRIVATE KEY-----" : mask(f.value), where, line: s.slice(0, f.start).split("\n").length });
    if (out.length >= max) break;
  }
  return out;
}

const marker = f => `[${f.label.replace(/^an? /, "")}, left out]`;

/** The text with every finding replaced by a short marker. `keysOnly`: keys and private keys only (what is never stored). */
export function leaveOut(text, { keysOnly = false } = {}) {
  const s = String(text ?? "");
  let out = "", at = 0;
  for (const f of findAll(s, 10000)) {
    if (keysOnly && !f.key) continue;
    out += s.slice(at, f.start) + marker(f); at = f.end;
  }
  return out + s.slice(at);
}

/** What is stored, synced and exported: never a key. */
export const redact = text => leaveOut(text, { keysOnly: true });

/**
 * The findings in a message about to leave: its words, then each attachment's
 * text (the files inside an archive are in its text already).
 */
export function scanMessage(text, files = []) {
  const found = scanText(text, { where: "your message" });
  for (const f of files) if (f?.text) found.push(...scanText(f.text, { where: f.name, max: 20 }));
  return found;
}

/** The message and its attachments with every finding left out. */
export function leaveOutMessage(text, files = []) {
  return { text: leaveOut(text), files: files.map(f => f?.text ? { ...f, text: leaveOut(f.text), note: [f.note, "secrets left out"].filter(Boolean).join("; ") } : f) };
}
