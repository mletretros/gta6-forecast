# gta6-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mletretros/gta6-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mletretros/gta6-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

A Node 22, standard-library-only entry for the make.fun competition
`gta6-twitch-ccu-forecast-01`. It reads one `makefun/twitch-ccu-case/v1` case and
writes the five requested quantiles for hours 2–24 of the release day.

The model is an empirical quantile forecast over comparable game launches' hourly
log ratios, conditioned on the case's checkpoint history.

## Quick Start

Requirements: Node 22.18 or newer (native TypeScript type stripping), no packages.

```sh
# from this repository, against the kit's practice inputs
mkdir -p out
MAKEFUN_INPUT_DIR=/path/to/gta6-twitch-ccu-forecast-01-kit/input \
MAKEFUN_OUTPUT_DIR=out \
node main.ts
```

With the kit checked out beside this repository, the default validation path finds
the inputs automatically:

```sh
node validation.mjs
```

The entrypoint also accepts the grader's defaults (`/input`, `/output`) when the
environment variables are unset. It reads every `*.in` file in name order and writes
one `<id>.out` per case.

## How it works

For each comparable launch with a complete 24-hour release-day curve:

```
r(c,h) = ln(viewers(c,h) / viewers(c,1))
```

A comparable is described at its own checkpoint by:

- `level`: `ln` of its hour-1 print,
- `elevation`: hour-1 print over its preceding 7-day median (log scale),
- `momentum`: the move from 24 hours before its release day to 1 hour before.

The case is described the same way from its own `history_hourly` (or hourly-binned
`history`). Descriptors are standardized against the comparable pool, shrunk toward
the pool mean, capped at ±2 standard deviations, and compared with a Gaussian kernel
(bandwidth 0.6, weight floor 0.01). The forecast is the weighted empirical quantile
of `r(c,h)` attached to the case's hour-1 print:

```
q_tau(h) = print_1 * exp(weighted_quantile_tau({r(c,h)}, {w(c)}))
```

Adjacent hours are lightly smoothed (neighbour weight 0.2) because the pooled sample
is small and the shared diurnal shape is less noisy than one hour's order statistics.
If fewer than four ratios are usable, the unweighted pool is used; if that also
fails, the house persistence shape is the fallback. Every quantile is finite, above
zero, at most `1e9`, and non-decreasing.

No randomness, network access, model call, or external data is used at runtime.

## Validation

`validation.mjs` is the only honest local check available. The four practice cases
ship without their hours 2–24, and the official scorer is server-side, so no local
practice score can be computed. Instead the script:

1. treats each of the 37 complete comparable launches as a pseudo-case (its own
   pre-release history and hour-1 print are the inputs, its real release-day curve
   is the answer),
2. removes that launch from the comparable pool (leave-one-comparable-out),
3. runs the real `node main.ts` entrypoint twice per pseudo-case,
4. validates the output schema and determinism,
5. scores the competition's log pinball loss and the house persistence baseline,
6. runs all four practice inputs for schema, determinism, and runtime, without
   claiming a score.

Latest run:

| metric | model | house baseline |
|---|---:|---:|
| mean log pinball loss (851 items) | **0.451977** | 0.929644 |
| improvement over house | **51.38%** | — |
| typical miss | 92.51% | — |
| 90% coverage | 0.8296 | — |

Runtime was under 0.4 s per run locally, against the 8,000 ms cap. All pseudo-cases
and all four practice inputs produced valid, byte-identical outputs on repeated runs.

Run only the backtest, or point it at another kit input directory:

```sh
node validation.mjs --no-practice
node validation.mjs --input /path/to/input --runs 2
```

## Limitations

- **No local official score.** The practice answers are not in the kit. The LOO
  numbers above measure comparable launches, not the four practice cases and not
  GTA VI.
- **Hyperparameters were selected on the same 37 launches.** The LOO split prevents
  each launch from forecasting itself, but it does not make the reported score a
  clean held-out estimate. The true final score will differ.
- **Only 37 launches, mostly console/PC AAA releases.** GTA VI is likely far outside
  the pool's hour-1 range. Conditioning is shrunk and capped to limit extrapolation,
  but this remains the largest source of model risk.
- **Measurement differences.** Comparables are SullyGnome hourly averages; the final
  is a mean of minute reads from Twitch's directory. Hourly averaging and sparse
  sampling can move the curve.
- **Unlock timing is not structured.** The model infers launch phase only from the
  checkpoint descriptors; it does not parse the free-text `notes` or model regional
  unlock times explicitly.
- **Distribution shift.** A 2026 launch's Twitch audience, co-streaming behaviour,
  and platform mix may not resemble 2018–2026 comparables.
- **Wide tails.** The empirical 5%/95% quantiles come from a small pool, so late-day
  intervals can be very wide. That is honest uncertainty, but it costs pinball loss
  when the tail is unnecessary.
- **Offline only.** The entry cannot read Twitch or update itself; it has no network
  and no model call at run time.

## Files

- `main.ts` — the entrypoint (Node 22, standard library only).
- `validation.mjs` — leave-one-comparable-out backtest and practice smoke test.
- `LICENSE` — MIT.

## License

MIT. See `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jvmnr2xf&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
