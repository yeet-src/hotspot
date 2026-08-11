/* hotspot — a point-and-click CPU profiler over yeet:bpf + yeet:sym.
 *
 *   yeet run examples/hotspot --tty
 *
 * The left of the flow is a live process table (sys_graph procs); click a
 * row (or ↑↓ + ⏎) to open it. Opening a process arms a perf-event stack
 * sampler scoped to that process (cgroup + in-kernel pid filter) and the
 * pane becomes a live flat profile: each sample's interrupted PC — kernel
 * or user — is symbolized with the yeet:sym Inspector (kallsyms for
 * kernel PCs, the live process maps for user PCs) and folded into a
 * self-time table — % share, heat bar, function, object. Kernel rows are
 * tinted and labeled `kernel`. Click again / esc / right-click goes back;
 * q quits.
 */

import { Box, Layer, Size, Text, from, mount, rgb, rgba, signal } from "yeet:tui";

import { dominantStack, foldStacks, frameColor, frameInk, layoutFlame, nodeAt } from "@/lib/flame.js";
import { osc52, repoConfig, urlFor } from "@/lib/github.js";
import { createResolver } from "@/lib/symbolize.js";
import { symSpans } from "@/lib/symhl.js";
import { PUBLISH_MS, attachProfile } from "@/probes/profile.js";

/* --- palette --- */

const HEAD = rgb(120, 220, 255);
const SEL_BG = rgb(38, 66, 104);
const SEL_FG = rgb(255, 255, 255);
const FAINT = rgb(110, 120, 145);
const PID_C = rgb(150, 165, 200);
const COMM_C = rgb(235, 205, 130);
const PATH_C = rgb(150, 210, 255);
const ERR_C = rgb(235, 160, 160);
const HOT_HI = rgb(255, 105, 90);
const HOT_MID = rgb(240, 190, 90);
const HOT_LO = rgb(140, 205, 130);
const KERN_C = rgb(200, 160, 245); // kernel-side rows

// Symbol highlighting, skittles theme: identifier spans taste the
// rainbow left to right; structural punctuation and suffixes stay
// faint so the candy reads as separate pieces.
const SKITTLES = [
  rgb(235, 70, 80), // red
  rgb(255, 150, 45), // orange
  rgb(250, 205, 60), // yellow
  rgb(125, 205, 80), // green
  rgb(90, 165, 255), // blue (tropical pack)
  rgb(180, 110, 235), // purple
];
const SYM_FAINT = new Set(["punct", "args", "extra", "closure"]);

const heat = (share) => (share > 0.66 ? HOT_HI : share > 0.25 ? HOT_MID : HOT_LO);

/* --- state --- */

const view = signal("procs"); // "procs" | "profile"

const procs = signal([]); // { pid, comm, exe }
const procLoading = signal(true);
const procErr = signal(null);
const procCur = signal(0);
const procTop = signal(0);

const target = signal(null); // { pid, comm, exe }
const profErr = signal(null);
const profRows = signal([]); // { key, label, obj, count, share, pending }
const profTotal = signal(0);
const profStatus = signal("");
const symStatus = signal("");
const profCur = signal(0);
const profTop = signal(0);
const spin = signal(0);
const flash = signal(""); // transient header note (e.g. "link copied")

const profMode = signal("flat"); // profile pane: "flat" table, "flame" icicle, or "stream" timeline
const flameRoot = signal(null); // folded stack trie, rebuilt per publish tick
const flameSel = signal([]); // selected frame: kid-key path from the zoom root
const flameZoom = signal([]); // zoom root: kid-key path from the trie root
const flameFrozen = signal(false); // pauses the flame refold and the stream scroll
const streamCols = signal([]); // one resolved dominant stack per publish window, oldest first
const flameHover = signal(null); // { x, y } terminal cell under the cursor in flame mode, or null

// The live sampling session — plain object, not a signal: the profiler and
// resolver are machinery, only their outputs above drive renders.
let session = null;

const screen = from((state) => {
  const fire = () => state.set(tty.size());
  tty.on("resize", fire);
  return () => tty.off("resize", fire);
}, tty.size());

/* --- helpers --- */

const trunc = (s, w) => {
  s = String(s ?? "");
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s;
};
// The renderer trims trailing spaces, so pad selected rows to span the row.
// Pad with NBSP: the renderer trims trailing *spaces*, so a bg-styled
// fill needs cells that survive to the edge.
const fill = (s, w) => (s.length >= w ? s : s + " ".repeat(w - s.length));
// No ICU, so no toLocaleString — group thousands by hand.
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function visibleRows(reserve) {
  return Math.max(1, screen.get().rows - reserve);
}
function clampScroll(idx, curTop, len, vis) {
  let t = curTop;
  if (idx < t) t = idx;
  if (idx >= t + vis) t = idx - vis + 1;
  return Math.max(0, Math.min(t, Math.max(0, len - vis)));
}

