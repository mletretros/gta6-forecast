// Forecast GTA VI's launch-day Twitch concurrent viewers (makefun/twitch-ccu-case/v1).
//
// Model: empirical quantiles of comparable launches' hourly log ratios, conditioned on the
// case's checkpoint history.
//
// For every comparable launch c with a complete UTC release-day curve, and every forecast
// hour h = 2..24, form the log ratio
//
//   r(c, h) = ln(y(c, h) / y(c, 1)).
//
// A comparable's curve is described at its own checkpoint by three scale-free-ish
// descriptors: ln(hour-1 viewers), the hour-1 elevation over its preceding 7-day median,
// and the momentum from 24 hours to 1 hour before its release day. The case is described
// the same way. Comparables are weighted by Gaussian similarity in those standardized
// descriptors, with a weight floor so the empirical distribution never collapses to a
// handful of launches. The case's forecast is
//
//   q_tau(h) = print_1 * exp(weighted_quantile_tau({ r(c, h) ; weights })).
//
// Descriptor conditioning is shrunk toward the pool mean and capped: the validation's
// leave-one-comparable-out backtest showed that absolute hour-1 level carries most of the
// signal, but full-strength conditioning is an extrapolation risk for a launch far larger
// than anything in the pool. Small-sample hours fall back to the unweighted pool, then to
// the house persistence shape.
//
// Node 22+, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The five scored levels, in output order. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level; used by the persistence fallback. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** The house baseline's log-spread per square-root hour, kept for the fallback. */
const SIGMA = 0.15;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Conditioning configuration. The same constants are used for every case and for the
// backtest. They were selected once on the leave-one-comparable-out backtest, so that
// backtest's score is an in-sample estimate of hyperparameter quality, not a clean
// held-out score; see README.md.
const SHRINK_LEVEL = 0.75;
const SHRINK_ELEVATION = 0.35;
const SHRINK_MOMENTUM = 0.4;
const BANDWIDTH = 0.6;
const WEIGHT_FLOOR = 0.01;
const Z_CAP = 2.0;
const MIN_RATIOS = 4;
const SMOOTH_NEIGHBOUR = 0.2;

const MIN_Q = 0.01;
const MAX_Q = 1_000_000_000;

interface HourPoint {
  from: string;
  viewers: number;
  channels?: number | null;
  reads?: number;
}

interface Comparable {
  name?: string;
  day_start: string;
  hourly: HourPoint[];
}

interface KnownHour {
  hour: number;
  from?: string;
  viewers: number;
  channels?: number | null;
  reads?: number;
}

interface HistoryPoint {
  at: string;
  viewers: number;
  channels?: number | null;
}

interface Case {
  id?: string;
  levels: number[];
  day_start: string;
  checkpoint?: string;
  known: KnownHour[];
  forecast: Array<{ hour: number; from?: string; until?: string }>;
  history?: HistoryPoint[];
  history_hourly?: HourPoint[];
  comparables?: Comparable[];
}

interface Descriptor {
  level: number;
  elevation: number | null;
  momentum: number | null;
}

interface Pool {
  curve: Array<number | null>;
  descriptor: Descriptor;
}

const logFloor = (x: number): number => Math.log(Math.max(1, x));
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const roundTo = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/** Linear-interpolation quantile of a sorted numeric array. */
function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * clamp(p, 0, 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

/** Descending-scan helper: the latest pre-release point at or before `t`. */
function pointAtOrBefore(points: Array<{ t: number; v: number }>, t: number): number | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i].t <= t) return points[i].v;
  return null;
}

/** Descriptors of a case/comparable checkpoint, from its own pre-release history. */
function describe(dayStart: number, p1: number, history: Array<{ t: number; v: number }>): Descriptor {
  const level = logFloor(p1);
  const week = history.filter((p) => p.t >= dayStart - 7 * DAY_MS && p.t < dayStart);
  const weekMedian = median(week.map((p) => logFloor(p.v)));
  const elevation = weekMedian == null ? null : level - weekMedian;
  const oneHour = pointAtOrBefore(history, dayStart - HOUR_MS);
  const dayAgo = pointAtOrBefore(history, dayStart - DAY_MS);
  const momentum = oneHour == null || dayAgo == null ? null : logFloor(oneHour) - logFloor(dayAgo);
  return { level, elevation, momentum };
}

