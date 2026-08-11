// CPU sampling profiler. `attachProfile` arms a perf-event program at a
// fixed frequency scoped to one process, and folds each sample's
// interrupted PC (kernel or user) into a cumulative count:
//   • `hot`    — Map of sampled pc (BigInt) -> sample count.
//   • `stacks` — Map of folded stack -> { frames, count }, leaf-first,
//                the kernel pc atop the user stack when the sample
//                interrupted the kernel.
//   • `history` — the last HISTORY publish windows, oldest first, each
//                its own folded-stack Map (empty when the target idled),
//                so a timeline view can scroll through time.
//   • `total`  — cumulative samples seen.
//   • `status` — human-readable probe state, safe to render.
import { BpfObject, DataSec, RingBuf } from "yeet:bpf";
import { signal } from "yeet:tui";

export const PUBLISH_MS = 400;
const HISTORY = 512;
const KERNEL_BIT = 1n << 63n;

const fold = (map, frames) => {
  const key = frames.join(",");
  const cur = map.get(key);
  if (cur) cur.count++;
  else map.set(key, { frames, count: 1 });
};

// Sample the whole process via its cgroup when one is found — the target's
// hot work often runs off the main thread (worker pools, isolate threads),
// which perf can't see by pid alone, and per-thread attach races thread
// churn. The in-kernel target_pid filter keeps cgroup siblings out.
async function cgroupOf(pid) {
  try {
    const { data } = await yeet.graph.query(`{ proc(pid: ${pid}) { cgroups { hierarchy pathname } } }`);
    const cs = data?.proc?.cgroups ?? [];
    const v2 = cs.find((c) => c.hierarchy === 0) ?? cs[0];
    if (v2?.pathname != null) return `/sys/fs/cgroup${v2.pathname === "/" ? "" : v2.pathname}`;
  } catch {}
  return null;
}

/* 499 Hz: fast convergence for an interactive profile at negligible
 * cost, and prime — so sampling never phase-locks with kernel ticks
 * (100/250/300/1000 Hz) or round application timers, which would bias
 * the profile toward whatever runs at those phases.
 */
export function attachProfile({ pid, freq = 499 }) {
  const hot = signal(new Map());
  const stacks = signal(new Map());
  const history = signal([]);
  const total = signal(0);
  const status = signal("arming sampler…");

  const leafCounts = new Map();
  const stackCounts = new Map();
  let windowCounts = new Map();
  let cumulative = 0;
  let stopped = false;
  let control = null;
  let sub = null;
  let timer = null;

  (async () => {
    try {
      const cgroup = await cgroupOf(pid);
      if (stopped) return;
      const target = cgroup ? { kind: "cgroup", path: cgroup } : { kind: "pids", pids: [pid] };

      const obj = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname })
        .bind("samples", { kind: "ringbuf", btf_struct: "stack_sample" })
        .bind("probe.bss", { kind: "data" })
        .attach("on_sample", {
          kind: "perf",
          event: { kind: "software", name: "cpu_clock" },
          sample: { freq },
          target,
        });

      control = await obj.start();
      if (stopped) return void (await control.stop());

      new DataSec(control, "probe.bss").patch({ target_pid: pid });

      const rb = new RingBuf(control, "samples");
      sub = await rb.subscribe((w) => {
        const e = w?.stack_sample ?? w;
        // The interrupted PC; fall back to the user-stack leaf on the rare
        // sample where the register read came back zero.
        let ip = e.pc ?? 0;
        if (typeof ip !== "bigint") ip = BigInt(ip ?? 0);
        if (ip === 0n && Number(e.depth ?? 0)) {
          ip = e.ips[0];
          if (typeof ip !== "bigint") ip = BigInt(ip ?? 0);
        }
        if (ip === 0n) return;
        cumulative++;
        leafCounts.set(ip, (leafCounts.get(ip) ?? 0) + 1);

        // Fold the whole stack, leaf-first. A user-space pc is already
        // ips[0]; a kernel pc has no user twin, so it tops the stack.
        const depth = Number(e.depth ?? 0);
        const frames = [];
        if ((ip & KERNEL_BIT) !== 0n) frames.push(ip);
        for (let i = 0; i < depth; i++) {
          let f = e.ips[i];
          if (typeof f !== "bigint") f = BigInt(f ?? 0);
          if (f === 0n) break;
          frames.push(f);
        }
        if (frames.length) {
          fold(stackCounts, frames);
          fold(windowCounts, frames);
        }
      });

      status.set(`sampling ${freq} Hz (${cgroup ? "cgroup" : "pid"})`);
      timer = setInterval(() => {
        hot.set(new Map(leafCounts));
        stacks.set(new Map(stackCounts));
        // Every window lands a bucket, an idle one included — the
        // timeline's gaps are real time.
        history.update((h) => [...h.slice(-(HISTORY - 1)), windowCounts]);
        windowCounts = new Map();
        total.set(cumulative);
      }, PUBLISH_MS);
    } catch (e) {
      status.set(`probe failed: ${e?.message ?? e?.code ?? e}`);
    }
  })();

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    try {
      if (sub) await sub.unsubscribe();
    } catch {}
    try {
      if (control) await control.stop();
    } catch {}
  }

  return { pid, hot, stacks, history, total, status, stop };
}