/* --- process list --- */

async function loadProcs() {
  procLoading.set(true);
  procErr.set(null);
  try {
    const { data } = await yeet.graph.query(`{ procs { pid exe stat { comm } } }`);
    const list = (data?.procs ?? [])
      .filter((p) => p.exe) // kernel threads have no exe (and no user stacks)
      .map((p) => ({ pid: p.pid, comm: p.stat?.comm ?? "?", exe: p.exe }))
      .sort((a, b) => (a.comm < b.comm ? -1 : a.comm > b.comm ? 1 : a.pid - b.pid));
    procs.set(list);
    procCur.set(Math.min(procCur.get(), Math.max(0, list.length - 1)));
  } catch (e) {
    procErr.set(String(e?.message ?? e));
  } finally {
    procLoading.set(false);
  }
}

/* --- profiling session --- */

const timeout = (ms, what) =>
  new Promise((_res, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms));

async function openProc(i) {
  const p = procs.get()[i];
  if (!p) return;
  await stopSession();
  target.set(p);
  view.set("profile");
  profErr.set(null);
  profRows.set([]);
  profTotal.set(0);
  profStatus.set("reading maps…");
  symStatus.set("");
  profCur.set(0);
  profTop.set(0);
  flameRoot.set(null);
  flameSel.set([]);
  flameZoom.set([]);
  flameFrozen.set(false);
  streamCols.set([]);
  flameHover.set(null);

  // The process's executable segments, only to label user rows with the
  // object each pc landed in (symbolization itself is daemon-side). Race
  // the maps query against a timeout — a pathological process can wedge
  // the daemon — and degrade to unlabeled rows if it fails.
  let segments = [];
  try {
    const q = yeet.graph
      .query(`{ proc(pid: ${p.pid}) { maps { path start end perms { execute } } } }`)
      .then((r) => r.data);
    const data = await Promise.race([q, timeout(4000, "maps query")]);
    segments = (data?.proc?.maps ?? [])
      .filter((m) => m.path && m.path.startsWith("/") && m.perms?.execute)
      // start/end are 0x-hex strings; keep them as BigInt like the pcs.
      .map((m) => ({ path: m.path, start: BigInt(m.start), end: BigInt(m.end) }));
  } catch {}
  // A late back-out: the user may have left while the query ran.
  if (target.get()?.pid !== p.pid || view.get() !== "profile") return;

  const resolver = createResolver(p.pid, segments);
  const prof = attachProfile({ pid: p.pid, freq: Number(yeet.args.freq) || undefined });
  const timer = setInterval(() => {
    spin.update((n) => n + 1);
    profStatus.set(prof.status.get());
    profTotal.set(prof.total.get());

    // Fold sampled-pc counts into per-function rows through the resolver.
    // A row's src is the file:line of its hottest pc — the hottest line
    // inside the function, not the declaration.
    const agg = new Map();
    for (const [ip, count] of prof.hot.get()) {
      const r = resolver.resolve(ip);
      const row = agg.get(r.key);
      if (row) {
        row.count += count;
        row.pending = row.pending || r.pending;
        if (r.src && count > row.srcHot) {
          row.srcHot = count;
          row.src = r.src;
          row.loc = r.loc;
        }
      } else {
        agg.set(r.key, {
          key: r.key,
          label: r.label,
          obj: r.obj,
          kernel: r.kernel,
          count,
          pending: r.pending,
          src: r.src ?? null,
          loc: r.loc ?? null,
          srcHot: r.src ? count : 0,
        });
      }
    }
    const total = prof.total.get();
    const rows = [...agg.values()].sort((a, b) => b.count - a.count);
    for (const r of rows) r.share = total ? r.count / total : 0;
    profRows.set(rows);

    // Flame mode refolds the stack trie, stream mode re-derives its
    // timeline columns, each tick unless frozen; both resolve every
    // frame they touch, queueing unknown pcs for the flush.
    if (!flameFrozen.get()) {
      if (profMode.get() === "flame") {
        flameRoot.set(foldStacks(prof.stacks.get(), resolver.resolve));
      } else if (profMode.get() === "stream") {
        streamCols.set(prof.history.get().map((bucket) => dominantStack(bucket, resolver.resolve)));
      }
    }
    resolver.flush();

    const s = resolver.stats();
    symStatus.set(s.err ? `sym: ${s.err}` : s.queued ? `symbolizing ${s.queued} pcs…` : `${s.cached} pcs symbolized`);
  }, 500);
  session = { prof, resolver, timer };
}

async function stopSession() {
  const s = session;
  session = null;
  if (!s) return;
  clearInterval(s.timer);
  await s.prof.stop();
  await s.resolver.close();
}