/** The comparable's viewers at each of hours 1..24 of its UTC release day. */
function releaseDayCurve(c: Comparable): { curve: Array<number | null>; history: Array<{ t: number; v: number }>; day: number } {
  const byStart = new Map<number, number>();
  for (const p of c.hourly ?? []) {
    const t = Date.parse(p.from);
    if (!Number.isFinite(t) || !Number.isFinite(p.viewers)) continue;
    if (!byStart.has(t)) byStart.set(t, Math.max(1, p.viewers));
  }
  const day = Date.parse(c.day_start);
  if (!Number.isFinite(day)) return { curve: [], history: [], day: Number.NaN };
  const curve: Array<number | null> = [];
  for (let h = 1; h <= 24; h++) curve.push(byStart.get(day + (h - 1) * HOUR_MS) ?? null);
  const history: Array<{ t: number; v: number }> = [];
  for (const [t, v] of byStart) if (t < day) history.push({ t, v });
  history.sort((a, b) => a.t - b.t);
  return { curve, history, day };
}

/** Hourly history supplied by the case, preferring whole-hour means. */
function caseHistory(c: Case, dayStart: number): Array<{ t: number; v: number }> {
  const points: Array<{ t: number; v: number }> = [];
  const hourly = c.history_hourly ?? [];
  if (hourly.length > 0) {
    for (const p of hourly) {
      const t = Date.parse(p.from);
      if (!Number.isFinite(t) || !Number.isFinite(p.viewers)) continue;
      points.push({ t, v: Math.max(1, p.viewers) });
    }
  } else {
    const buckets = new Map<number, { sum: number; n: number }>();
    for (const p of c.history ?? []) {
      const t = Date.parse(p.at);
      if (!Number.isFinite(t) || !Number.isFinite(p.viewers)) continue;
      const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
      const b = buckets.get(hour) ?? { sum: 0, n: 0 };
      b.sum += Math.max(1, p.viewers);
      b.n += 1;
      buckets.set(hour, b);
    }
    for (const [t, b] of buckets) points.push({ t, v: b.sum / b.n });
  }
  const filtered = points.filter((p) => p.t < dayStart).sort((a, b) => a.t - b.t);
  return filtered;
}

function meanStd(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 1 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.sqrt(variance) || 1 };
}

/** Weighted empirical quantile; a step through the weighted CDF. */
function weightedQuantile(items: number[], weights: number[], p: number): number {
  const pairs = items.map((v, i) => ({ v, w: Math.max(0, weights[i]) })).sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, z) => s + z.w, 0);
  if (total <= 0) return quantileSorted(items.slice().sort((a, b) => a - b), p);
  const target = clamp(p, 0, 1) * total;
  let cumulative = 0;
  for (const pair of pairs) {
    cumulative += pair.w;
    if (cumulative >= target) return pair.v;
  }
  return pairs[pairs.length - 1].v;
}

/** The standard normal persistence fallback (the house baseline's shape). */
function persistence(p1: number, hour: number): number[] {
  return Z.map((z) => p1 * Math.exp(z * SIGMA * Math.sqrt(Math.max(0, hour - 1))));
}

/**
 * Empirical log-ratio quantiles for one hour.
 *
 * `conditioned` supplies the weighted pool. If it has too few observations, the plain
 * pool is used; if that is also too small, null is returned and the caller falls back to
 * the persistence shape.
 */
