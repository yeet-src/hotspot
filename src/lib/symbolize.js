// Sampled-PC symbolizer. Kernel PCs (sign bit set) resolve through the
// running kernel's kallsyms via Inspector.kernel(); user PCs resolve
// through the live process with Inspector.process(pid), which routes each
// address through the process maps daemon-side — ASLR, deleted binaries,
// the vDSO and perf-map JIT symbols are all handled there. Addresses cross
// the wire as BigInt so kernel PCs (> 2^53) never lose low bits.
//
// `resolve(ip)` is synchronous against a cache; unknown ips come back as a
// pending ?? row and are queued. `flush()` ships the queue as one
// symbolizeMany batch per side. The exec segments are only used to label
// user rows with the object they landed in.
import { Inspector } from "yeet:sym";

const KERNEL_BIT = 1n << 63n;
const BATCH = 512;

export function createResolver(pid, segments) {
  const segs = segments.slice().sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const cache = new Map(); // ip (BigInt) -> row
  const wanted = { kernel: new Set(), user: new Set() };
  const busy = { kernel: false, user: false };
  const insp = { kernel: null, user: null };
  let lastErr = null;

  function objOf(ip) {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid];
      if (ip < s.start) hi = mid - 1;
      else if (ip >= s.end) lo = mid + 1;
      else return s.path.slice(s.path.lastIndexOf("/") + 1);
    }
    return "[anon]";
  }

  // file:line as DWARF recorded it, basename only — the comp-dir prefix
  // is build-machine noise at display width. `loc` keeps the full
  // coordinates (comp dir, recorded path, line) for building links.
  function srcOf(f) {
    if (!f?.file) return null;
    const base = f.file.slice(f.file.lastIndexOf("/") + 1);
    return f.line ? `${base}:${f.line}` : base;
  }

  function locOf(f) {
    if (!f?.file) return null;
    return { dir: f.dir ?? null, file: f.file, line: f.line ?? null };
  }

  // Resolve one pc to an aggregation row. Never blocks: an unknown pc is
  // queued for the next flush and files under its object's ?? bucket
  // until the batch lands.
  function resolve(ip) {
    const hit = cache.get(ip);
    if (hit) return hit;
    const kernel = (ip & KERNEL_BIT) !== 0n;
    const obj = kernel ? "kernel" : objOf(ip);
    wanted[kernel ? "kernel" : "user"].add(ip);
    return { key: `??@${obj}`, label: "??", obj, kernel, pending: true, src: null, loc: null };
  }

  async function open(side) {
    if (!insp[side]) {
      // debugSyms reaches past .dynsym into each object's debug info
      // (build-id debug files included), which is what names non-exported
      // internals — e.g. glibc's _int_malloc on a stripped distro libc.
      insp[side] = side === "kernel" ? await Inspector.kernel() : await Inspector.process(pid, { debugSyms: true });
    }
    return insp[side];
  }

  async function flushSide(side) {
    if (busy[side] || !wanted[side].size) return;
    busy[side] = true;
    const ips = [...wanted[side]].slice(0, BATCH);
    try {
      const frames = await (await open(side)).symbolizeMany(ips);
      for (let i = 0; i < ips.length; i++) {
        const ip = ips[i];
        let f = frames[i];
        // ARM/AArch64 mapping symbols ($x code, $d data, $t thumb) are ELF
        // ABI markers, not functions — a debug symtab can offer one as the
        // containing "symbol"; show ?? instead.
        if (f && /^\$[axtd](\.|$)/.test(f.name)) f = null;
        const kernel = side === "kernel";
        const obj = kernel ? "kernel" : objOf(ip);
        wanted[side].delete(ip);
        cache.set(
          ip,
          f
            ? { key: `${f.name}@${obj}`, label: f.demangled ?? f.name, obj, kernel, pending: false, src: srcOf(f), loc: locOf(f) }
            : { key: `??@${obj}`, label: "??", obj, kernel, pending: false, src: null, loc: null },
        );
      }
      lastErr = null;
    } catch (e) {
      // Park this batch as unresolved rather than retrying forever.
      lastErr = String(e?.message ?? e);
      for (const ip of ips) {
        wanted[side].delete(ip);
        const kernel = side === "kernel";
        const obj = kernel ? "kernel" : objOf(ip);
        cache.set(ip, { key: `??@${obj}`, label: "??", obj, kernel, pending: false, src: null, loc: null });
      }
    } finally {
      busy[side] = false;
    }
  }

  function flush() {
    flushSide("kernel");
    flushSide("user");
  }

  function stats() {
    return { cached: cache.size, queued: wanted.kernel.size + wanted.user.size, err: lastErr };
  }

  async function close() {
    for (const side of ["kernel", "user"]) {
      const i = insp[side];
      insp[side] = null;
      if (i) await i.close().catch(() => {});
    }
  }

  return { resolve, flush, stats, close };
}