function closeProfile() {
  stopSession();
  target.set(null);
  view.set("procs");
}

// GitHub linking, on when `--repo` is passed (`--rev`/`--strip` refine it).
const GH = repoConfig(yeet.args);

let flashTimer = null;
function note(s) {
  flash.set(s);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flash.set(""), 2500);
}

// The zoom root the flame view is currently showing, or null pre-data.
function flameZoomed() {
  const root = flameRoot.get();
  return root ? (nodeAt(root, flameZoom.get()) ?? root) : null;
}

// Copy the selection's GitHub link through the terminal clipboard
// (OSC 52 — the terminal must honor it; the symbol's own hyperlink is
// the cmd-click fallback). The flash makes a swallowed copy visible.
function copyLink() {
  const loc =
    profMode.get() === "flame"
      ? (nodeAt(flameZoomed() ?? { kids: new Map() }, flameSel.get())?.loc ?? null)
      : (profRows.get()[profCur.get()]?.loc ?? null);
  const link = GH && loc ? urlFor(GH, loc) : null;
  if (!link) return note(GH ? "no source here" : "run with --repo to link");
  tty.write(osc52(link));
  note("link copied");
}

// Move the flame selection across the current layout: h/l walk
// siblings, j descends into the hottest overlapping child, k climbs to
// the parent.
function flameNav(dir) {
  const zoomed = flameZoomed();
  if (!zoomed) return;
  const lay = layoutFlame(zoomed, screen.get().cols);
  const path = flameSel.get();
  if (dir === "up") return void flameSel.set(path.slice(0, -1));
  const segs = lay[path.length] ?? [];
  const idx = segs.findIndex((s) => s.path.length === path.length && s.path.every((k, i) => k === path[i]));
  const cur = segs[idx];
  if (!cur) return void flameSel.set([]);
  if (dir === "left" && idx > 0) flameSel.set(segs[idx - 1].path);
  else if (dir === "right" && idx < segs.length - 1) flameSel.set(segs[idx + 1].path);
  else if (dir === "down") {
    const below = (lay[path.length + 1] ?? []).filter((s) => s.x < cur.x + cur.w && s.x + s.w > cur.x);
    if (below.length) flameSel.set(below.sort((a, b) => b.w - a.w)[0].path);
  }
}

/* --- input --- */

const isUp = (c) => c === "ArrowUp" || c === "Up" || c === "k";
const isDown = (c) => c === "ArrowDown" || c === "Down" || c === "j";
const isRight = (c) => c === "ArrowRight" || c === "Right" || c === "l";
const isLeft = (c) => c === "ArrowLeft" || c === "Left" || c === "h";
const isEnter = (c) => c === "Enter" || c === "Return" || c === "\r";

// Rows above the scrolled list: procs has its header; profile has a header
// plus the status/column line.
const PROC_LIST_Y = 1;
const PROF_LIST_Y = 2;
// The profile list also reserves its bottom legend row.
const PROF_RESERVE = PROF_LIST_Y + 1;

function moveProc(delta) {
  const len = procs.get().length;
  if (!len) return;
  const i = Math.max(0, Math.min(len - 1, procCur.get() + delta));
  procCur.set(i);
  procTop.set(clampScroll(i, procTop.get(), len, visibleRows(PROC_LIST_Y)));
}
function moveProf(delta) {
  const len = profRows.get().length;
  if (!len) return;
  const i = Math.max(0, Math.min(len - 1, profCur.get() + delta));
  profCur.set(i);
  profTop.set(clampScroll(i, profTop.get(), len, visibleRows(PROF_RESERVE)));
}

function quit() {
  stopSession();
  setTimeout(() => yeet.exit(), 0);
}