function ratioQuantiles(pool: Pool[], caseDescriptor: Descriptor | null, hour: number): number[] | null {
  const rows = pool
    .map((p) => ({ p, first: p.curve[0], value: p.curve[hour - 1] }))
    .filter((r) => r.first != null && r.value != null)
    .map((r) => ({ descriptor: r.p.descriptor, ratio: Math.log(r.value as number) - Math.log(r.first as number) }));
  if (rows.length < MIN_RATIOS) return null;

  const levelStats = meanStd(rows.map((r) => r.descriptor.level));
  const elevationKnown = rows.filter((r) => r.descriptor.elevation != null);
  const momentumKnown = rows.filter((r) => r.descriptor.momentum != null);
  const elevationStats = meanStd(elevationKnown.map((r) => r.descriptor.elevation as number));
  const momentumStats = meanStd(momentumKnown.map((r) => r.descriptor.momentum as number));

  const weights: number[] = [];
  if (caseDescriptor == null) {
    for (let i = 0; i < rows.length; i++) weights.push(1);
  } else {
    const zCaseLevel = clamp(SHRINK_LEVEL * ((caseDescriptor.level - levelStats.mean) / levelStats.sd), -Z_CAP, Z_CAP);
    const zCaseElevation = caseDescriptor.elevation == null
      ? 0
      : clamp(SHRINK_ELEVATION * ((caseDescriptor.elevation - elevationStats.mean) / elevationStats.sd), -Z_CAP, Z_CAP);
    const zCaseMomentum = caseDescriptor.momentum == null
      ? 0
      : clamp(SHRINK_MOMENTUM * ((caseDescriptor.momentum - momentumStats.mean) / momentumStats.sd), -Z_CAP, Z_CAP);
    for (const row of rows) {
      const zLevel = (row.descriptor.level - levelStats.mean) / levelStats.sd;
      let penalty = ((zLevel - zCaseLevel) / BANDWIDTH) ** 2;
      if (row.descriptor.elevation != null) {
        const zElevation = (row.descriptor.elevation - elevationStats.mean) / elevationStats.sd;
        penalty += ((zElevation - zCaseElevation) / BANDWIDTH) ** 2;
      }
      if (row.descriptor.momentum != null) {
        const zMomentum = (row.descriptor.momentum - momentumStats.mean) / momentumStats.sd;
        penalty += ((zMomentum - zCaseMomentum) / BANDWIDTH) ** 2;
      }
      weights.push(Math.exp(-0.5 * penalty) + WEIGHT_FLOOR);
    }
  }

  const ratios = rows.map((r) => r.ratio);
  return LEVELS.map((p) => weightedQuantile(ratios, weights, p));
}

export function forecastCase(c: Case, name = 'case'): { hours: Array<{ hour: number; q: number[] }> } {
  if (!Array.isArray(c.levels) || c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${name} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (!Array.isArray(c.known)) throw new Error(`${name} has no known hours`);
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined || !Number.isFinite(first.viewers)) throw new Error(`${name} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);
  const dayStart = Date.parse(c.day_start);
  if (!Number.isFinite(dayStart)) throw new Error(`${name} has no valid day_start`);

  const pool: Pool[] = [];
  for (const comp of c.comparables ?? []) {
    const { curve, history, day } = releaseDayCurve(comp);
    if (curve.length !== 24 || curve[0] == null || !Number.isFinite(day)) continue;
    pool.push({ curve, descriptor: describe(day, curve[0], history) });
  }
  const caseDescriptor = describe(dayStart, p1, caseHistory(c, dayStart));

  const raw: number[][] = [];
  for (let hour = 2; hour <= 24; hour++) {
    const ratios = ratioQuantiles(pool, caseDescriptor, hour);
    const q = ratios === null ? persistence(p1, hour) : ratios.map((r) => p1 * Math.exp(r));
    raw.push(q);
  }

  // Light smoothing across neighbouring hours: the comparable set is small, and the
  // shared diurnal shape is much less noisy than any single hour's order statistics.
  const smooth: number[][] = raw.map((row, i) => {
    return row.map((value, level) => {
      let num = value;
      let den = 1;
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= raw.length) continue;
        num += SMOOTH_NEIGHBOUR * raw[j][level];
        den += SMOOTH_NEIGHBOUR;
      }
      return num / den;
    });
  });

  const hours = smooth.map((q, i) => {
    const fallback = persistence(p1, i + 2);
    const rounded = q.map((v, level) => {
      const safe = Number.isFinite(v) ? v : fallback[level];
      return roundTo(clamp(safe, MIN_Q, MAX_Q), 4);
    });
    for (let j = 1; j < rounded.length; j++) if (rounded[j] < rounded[j - 1]) rounded[j] = rounded[j - 1];
    return { hour: i + 2, q: rounded };
  });
  return { hours };
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    const out = forecastCase(c, file);
    writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();
