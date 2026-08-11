/* cafe.c — a café simulation that paints a living flamegraph.
 *
 *   gcc -O0 -g -o cafe cafe.c
 *   ./cafe
 *
 * Three shifts rotate every four seconds, each burning CPU in its own
 * call subtree — watch the bands slide by in hotspot's stream mode
 * (`t`) and the icicle reshape in flame mode (`f`). The espresso
 * machine tamps through a twelve-frame recursive tower for depth, and
 * the accountant chases receipts through eight.
 *
 * Build with -O0 (or -fno-omit-frame-pointer): the stack walk needs
 * frame pointers, and the shop needs its labor un-inlined.
 */
#include <time.h>

#define WORK __attribute__((noinline))

static volatile double sink;

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

WORK static void toil(long n) {
  for (long i = 0; i < n; i++) sink += (double)i * 0.5;
}

/* --- the espresso machine --- */

WORK static void tamp_layer(int depth) {
  if (depth > 0) return tamp_layer(depth - 1);
  toil(2000000);
}

WORK static void grind_beans(void) { toil(6000000); }

WORK static void pull_shot(void) {
  grind_beans();
  tamp_layer(12);
  toil(4000000);
}

WORK static void steam_milk(void) { toil(9000000); }
WORK static void pour_latte_art(void) { toil(3000000); }

WORK static void make_latte(void) {
  pull_shot();
  steam_milk();
  pour_latte_art();
}

WORK static void make_espresso(void) { pull_shot(); }

/* --- the kitchen --- */

WORK static void knead_dough(void) { toil(8000000); }

WORK static void bake_croissants(void) {
  knead_dough();
  toil(5000000);
}

WORK static void wash_dishes(void) { toil(4000000); }

/* --- the books --- */

WORK static void count_till(void) { toil(3000000); }

WORK static void chase_receipts(int depth) {
  if (depth > 0) return chase_receipts(depth - 1);
  toil(2500000);
}

WORK static void balance_books(void) {
  count_till();
  chase_receipts(8);
}

/* --- shifts --- */

WORK static void morning_rush(double until) {
  while (now() < until) {
    make_latte();
    make_espresso();
  }
}

WORK static void lunch_service(double until) {
  while (now() < until) {
    bake_croissants();
    wash_dishes();
    wash_dishes();
  }
}

WORK static void closing_time(double until) {
  while (now() < until) {
    balance_books();
    wash_dishes();
  }
}

int main(void) {
  for (;;) {
    morning_rush(now() + 4);
    lunch_service(now() + 4);
    closing_time(now() + 4);
  }
}