tty.on("keydown", (e) => {
  const c = e.code;
  if ((e.ctrlKey && c === "c") || c === "q") return quit();

  if (view.get() === "procs") {
    if (isUp(c)) moveProc(-1);
    else if (isDown(c)) moveProc(1);
    else if (c === "PageUp") moveProc(-visibleRows(PROC_LIST_Y));
    else if (c === "PageDown") moveProc(visibleRows(PROC_LIST_Y));
    else if (c === "g") moveProc(-1e9);
    else if (c === "G") moveProc(1e9);
    else if (c === "r") loadProcs();
    else if (isRight(c) || isEnter(c)) openProc(procCur.get());
    return;
  }

  if (profMode.get() === "stream") {
    if (c === "t" || c === "Escape" || c === "Esc" || isLeft(c)) profMode.set("flat");
    else if (c === "f") profMode.set("flame");
    else if (c === " ") flameFrozen.update((v) => !v);
    return;
  }
  if (profMode.get() === "flame") {
    if (c === "f") profMode.set("flat");
    else if (c === "t") profMode.set("stream");
    else if (c === " ") flameFrozen.update((v) => !v);
    else if (c === "r") {
      flameSel.set([]);
      flameZoom.set([]);
    } else if (isEnter(c)) {
      // Zoom to the selection; the path rebases onto the new root.
      if (flameSel.get().length) {
        flameZoom.set([...flameZoom.get(), ...flameSel.get()]);
        flameSel.set([]);
      }
    } else if (c === "Escape" || c === "Esc") {
      if (flameZoom.get().length) flameZoom.set([]);
      else profMode.set("flat");
    } else if (isUp(c)) flameNav("up");
    else if (isDown(c)) flameNav("down");
    else if (isLeft(c)) flameNav("left");
    else if (isRight(c)) flameNav("right");
    else if (c === "o") copyLink();
    return;
  }
  if (isLeft(c) || c === "Escape" || c === "Esc") closeProfile();
  else if (isUp(c)) moveProf(-1);
  else if (isDown(c)) moveProf(1);
  else if (c === "PageUp") moveProf(-visibleRows(PROF_RESERVE));
  else if (c === "PageDown") moveProf(visibleRows(PROF_RESERVE));
  else if (c === "g") moveProf(-1e9);
  else if (c === "G") moveProf(1e9);
  else if (c === "f") profMode.set("flame");
  else if (c === "t") profMode.set("stream");
  else if (c === "o") copyLink();
});

// Point and click: left-click selects the row under the pointer, a second
// click on the selected process opens its profile, right-click backs out.
tty.on("mousedown", (e) => {
  if (e.button === 2) {
    if (view.get() === "profile") closeProfile();
    return;
  }
  if (e.button !== 0) return;
  if (view.get() === "procs") {
    const i = procTop.get() + e.clientY - PROC_LIST_Y;
    if (e.clientY < PROC_LIST_Y || i >= procs.get().length) return;
    if (i === procCur.get()) openProc(i);
    else {
      procCur.set(i);
      procTop.set(clampScroll(i, procTop.get(), procs.get().length, visibleRows(PROC_LIST_Y)));
    }
  } else if (profMode.get() === "flame") {
    const zoomed = flameZoomed();
    const d = e.clientY - FLAME_LIST_Y;
    if (!zoomed || d < 0) return;
    const seg = (layoutFlame(zoomed, screen.get().cols)[d] ?? []).find(
      (s) => e.clientX >= s.x && e.clientX < s.x + s.w,
    );
    if (seg) flameSel.set(seg.path);
  } else {
    const i = profTop.get() + e.clientY - PROF_LIST_Y;
    // Clicks below the list (the legend row) select nothing.
    if (e.clientY < PROF_LIST_Y || e.clientY - PROF_LIST_Y >= visibleRows(PROF_RESERVE)) return;
    if (i >= profRows.get().length) return;
    profCur.set(i);
    profTop.set(clampScroll(i, profTop.get(), profRows.get().length, visibleRows(PROF_RESERVE)));
  }
});

tty.on("wheel", (e) => {
  if (view.get() === "profile" && profMode.get() === "flame") return;
  const move = view.get() === "procs" ? moveProc : moveProf;
  move(e.deltaY > 0 ? 3 : -3);
});

/* --- render --- */

function procsView() {
  const { cols } = screen.get();
  const list = procs.get();

  const out = [
    <Text bold fg={HEAD}>
      {trunc(` hotspot · ${list.length} processes   click/⏎ profile · r refresh · q quit`, cols)}
    </Text>,
  ];

  if (procErr.get()) {
    out.push(<Text fg={ERR_C}>{trunc("  " + procErr.get(), cols)}</Text>);
    return out;
  }
  if (procLoading.get()) {
    out.push(<Text dim>{"  reading the process table…"}</Text>);
    return out;
  }
  if (!list.length) {
    out.push(<Text dim>{"  (no processes)"}</Text>);
    return out;
  }

  const vis = visibleRows(PROC_LIST_Y);
  const t = procTop.get();
  const sel = procCur.get();
  for (let i = t; i < Math.min(list.length, t + vis); i++) {
    const p = list[i];
    const pid = String(p.pid).padStart(7);
    const comm = p.comm.padEnd(16);
    if (i === sel) {
      out.push(
        <Text bg={SEL_BG} fg={SEL_FG}>
          {trunc(fill(` ${pid}  ${comm} ${p.exe}`, cols), cols)}
        </Text>,
      );
    } else {
      out.push(
        <Text>
          <Text fg={PID_C}>{` ${pid}  `}</Text>
          <Text fg={COMM_C}>{`${comm} `}</Text>
          <Text fg={FAINT}>{trunc(p.exe, Math.max(0, cols - 26))}</Text>
        </Text>,
      );
    }
  }
  return out;
}

