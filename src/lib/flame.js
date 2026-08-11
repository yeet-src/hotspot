/* Icicle flamegraph model (eprofiler-tui style): fold leaf-first
 * sampled stacks into a root-first trie, lay the trie out over the
 * terminal columns, and colour frames flamegraph-style — a warm ramp
 * for user code picked by name hash, the purple family for kernel
 * frames, faint for still-symbolizing ones.
 */
import { rgb } from "yeet:tui";

const PENDING = [105, 110, 125];

/* Frame colours sample a designed gradient — crimson → ember → orange
 * → gold for user code, indigo → violet → lavender for the kernel —
 * at a position keyed by a Knuth-remixed name hash (djb2 alone
 * clusters similar short names), with a five-step brightness jitter
 * so names that land near each other on the ramp still show a
 * boundary. Same function, same colour, everywhere.
 */
const WARM_STOPS = [
  [186, 38, 50],
  [232, 92, 42],
  [248, 150, 46],
  [255, 208, 74],
];
const KERN_STOPS = [
  [88, 66, 188],
  [148, 110, 230],
  [198, 158, 252],
];

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h;
};

const ramp = (stops, t) => {
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return stops[i].map((v, k) => v + (stops[i + 1][k] - v) * f);
};

function channels(node) {
  if (node.pending || node.name === "??") return PENDING;
  const h = Math.imul(hash(node.name), 2654435761) >>> 0;
  const t = (h % 1024) / 1023;
  const glow = 0.86 + ((h >>> 12) % 5) * 0.06;
  const [r, g, b] = ramp(node.kernel ? KERN_STOPS : WARM_STOPS, t).map((v) =>
    Math.min(255, Math.round(v * glow)),
  );
  // An independent green wiggle separates names that hash to nearby
  // ramp positions — same-t neighbours were fusing into one slab.
  const wiggle = (((h >>> 20) % 5) - 2) * 9;
  return [r, Math.max(0, Math.min(255, g + wiggle)), b];
}

export function frameColor(node) {
  const [r, g, b] = channels(node);
  return rgb(r, g, b);
}

// Label ink flips with the block's luminance: parchment on the dark
// end of the ramp, near-black on the bright end.
export function frameInk(node) {
  const [r, g, b] = channels(node);
  return 0.299 * r + 0.587 * g + 0.114 * b > 120 ? rgb(38, 24, 12) : rgb(255, 236, 214);
}

/* Fold `stacks` — { frames: leaf-first BigInt[], count } by stack — into
 * a root-first trie of { name, obj, kernel, pending, loc, count, kids }.
 * Frames merge by resolved symbol (not address), so every call site of
 * a function folds into one box per branch, flamegraph-style.
 * `resolve` is the flat view's resolver: synchronous against its cache,
 * queueing unknown pcs for the next symbolize batch.
 */
export function foldStacks(stacks, resolve) {
  const root = { name: "all", obj: "", kernel: false, pending: false, loc: null, count: 0, kids: new Map() };
  for (const { frames, count } of stacks.values()) {
    root.count += count;
    let node = root;
    for (let i = frames.length - 1; i >= 0; i--) {
      const r = resolve(frames[i]);
      const key = `${r.label}@${r.obj}`;
      let kid = node.kids.get(key);
      if (!kid) {
        kid = { name: r.label, obj: r.obj, kernel: r.kernel, pending: r.pending, loc: r.loc ?? null, count: 0, kids: new Map() };
        node.kids.set(key, kid);
      }
      kid.count += count;
      node = kid;
    }
  }
  return root;
}

/* The heaviest stack of one time bucket, resolved root-first for the
 * stream view: [{ name, obj, kernel, pending, loc }] — [] for an idle
 * bucket, so gaps in the timeline are real time.
 */
export function dominantStack(bucket, resolve) {
  let top = null;
  for (const s of bucket.values()) if (!top || s.count > top.count) top = s;
  if (!top) return [];
  const out = [];
  for (let i = top.frames.length - 1; i >= 0; i--) {
    const r = resolve(top.frames[i]);
    out.push({ name: r.label, obj: r.obj, kernel: r.kernel, pending: r.pending, loc: r.loc ?? null });
  }
  return out;
}

// The node a kid-key path leads to, or null once the path dangles
// (a live rebuild can drop a branch).
export function nodeAt(root, path) {
  let node = root;
  for (const key of path) {
    node = node?.kids.get(key);
    if (!node) return null;
  }
  return node;
}

/* Lay the trie out over `cols` columns: rows[depth] is the depth's
 * segments `{ node, x, w, path }`, kids hot-first, each sized by its
 * share of the parent's count with cumulative rounding (so widths sum
 * exactly and sub-column frames drop, classic flamegraph). Self time
 * shows as the unfilled right gap under a parent.
 */
export function layoutFlame(root, cols) {
  const rows = [];
  const walk = (node, depth, x, w, path) => {
    (rows[depth] ??= []).push({ node, x, w, path });
    const kids = [...node.kids.entries()].sort((a, b) => b[1].count - a[1].count);
    let cum = 0;
    let cursor = x;
    for (const [key, kid] of kids) {
      cum += kid.count;
      const end = x + Math.round((cum / node.count) * w);
      if (end > cursor) walk(kid, depth + 1, cursor, end - cursor, [...path, key]);
      cursor = Math.max(cursor, end);
    }
  };
  if (root && root.count > 0) walk(root, 0, 0, cols, []);
  return rows;
}
