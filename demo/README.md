# Demo workloads

Two synthetic CPU burners that give `hotspot` something worth looking at on an
idle box. Both are built for recording: their call graphs are designed so the
flame view has structure and the stream view has motion.

```sh
make demo          # builds demo/cafe and demo/patterns
./demo/cafe        # in one shell
yeet run . --tty   # in another: click `cafe` in the process list
```

Both are built `-O0 -g`: the stack walk needs frame pointers, and the whole
point is that the functions stay un-inlined and keep their names. `-g` is what
puts `file:line` on each row, which is what `--repo` linking hangs off.

## `cafe` — a café that rotates through three shifts

Three shifts rotate every four seconds, each burning CPU in its own call
subtree. The espresso machine tamps through a twelve-frame recursive tower;
the accountant chases receipts through eight.

What it shows off, per view:

| view | what to look for |
| --- | --- |
| flat (default) | the leaf table reshuffling every four seconds as the shift changes |
| flame (`f`) | three distinct subtrees under `main`, one per shift, with the deep `tamp_layer` tower |
| stream (`t`) | four-second bands sliding right to left, one per shift |

Best single take for a hero GIF. Shift changes are frequent enough to show
motion inside ten seconds and slow enough to read.

## `patterns` — stack depth as choreography

Three acts loop forever, drawing shapes out of stack depth. Built for stream
mode, where a row's length is time spent at that depth or deeper.

| act | duration | shape |
| --- | --- | --- |
| `breathe` | 16s | depth rides a sine wave (8s period), striped by `zig`/`zag` mutual recursion |
| `climb` | 12s | a sawtooth staircase, two frames deeper per beat, then the cliff |
| `bloom` | 8s | a self-similar binary cascade (`petal_l` / `petal_r`); flip to flame mode for the fractal |

`bloom` is the best flame-mode frame in either program. `breathe` is the best
stream-mode one.

## Recording a GIF

There's no capture script; drive it yourself so the take is yours. The setup
that produces a readable GIF:

```sh
make demo
./demo/cafe &                     # or ./demo/patterns
# resize the terminal to ~100x30, then record:
yeet run . --tty
```

A tour that fits in ~20 seconds, in the order that reads best:

1. Land on the process list, scroll to `cafe`, click it.
2. Let the flat profile fill for three or four seconds. The heat bars and the
   per-object dots are the payload here.
3. Press `f` for the flame view. Hover a block to pull up the tooltip; that's
   the most distinctive frame in the whole tool.
4. Press `⏎` on a block to zoom, `esc` to come back out.
5. Press `t` for the stream view and let two or three bands slide past.
6. `q`.

Notes that matter for the capture:

- **~100x30 or wider.** The flame and stream views lay out across the full
  terminal width, and the tooltip needs room to place itself beside the cursor.
- **Let each view sit for a beat.** Every view publishes on a 400ms window, so
  a fast cut through the modes records as a smear.
- **Hover deliberately.** The tooltip only paints while the cursor is over a
  block, and mouse motion isn't visible in the recording, so a slow hover on
  one block reads far better than sweeping across several.
- Terminals differ on mouse reporting. If hovering does nothing, the terminal
  isn't forwarding motion events; the keyboard tour still works.
