// CPU sampling profiler: a `perf_event` program armed at a fixed frequency
// (~99 Hz per CPU, scoped to one process via cgroup + this pid filter). On
// each tick it captures the user call stack and streams it; the JS side
// symbolizes the leaf frame (ips[0]) through the process maps and folds it
// into a flat self-time profile.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "GPL";

#ifndef BPF_F_USER_STACK
#define BPF_F_USER_STACK (1ULL << 8)
#endif

#define MAX_DEPTH 48

// Only sample this process (cgroup-scoped events fire for every task in the
// cgroup). Patched via probe.bss before subscribing. 0 = accept every task.
volatile int target_pid = 0;

// One sample: the interrupted PC (kernel or user, whichever mode the CPU
// was in when the tick landed) plus the user call stack, leaf-first
// (ips[0] = current user PC).
struct stack_sample {
	__u64 ts;
	__u64 pc;
	__u32 tid;
	__u32 depth;
	__u64 ips[MAX_DEPTH];
};

struct stack_sample *_unused_stack_sample __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 20);
} samples SEC(".maps");

SEC("perf_event")
int on_sample(struct bpf_perf_event_data *ctx)
{
	if (target_pid && (bpf_get_current_pid_tgid() >> 32) != (__u32)target_pid) {
		return 0;
	}

	struct stack_sample *e = bpf_ringbuf_reserve(&samples, sizeof(*e), 0);
	if (!e) {
		return 0;
	}

	// The PC the tick interrupted — a kernel address when the task was in
	// kernel mode (syscall, fault, ...), a user address otherwise. The
	// userspace side splits on the sign bit and symbolizes each half
	// through kallsyms / the process maps.
	e->pc = PT_REGS_IP((struct pt_regs *)&ctx->regs);

	// Walk the user stack straight into the ring-buffer record. Returns
	// the number of bytes written (8 per frame), or < 0 when no user stack
	// is available — keep the sample anyway, the PC alone still profiles.
	long n = bpf_get_stack(ctx, e->ips, sizeof(e->ips), BPF_F_USER_STACK);
	e->depth = n > 0 ? (__u32)n / sizeof(__u64) : 0;

	if (!e->pc && !e->depth) {
		bpf_ringbuf_discard(e, 0);
		return 0;
	}

	e->ts = bpf_ktime_get_ns();
	e->tid = (__u32)bpf_get_current_pid_tgid();
	bpf_ringbuf_submit(e, 0);
	return 0;
}
