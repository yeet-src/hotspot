/* patterns.c — stack choreography: deep towers drawing shapes in time.
 *
 *   gcc -O0 -g -o patterns patterns.c -lm
 *   ./patterns
 *
 * Three acts loop forever. Watch in hotspot's stream mode (`t`), where
 * a row's bar length is the time spent at that depth or deeper — so
 * depth itself draws the picture:
 *
 *   breathe — the tower's depth rides a sine wave (8 s period): a
 *             waveform built out of stack frames, striped by zig/zag
 *             mutual recursion like a barber pole.
 *   climb   — a sawtooth staircase: two frames deeper per beat, then
 *             the cliff.
 *   bloom   — a self-similar binary cascade (petal_l / petal_r): flip
 *             to flame mode (`f`) for the fractal.
 *
 * Build with -O0 (or -fno-omit-frame-pointer): the stack walk needs
 * frame pointers, and the choreography needs its steps un-inlined.
 */
#include <math.h>
#include <time.h>

#define WORK __attribute__((noinline))

static volatile double sink;

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

WORK static void hold(long n) {
  for (long i = 0; i < n; i++) sink += (double)i * 0.5;
}

/* --- the striped tower: zig and zag alternate every frame --- */

WORK static void zag(int depth);

WORK static void zig(int depth) {
  if (depth > 0) return zag(depth - 1);
  hold(1500000);
}

WORK static void zag(int depth) {
  if (depth > 0) return zig(depth - 1);
  hold(1500000);
}

/* Keep a tower of `depth` frames standing until the deadline: the leaf
 * burns a couple of milliseconds per rebuild, so nearly every sample
 * lands with the tower at full height.
 */
WORK static void stand(int depth, double until) {
  while (now() < until) zig(depth);
}

/* --- the acts --- */

WORK static void breathe(double until) {
  while (now() < until) {
    double t = now();
    int depth = 16 + (int)(13.0 * sin(t * (2.0 * M_PI / 8.0)));
    stand(depth, t + 0.2);
  }
}

WORK static void climb(double until) {
  int depth = 2;
  while (now() < until) {
    stand(depth, now() + 0.4);
    depth = depth >= 30 ? 2 : depth + 2;
  }
}

WORK static void petal_r(int depth);

WORK static void petal_l(int depth) {
  if (depth == 0) return hold(400000);
  petal_l(depth - 1);
  petal_r(depth - 1);
  hold(150000);
}

WORK static void petal_r(int depth) {
  if (depth == 0) return hold(400000);
  petal_l(depth - 1);
  petal_r(depth - 1);
  hold(150000);
}

WORK static void bloom(double until) {
  while (now() < until) petal_l(7);
}

int main(void) {
  for (;;) {
    breathe(now() + 16);
    climb(now() + 12);
    bloom(now() + 8);
  }
}
