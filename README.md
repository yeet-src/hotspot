# hotspot

A point-and-click CPU profiler built on `yeet:bpf` + `yeet:sym`. Pick a
process from the live process table, click it, and watch a flat self-time
profile build in real time — user *and* kernel functions, each with a %
share, heat bar, and the object it lives in.

```sh
make                                 # BPF object + JS bundle (vendored toolchain)
yeet run examples/hotspot --tty
```

## Keys & mouse

| input | action |
|---|---|
| click | select the row under the pointer |
| click (selected row) / `→` / `⏎` | profile the selected process |
| right-click / `←` / `esc` | back to the process list |
| wheel / `↑↓` / `j`/`k` / `PageUp`/`PageDown` / `g`/`G` | move & scroll |
| `r` | refresh the process list |
| `q` | quit |

## How it works

- **Sampling** — opening a process arms a `perf_event` BPF program
  (`src/bpf/sample.bpf.c`) at 99 Hz per CPU, scoped to the process's cgroup
  with an in-kernel `target_pid` filter (cgroup scope catches worker
  threads; the filter keeps cgroup siblings out). Each tick streams the
  interrupted PC — a kernel address when the task was in kernel mode, a
  user address otherwise — plus the user call stack through a ring buffer.
- **Symbolization** (`src/lib/symbolize.js`) — PCs split on the sign bit.
  Kernel PCs resolve through `Inspector.kernel()` (kallsyms: core kernel,
  modules, JITed BPF). User PCs resolve through
  `Inspector.process(pid, { debugSyms: true })`, which routes each address
  through the live process maps daemon-side — ASLR, deleted binaries, the
  vDSO and perf-map JIT symbols all handled — and reaches past `.dynsym`
  into each object's debug info. Addresses cross the wire as `BigInt`, so
  kernel PCs (> 2^53) keep their low bits. Lookups are cached and batched
  with `symbolizeMany` — one round-trip per publish tick, not one per
  sample.
- **Aggregation** — JS folds per-PC counts into per-function rows on a
  500 ms timer: self-time only (the leaf), sorted hottest-first, kernel
  rows tinted and labeled `kernel`. `??` rows are PCs still in flight or
  landing in stripped objects.

A syscall-heavy target (`dd if=/dev/zero of=/dev/null`) shows the kernel
side immediately: `__arch_clear_user` dominating, `el0_svc` /
`invoke_syscall` / `vfs_read` trailing. A busy interpreter (ruby, python)
shows the user side (`vm_exec_core`, …).

`??` rows in a distro library mean PCs landed between exported symbols —
non-exported internals (glibc's `_int_malloc`, IFUNC `memcpy` variants)
exist only in the full symtab shipped with the debug package. Install it
(`apt install libc6-dbg`) and the `debugSyms` inspector names them via the
build-id debug file.

## Layout

```
Makefile               build frontend — clang (BPF) + esbuild (JS)
build/                 vendored-toolchain resolution, vmlinux.h generation
src/bpf/sample.bpf.c   the perf_event sampler
src/probes/profile.js  BPF-facing: sampler lifecycle -> hot/total/status signals
src/lib/symbolize.js   kernel + process symbolization, cached & batched
src/main.jsx           views, input (keys + mouse), rendering
```