const BAR_W = 14;
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// Each object (binary, shared library, kernel) gets a stable dot colour
// for the row markers and the legend, assigned in first-seen order.
const OBJ_DOT = new Map();
function objColor(r) {
  if (r.kernel) return KERN_C;
  if (!OBJ_DOT.has(r.obj)) OBJ_DOT.set(r.obj, SKITTLES[OBJ_DOT.size % SKITTLES.length]);
  return OBJ_DOT.get(r.obj);
}

// The function column of an unselected row: syntax-highlighted spans of
// the demangled name, never elided — the row clips at the screen edge.
function symLabel(r) {
  const body = r.label;
  // Symbols paint as OSC 8 hyperlinks when linking is configured, so a
  // ctrl/cmd-click on the function name opens its hottest line.
  const link = (GH && r.loc ? urlFor(GH, r.loc) : null) ?? undefined;
  const out = [];
  if (r.label === "??") {
    out.push(<Text fg={FAINT}>{body}</Text>);
  } else {
    let seg = 0;
    for (const s of symSpans(body)) {
      const fg = SYM_FAINT.has(s.kind) ? FAINT : SKITTLES[seg++ % SKITTLES.length];
      out.push(
        <Text bold={s.kind === "name"} italic={s.kind === "kw" || s.kind === "closure"} fg={fg} link={link}>
          {s.text}
        </Text>,
      );
    }
  }
  if (r.pending) out.push(<Text fg={FAINT}>{` ${SPIN[spin.get() % SPIN.length]}`}</Text>);
  return out;
}

function profileView() {
  const { cols } = screen.get();
  const p = target.get();
  const rows = profRows.get();
  const total = profTotal.get();

  const out = [
    <Text bold fg={HEAD}>
      {trunc(` ${p?.comm ?? "?"} (${p?.pid ?? "?"}) · ${profStatus.get()}   ←/esc back · f flame · t stream${GH ? " · o copy link" : ""} · q quit${flash.get() ? ` · ${flash.get()}` : ""}`, cols)}
    </Text>,
  ];

  if (profErr.get()) {
    out.push(<Text fg={ERR_C}>{trunc("  " + profErr.get(), cols)}</Text>);
    return out;
  }

  const sym = symStatus.get();
  out.push(
    <Text>
      <Text fg={FAINT}>{`   %    ${"".padEnd(BAR_W)} samples  ● function`}</Text>
      <Text fg={PATH_C}>
        {trunc(`   · ${commas(total)} samples${sym ? ` · ${sym}` : ""}`, Math.max(0, cols - 44 - BAR_W))}
      </Text>
    </Text>,
  );

  if (!rows.length) {
    const frame = SPIN[spin.get() % SPIN.length];
    out.push(<Text dim>{`  ${frame} collecting samples… (is the process on-CPU?)`}</Text>);
    return out;
  }

  const vis = visibleRows(PROF_RESERVE);
  const t = profTop.get();
  const sel = profCur.get();
  const peak = rows[0]?.share || 1;
  const shown = rows.slice(t, Math.min(rows.length, t + vis));

  // Symbols come last, unelided, clipped only by the screen edge
  // (`break="none"`); the object rides the dot, keyed at the bottom.
  for (let i = t; i < Math.min(rows.length, t + vis); i++) {
    const r = rows[i];
    const pct = (r.share * 100).toFixed(1).padStart(5);
    const bar = "█".repeat(Math.max(r.count ? 1 : 0, Math.round((r.share / peak) * BAR_W))).padEnd(BAR_W);
    const count = commas(r.count).padStart(8);
    const link = (GH && r.loc ? urlFor(GH, r.loc) : null) ?? undefined;
    if (i === sel) {
      const head = ` ${pct}% ${bar}${count}  `;
      const label = r.pending ? `${r.label} ${SPIN[spin.get() % SPIN.length]}` : r.label;
      const used = head.length + 2 + label.length;
      out.push(
        <Text break="none" bg={SEL_BG} fg={SEL_FG}>
          {head}
          <Text fg={objColor(r)}>{"● "}</Text>
          <Text link={link}>{label}</Text>
          {" ".repeat(Math.max(0, cols - used))}
        </Text>,
      );
    } else {
      out.push(
        <Text break="none">
          <Text bold fg={heat(r.share / peak)}>{` ${pct}% `}</Text>
          <Text fg={heat(r.share / peak)}>{bar}</Text>
          <Text fg={PID_C}>{count}</Text>
          {"  "}
          <Text fg={objColor(r)}>{"● "}</Text>
          {symLabel(r)}
        </Text>,
      );
    }
  }

  // The dot key: every object visible above, in its dot colour.
  const objs = new Map();
  for (const r of shown) if (!objs.has(r.obj)) objs.set(r.obj, r);
  out.push(
    <Text break="none">
      {" "}
      {[...objs.values()].flatMap((r) => [
        <Text fg={objColor(r)}>{"● "}</Text>,
        <Text fg={FAINT}>{`${r.obj}  `}</Text>,
      ])}
    </Text>,
  );
  return out;
}

