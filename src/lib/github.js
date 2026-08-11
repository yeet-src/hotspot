// GitHub links for profile rows. The repo/rev/strip triple comes from
// yeet.args (`--repo org/repo --rev <sha|branch> --strip /build/root/`):
// DWARF records where the binary was *built* — the comp dir plus the
// path the compiler was invoked with — so `strip` bridges build tree →
// repo tree. A relatively-recorded path (a repo-root build, the common
// gcc/cargo case) needs no strip at all.

export function repoConfig(args) {
  if (!args?.repo) return null;
  const repo = String(args.repo);
  const base = repo.startsWith("http") ? repo.replace(/\/+$/, "") : `https://github.com/${repo}`;
  return {
    base,
    rev: args.rev ? String(args.rev) : "main",
    strip: args.strip ? String(args.strip) : null,
  };
}

// The blob URL for a `{dir, file, line}` source location, or null when
// the recorded path can't be made repo-relative (absolute path, no
// matching strip prefix).
export function urlFor(cfg, loc) {
  if (!cfg || !loc?.file) return null;
  const joined = loc.file.startsWith("/") || !loc.dir ? loc.file : `${loc.dir}/${loc.file}`;
  let rel = null;
  if (cfg.strip && joined.startsWith(cfg.strip)) rel = joined.slice(cfg.strip.length);
  else if (!loc.file.startsWith("/")) rel = loc.file;
  if (!rel) return null;
  rel = rel.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  return `${cfg.base}/blob/${cfg.rev}/${rel}${loc.line ? `#L${loc.line}` : ""}`;
}

// OSC 52: copy `text` to the system clipboard through the terminal.
// Hand-rolled base64 — this V8 has no btoa.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64(s) {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < s.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < s.length ? B64[n & 63] : "=";
  }
  return out;
}

export const osc52 = (text) => `\x1b]52;c;${b64(text)}\x07`;
