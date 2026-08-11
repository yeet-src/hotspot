// Splits a demangled symbol into colorable spans so the UI can paint the
// function name apart from its namespace path, template arguments,
// parameter list, and compiler suffixes. Pure lexical scanning — it never
// fails on a truncated or otherwise unbalanced name, it just classifies
// what it can see.
//
//   symSpans("std::vec::Vec<u8>::push(u8)") →
//     [{ text: "std::vec::Vec<u8>::", kind: "path" },
//      { text: "push", kind: "name" },
//      { text: "(u8)", kind: "args" }]
//
// Kinds: path, name, tpl (template args), args (parameter list + cv
// qualifiers), extra (rust hash, .isra.0-style suffixes), and for Rust
// symbols additionally punct (::, <>, &, ...), type (CamelCase idents),
// kw (as/dyn/impl/...), prim (u64/str/...), closure ({{closure}}).

const RUST_KW = new Set(["as", "dyn", "impl", "for", "mut", "const", "fn", "unsafe", "extern", "where"]);
const RUST_PRIM = new Set([
  "bool", "char", "str",
  "u8", "u16", "u32", "u64", "u128", "usize",
  "i8", "i16", "i32", "i64", "i128", "isize",
  "f32", "f64",
]);

/* Rust demangled names have no parameter list, so a pathful symbol
 * without parens is Rust; the hash disambiguator, {{closure}} frames,
 * and `<Type as Trait>` qualified paths are unambiguous on their own.
 * Data-ish C++ names ("vtable for ...") can slip through, but samples
 * land in functions, and the Rust scanner degrades fine on C++ tokens.
 */
function isRust(sym) {
  if (/::h[0-9a-f]{16}$/.test(sym)) return true;
  if (sym.includes("{{closure}}")) return true;
  if (/^<.+ as .+>/.test(sym)) return true;
  return sym.includes("::") && !sym.includes("(");
}

function rustSpans(sym) {
  /* Locate the trailing hash and the function-name ident (the segment
   * after the last `::` outside angle brackets) up front; the scan
   * below classifies every other token by shape alone.
   */
  let head = sym;
  let hashStart = -1;
  const h = head.match(/::h[0-9a-f]{16}$/);
  if (h) {
    hashStart = h.index + 2;
    head = sym.slice(0, h.index);
  }
  let angle = 0;
  let split = -1;
  for (let i = 0; i < head.length - 1; i++) {
    const c = head[i];
    if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (angle === 0 && c === ":" && head[i + 1] === ":") {
      split = i;
      i++;
    }
  }
  const nameStart = split >= 0 ? split + 2 : 0;

  const spans = [];
  const push = (text, kind) => {
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text += text;
    else spans.push({ text, kind });
  };
  const re = /\{\{closure\}\}|[A-Za-z_][A-Za-z0-9_]*|[0-9][A-Za-z0-9_]*|::|./g;
  let m;
  while ((m = re.exec(sym))) {
    const t = m[0];
    if (t === "{{closure}}") push(t, "closure");
    else if (/^[A-Za-z_]/.test(t)) {
      if (m.index === hashStart) push(t, "extra");
      else if (m.index === nameStart) push(t, "name");
      else if (RUST_KW.has(t)) push(t, "kw");
      else if (RUST_PRIM.has(t)) push(t, "prim");
      else if (/^[A-Z]/.test(t)) push(t, "type");
      else push(t, "path");
    } else if (/^[0-9]/.test(t)) push(t, "prim");
    else push(t, "punct");
  }
  return spans;
}

export function symSpans(sym) {
  if (!sym) return [];
  if (isRust(sym)) return rustSpans(sym);

  /* Find the parameter list: the first `(` outside template brackets.
   * `operator()` and `(anonymous namespace)` also open parens, so the
   * `(` must follow an identifier-ish char and not the word `operator`.
   */
  let angle = 0;
  let paren = -1;
  for (let i = 0; i < sym.length; i++) {
    const c = sym[i];
    if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(" && angle === 0 && i > 0 && /[\w>)\]]/.test(sym[i - 1]) && !sym.slice(0, i).endsWith("operator")) {
      paren = i;
      break;
    }
  }
  let head = paren >= 0 ? sym.slice(0, paren) : sym;
  const tail = paren >= 0 ? sym.slice(paren) : "";

  // Rust legacy-mangling disambiguator, e.g. `::h1a2b3c4d5e6f7a8b`.
  let hash = "";
  const h = head.match(/::h[0-9a-f]{16}$/);
  if (h) {
    hash = h[0];
    head = head.slice(0, -hash.length);
  }

  // Path/name split at the last `::` outside template brackets.
  angle = 0;
  let split = -1;
  for (let i = 0; i < head.length - 1; i++) {
    const c = head[i];
    if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (angle === 0 && c === ":" && head[i + 1] === ":") {
      split = i;
      i++;
    }
  }
  const path = split >= 0 ? head.slice(0, split + 2) : "";
  let name = split >= 0 ? head.slice(split + 2) : head;

  // Template arguments on the function itself (`get<0ul>`); `operator<`
  // and friends keep their brackets as part of the name.
  let tpl = "";
  if (!name.startsWith("operator")) {
    const lt = name.indexOf("<");
    if (lt > 0) {
      tpl = name.slice(lt);
      name = name.slice(0, lt);
    }
  }

  // Compiler-cloned C symbols: `memcpy.isra.0`, `__schedule.cold`.
  let csuf = "";
  if (!path && !tpl && !tail) {
    const dot = name.indexOf(".");
    if (dot > 0) {
      csuf = name.slice(dot);
      name = name.slice(0, dot);
    }
  }

  const spans = [];
  if (path) spans.push({ text: path, kind: "path" });
  if (name) spans.push({ text: name, kind: "name" });
  if (tpl) spans.push({ text: tpl, kind: "tpl" });
  if (csuf) spans.push({ text: csuf, kind: "extra" });
  if (hash) spans.push({ text: hash, kind: "extra" });
  if (tail) spans.push({ text: tail, kind: "args" });
  return spans;
}