const FLAME_LIST_Y = 2;

// Fit a frame label to its block: cut hard at the width, no ellipsis.
// NBSP padding — trailing spaces would be trimmed and the block's
// background with them.
const blockText = (s, w) => (s.length > w ? s.slice(0, w) : s + " ".repeat(w - s.length));

/* The icicle flamegraph (eprofiler-tui style): root row on top, each
 * depth a row of proportional blocks in warm colours (purple = kernel),
 * hottest branch leftmost. The line under the header describes the
 * selected frame; blocks carry the same OSC 8 links as the table.
 */
function flameView() {
  const { cols, rows: termRows } = screen.get();
  const p = target.get();
  const frozen = flameFrozen.get();
  const out = [
    <Text bold fg={HEAD}>
      {trunc(
        ` ${p?.comm ?? "?"} (${p?.pid ?? "?"}) · flame${frozen ? " · frozen" : ""} · ${profStatus.get()}   f table · ␣ freeze · ⏎ zoom · esc out · r reset · hover for stats${GH ? " · o copy link" : ""} · q quit${flash.get() ? ` · ${flash.get()}` : ""}`,
        cols,
      )}
    </Text>,
  ];

  const zoomed = flameZoomed();
  if (!zoomed || !zoomed.count) {
    out.push(<Text dim>{`  ${SPIN[spin.get() % SPIN.length]} collecting stacks…`}</Text>);
    return out;
  }

  const lay = layoutFlame(zoomed, cols);
  const selKey = flameSel.get().join("\n");
  const selNode = nodeAt(zoomed, flameSel.get()) ?? zoomed;
  const share = zoomed.count ? selNode.count / zoomed.count : 0;
  out.push(
    <Text break="none">
      <Text fg={FAINT}>{" ▸ "}</Text>
      <Text bold>{selNode.name}</Text>
      <Text fg={PID_C}>{` · ${commas(selNode.count)} samples · ${(share * 100).toFixed(1)}%`}</Text>
      <Text fg={selNode.kernel ? KERN_C : FAINT}>{selNode.obj ? ` · ${selNode.obj}` : ""}</Text>
      <Text fg={FAINT}>{flameZoom.get().length ? " · zoomed" : ""}</Text>
    </Text>,
  );

  const maxDepth = Math.max(1, termRows - FLAME_LIST_Y);
  for (let d = 0; d < Math.min(lay.length, maxDepth); d++) {
    const spans = [];
    let cursor = 0;
    for (const seg of lay[d]) {
      if (seg.x > cursor) spans.push("".padEnd(seg.x - cursor));
      const selected = seg.path.join("\n") === selKey;
      const link = (GH && seg.node.loc ? urlFor(GH, seg.node.loc) : null) ?? undefined;
      spans.push(
        <Text bg={frameColor(seg.node)} fg={frameInk(seg.node)} bold={selected} reverse={selected} link={link}>
          {blockText(seg.w >= 3 ? ` ${seg.node.name}` : "", seg.w)}
        </Text>,
      );
      cursor = seg.x + seg.w;
    }
    out.push(<Text break="none">{spans}</Text>);
  }

  // Overlay the body with a hover tooltip. The Layer's move handler both
  // enables terminal motion reporting and feeds `flameHover`; only the
  // tooltip thunk reads it, so a hover repaints the tip alone, not the
  // graph.
  return (
    <Layer
      width={Size.fr(1)}
      height={Size.fr(1)}
      onMouseMove={(e) => flameHover.set({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => flameHover.set(null)}
    >
      <Box direction="column" width={Size.fr(1)} height={Size.fr(1)}>
        {out}
      </Box>
      {() => flameOverlay()}
    </Layer>
  );
}

const HOVER_WASH = rgba(255, 255, 255, 0.22);

// The segment under the cursor in flame mode — `{ seg, d, zoomed }` —
// or null when the cursor is off a block. Shared by the hover
// highlight and the tooltip so they never disagree.
function flameHoverSeg() {
  const h = flameHover.get();
  const zoomed = flameZoomed();
  if (!h || !zoomed || !zoomed.count) return null;
  const d = h.y - FLAME_LIST_Y;
  if (d < 0) return null;
  const seg = (layoutFlame(zoomed, screen.get().cols)[d] ?? []).find(
    (s) => h.x >= s.x && h.x < s.x + s.w,
  );
  return seg ? { seg, d, zoomed } : null;
}

// Hover chrome, painted over the graph without re-rendering it: a
// translucent wash brightening the block under the cursor, plus the
// stats tooltip beside it.
function flameOverlay() {
  const hit = flameHoverSeg();
  if (!hit) return null;
  const { seg, d, zoomed } = hit;
  return [
    <Box
      left={Size.fixed(seg.x)}
      top={Size.fixed(FLAME_LIST_Y + d)}
      width={Size.fixed(seg.w)}
      height={Size.fixed(1)}
      z={5}
      bg={HOVER_WASH}
    />,
    flameTip(seg, d, zoomed),
  ];
}

const TIP_BG = rgb(20, 22, 30);
const TIP_VAL = rgb(224, 228, 238);
const LBL_W = 9;
const TIP_TRACK = rgb(58, 62, 74); // unfilled portion of a histogram bar
const TIP_SELF = rgb(150, 160, 180); // the "[self]" distribution bar
const TIP_BAR_W = 10;
const TIP_KIDS = 6; // most children shown in the distribution
const BLOCKS = " ▏▎▍▌▋▊▉█"; // eighth-cell fill for sub-column precision

// One "label   value" row of the tooltip. `plain` is the same text
// unstyled, so the caller can size the panel to its widest row.
function tipRow(label, value, valFg = TIP_VAL) {
  const plain = fill(label, LBL_W) + value;
  const node = (
    <Text break="none">
      <Text fg={FAINT}>{fill(label, LBL_W)}</Text>
      <Text fg={valFg}>{value}</Text>
    </Text>
  );
  return { plain, node };
}

// One histogram row: label, an eighth-precision bar of `count / total`
// in `color`, and the share + count. The bar's last cell is a partial
// block so a thin slice still reads as more than empty.
function tipBar(label, count, total, color) {
  const frac = total ? count / total : 0;
  const eighths = Math.round(frac * TIP_BAR_W * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const bar = "█".repeat(full) + (rem ? BLOCKS[rem] : "");
  const track = "░".repeat(Math.max(0, TIP_BAR_W - full - (rem ? 1 : 0)));
  const lbl = fill(trunc(label, 13), 14);
  const val = ` ${String(Math.round(frac * 100)).padStart(3)}% ${commas(count)}`;
  const plain = lbl + bar + track + val;
  const node = (
    <Text break="none">
      <Text fg={FAINT}>{lbl}</Text>
      <Text fg={color}>{bar}</Text>
      <Text fg={TIP_TRACK}>{track}</Text>
      <Text fg={TIP_VAL}>{val}</Text>
    </Text>
  );
  return { plain, node };
}

/* The hover tooltip: a floating card with the full breakdown for the
 * frame under the cursor — inclusive samples and share of both the
 * current view and the whole capture, self time, fan-out, stack depth,
 * and source. Positioned beside the cursor, flipped to stay on screen.
 */
function flameTip(seg, d, zoomed) {
  const h = flameHover.get();
  const { cols, rows: termRows } = screen.get();
  const node = seg.node;
  const root = flameRoot.get();
  const viewPct = ((node.count / zoomed.count) * 100).toFixed(1);
  const allPct = root?.count ? ((node.count / root.count) * 100).toFixed(1) : viewPct;

  let childSamples = 0;
  for (const kid of node.kids.values()) childSamples += kid.count;
  const self = node.count - childSamples;
  const selfPct = node.count ? ((self / node.count) * 100).toFixed(1) : "0.0";
  const absDepth = flameZoom.get().length + d;

  const maxW = Math.max(20, cols - 6);
  const lines = [
    { plain: node.name.slice(0, maxW), node: <Text break="none" bold fg={frameColor(node)}>{node.name.slice(0, maxW)}</Text> },
    {
      plain: node.obj || "—",
      node: <Text break="none" fg={node.kernel ? KERN_C : FAINT}>{node.obj || "—"}</Text>,
    },
    tipRow("samples", `${commas(node.count)}  ${viewPct}% view · ${allPct}% all`),
    tipRow("self", `${commas(self)}  ${selfPct}%`),
    tipRow("depth", `${absDepth} · ${node.kids.size} ${node.kids.size === 1 ? "child" : "children"}`),
  ];
  if (node.loc) {
    const src = `${node.loc.file}${node.loc.line ? `:${node.loc.line}` : ""}`.slice(0, maxW);
    lines.push(tipRow("source", src, PATH_C));
  }

  // Where this frame's samples go: self plus its children, each a bar
  // of its share of the frame. Children beyond the cap fold into a
  // trailing "+N more" so the shares still sum to 100%.
  if (node.kids.size) {
    const header = "distribution ─ where its samples go";
    lines.push({ plain: header, node: <Text break="none" fg={FAINT}>{header}</Text> });
    if (self > 0) lines.push(tipBar("[self]", self, node.count, TIP_SELF));
    const kids = [...node.kids.values()].sort((a, b) => b.count - a.count);
    for (const kid of kids.slice(0, TIP_KIDS)) {
      lines.push(tipBar(kid.name, kid.count, node.count, frameColor(kid)));
    }
    if (kids.length > TIP_KIDS) {
      const rest = kids.slice(TIP_KIDS).reduce((a, k) => a + k.count, 0);
      lines.push(tipBar(`+${kids.length - TIP_KIDS} more`, rest, node.count, FAINT));
    }
  }

  const hint = `⏎ zoom${GH && node.loc ? " · o copy link" : ""}`;
  lines.push({ plain: hint, node: <Text break="none" fg={FAINT}>{hint}</Text> });

  // Size to the widest row (+ border + horizontal padding), then place
  // beside the cursor, flipping left/up at the far edges.
  const contentW = Math.max(...lines.map((l) => l.plain.length));
  const tipW = contentW + 4;
  const tipH = lines.length + 2;
  let left = h.x + 2;
  if (left + tipW > cols) left = h.x - tipW - 1;
  left = Math.max(0, Math.min(left, cols - tipW));
  let top = h.y + 1;
  if (top + tipH > termRows) top = h.y - tipH;
  top = Math.max(0, Math.min(top, Math.max(0, termRows - tipH)));

  return (
    <Box
      left={Size.fixed(left)}
      top={Size.fixed(top)}
      width={Size.fit()}
      height={Size.fit()}
      z={10}
      bg={TIP_BG}
      border={{ line: "round", fg: frameColor(node) }}
      padding={[0, 1]}
    >
      {lines.map((l) => l.node)}
    </Box>
  );
}

const STREAM_LIST_Y = 2;

/* The live flame chart: x is time — one column per publish window,
 * newest at the right edge, sliding left as windows land — and y is
 * stack depth, root on top. Each window shows its dominant stack;
 * adjacent windows whose frame matches merge into one bar, so steady
 * outer frames read as long bars while the leaf flickers between the
 * hot functions. Idle windows leave real gaps.
 */
function streamView() {
  const { cols, rows: termRows } = screen.get();
  const p = target.get();
  const frozen = flameFrozen.get();
  const out = [
    <Text bold fg={HEAD}>
      {trunc(
        ` ${p?.comm ?? "?"} (${p?.pid ?? "?"}) · stream${frozen ? " · frozen" : ""} · ${profStatus.get()}   t/esc table · f flame · ␣ freeze · q quit${flash.get() ? ` · ${flash.get()}` : ""}`,
        cols,
      )}
    </Text>,
  ];

  const data = streamCols.get();
  if (!data.some((c) => c.length)) {
    out.push(<Text dim>{`  ${SPIN[spin.get() % SPIN.length]} collecting stacks…`}</Text>);
    return out;
  }

  const shown = data.slice(-cols);
  const x0 = cols - shown.length;
  out.push(
    <Text fg={FAINT}>
      {` ▸ ${(PUBLISH_MS / 1000).toFixed(1)}s/column · ${shown.length} windows · dominant stack per window`}
    </Text>,
  );

  const depth = Math.min(
    Math.max(...shown.map((c) => c.length)),
    Math.max(1, termRows - STREAM_LIST_Y),
  );
  for (let d = 0; d < depth; d++) {
    const spans = [];
    let cursor = 0;
    let run = null;
    const flushRun = (end) => {
      if (!run) return;
      if (run.start > cursor) spans.push("".padEnd(run.start - cursor));
      const w = end - run.start;
      const link = (GH && run.frame.loc ? urlFor(GH, run.frame.loc) : null) ?? undefined;
      spans.push(
        <Text bg={frameColor(run.frame)} fg={frameInk(run.frame)} link={link}>
          {blockText(w >= 3 ? ` ${run.frame.name}` : "", w)}
        </Text>,
      );
      cursor = end;
      run = null;
    };
    for (let i = 0; i < shown.length; i++) {
      const f = shown[i][d] ?? null;
      const x = x0 + i;
      if (run && f && run.frame.name === f.name && run.frame.obj === f.obj) continue;
      flushRun(x);
      if (f) run = { start: x, frame: f };
    }
    flushRun(cols);
    out.push(<Text break="none">{spans}</Text>);
  }
  return out;
}

loadProcs();

mount(
  () => (
    <Box direction="column" width={Size.fr(1)} height={Size.fr(1)}>
      {() =>
        view.get() !== "profile" ? procsView()
        : profMode.get() === "flame" ? flameView()
        : profMode.get() === "stream" ? streamView()
        : profileView()
      }
    </Box>
  ),
  tty,
  { mouse: true },
);

await new Promise(() => {});
