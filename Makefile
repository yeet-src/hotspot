# Build the yeet script project.
#
#   make         — build everything (BPF objects + JS bundle)
#   make bpf     — compile bpf/*.bpf.c into bin/* only
#   make veristat — load the built object with veristat (verifier check on this kernel)
#   make bundle  — bundle the JS entry with esbuild
#   make postgen — finalize a freshly generated project (git init)
#   make clangd  — write a local .clangd pointing at the resolved toolchain
#   make clean   — remove build artifacts
#
# This is the build *frontend*: it orchestrates two independent
# compilers — clang for the BPF objects, esbuild for the JS bundle.
# Neither understands the other; the JS references compiled objects in
# bin/ only by path, resolved at runtime. `yeet run` invokes `make`
# automatically when running this project from a trusted remote source,
# so the default goal must leave the project runnable.
#
# clang, bpftool and esbuild come from the static toolchain resolved by
# build/toolchain.mk (a shared per-machine cache, or binaries vendored in
# the bootstrap repo) — so the build needs no system C/BPF toolchain.

.DEFAULT_GOAL := all

include build/toolchain.mk
include build/bpf.mk

all: bpf bundle

# Bundle the entry with the vendored esbuild. esbuild honors tsconfig `paths`
# (so `@/` resolves at bundle time), while `yeet:*` builtins and `*.bpf.o`
# objects stay external. The bundle is written to src/index.jsx, which the
# entry ladder prefers over src/main.jsx — so once built, that is what runs.
# The .jsx extension keeps the bundle eligible for component auto-mount.
# Compiled BPF objects in bin/ are loaded by path at runtime, never imported,
# so they are not bundled.
#
# The build needs no npm/node: the starter imports only `yeet:*` builtins and
# local `@/` modules, which esbuild resolves on its own. If you add third-party
# packages to package.json, install them into node_modules with the package
# manager of your choice — esbuild inlines whatever it finds there.
ESBUILD_FLAGS := --bundle --format=esm --platform=neutral \
	--main-fields=module,main --conditions=import,module \
	--define:import.meta.main=false \
	--outfile=src/index.jsx --jsx=automatic --jsx-import-source=yeet:tui

bundle: | toolchain
	$(ESBUILD) src/main.jsx $(ESBUILD_FLAGS) '--external:yeet:*' '--external:*.bpf.o'

# Post-generation finalize: initialize a git repository with the vendored git
# (fetched via `vendored-git`). Idempotent — skipped if this is already a repo.
# The scaffolders (`yeet new`, `scripts/new`) run `make postgen` after creating
# the project, so the CLI itself stays a thin caller of make.
postgen: | vendored-git
	@g="$(GIT)"; [ -x "$$g" ] || g="$$(command -v git 2>/dev/null || true)"; \
	if [ -e .git ]; then \
		echo "postgen: already a git repository"; \
	elif [ -n "$$g" ]; then \
		echo "postgen: git init"; \
		"$$g" -c init.templateDir= init -q . || echo "warning: 'git init' failed" >&2; \
	else \
		echo "warning: no git available (vendored or host); skipping 'git init'" >&2; \
	fi

# Demo workloads: synthetic CPU burners with deliberately shaped call graphs,
# so there is something worth profiling on an idle box (and something worth
# recording). Built with the HOST compiler, not the BPF toolchain — these are
# ordinary userspace programs, unrelated to bin/probe.bpf.o.
#
# -O0 -fno-omit-frame-pointer is load-bearing twice over: bpf_get_stack walks
# frame pointers, and un-inlined functions are what keep their names on screen.
# -g puts file:line on each row, which is what `--repo` linking hangs off.
# See demo/README.md for what each one shows and how to record it.
DEMO_SRCS := $(wildcard demo/*.c)
DEMO_BINS := $(patsubst demo/%.c,demo/%,$(DEMO_SRCS))
DEMO_CFLAGS := -O0 -g -fno-omit-frame-pointer -Wall

.PHONY: demo
demo: $(DEMO_BINS)

# patterns.c needs -lm for sin(); linking it unconditionally is harmless.
demo/%: demo/%.c
	@command -v $(CC) >/dev/null 2>&1 || { echo "error: no host C compiler ($(CC)) — install gcc or clang"; exit 1; }
	$(CC) $(DEMO_CFLAGS) -o $@ $< -lm

clean: clean-bpf clean-demo
	rm -rf node_modules dist src/index.jsx

.PHONY: clean-demo
clean-demo:
	rm -rf $(DEMO_BINS) $(addsuffix .dSYM,$(DEMO_BINS))

.PHONY: all bundle clean postgen
