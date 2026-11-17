// Leave-one-comparable-out backtest for main.ts.
//
// This is the only honest local validation available: the four practice cases ship
// without their answers (the server keeps them), but every comparable ships with its
// own 14-day history and its full release-day curve. So each comparable becomes a
// pseudo-case: its release day is the target, its history before the day and its hour-1
// print are the inputs, and it is removed from the comparable pool that forecasts it.
//
// For every held-out comparable the script:
//   1. writes a schema-valid makefun/twitch-ccu-case/v1 file,
//   2. runs the real entrypoint (node main.ts) on it, twice, and checks determinism,
//   3. validates the output schema,
//   4. scores it with the competition's log pinball loss, and scores the house
//      persistence baseline on the same actual prints,
//   5. reports mean loss (model vs house), typical miss, 90% coverage, and runtime.
//
// Usage: node validation.mjs [--input DIR] [--runs 1|2] [--no-practice]

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, 'main.ts');
const KIT_INPUT = resolve(HERE, '..', '..', 'gta6', 'gta6-twitch-ccu-forecast-01-kit', 'input');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const INPUT_DIR = resolve(opt('--input', KIT_INPUT));
const RUNS = Number(opt('--runs', '2'));
const PRACTICE = !argv.includes('--no-practice');

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const SIGMA = 0.15;
const HOUR_MS = 3_600_000;

const isoHour = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const logFloor = (x) => Math.log(Math.max(1, x));

function pinball(actual, q) {
  let sum = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    const d = logFloor(actual) - Math.log(Math.max(1e-9, q[i]));
    sum += 2 * Math.max(LEVELS[i] * d, (LEVELS[i] - 1) * d);
  }
  return sum / LEVELS.length;
}

function houseQuantiles(p1, hour) {
  return Z.map((z) => p1 * Math.exp(z * SIGMA * Math.sqrt(Math.max(0, hour - 1))));
}

function isValidOutput(obj, id) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return ['not an object'];
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'hours') errors.push(`top-level keys ${JSON.stringify(keys)}`);
  const rows = obj.hours;
  if (!Array.isArray(rows) || rows.length !== 23) {
    errors.push(`hours is not 23 rows`);
    return errors;
  }
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') { errors.push('row not object'); continue; }
    const rk = Object.keys(row).sort().join(',');
    if (rk !== 'hour,q') errors.push(`row keys ${rk}`);
    const h = row.hour;
    if (!Number.isInteger(h) || h < 2 || h > 24) errors.push(`bad hour ${h}`);
    if (seen.has(h)) errors.push(`duplicate hour ${h}`);
    seen.add(h);
    if (!Array.isArray(row.q) || row.q.length !== 5) { errors.push(`hour ${h} q length`); continue; }
    for (let i = 0; i < 5; i++) {
      const v = row.q[i];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1e9) errors.push(`hour ${h} q${i} ${v}`);
      if (i > 0 && v < row.q[i - 1]) errors.push(`hour ${h} q not non-decreasing`);
    }
  }
  if (seen.size !== 23) errors.push(`covered ${seen.size}/23 hours`);
  if (Buffer.byteLength(JSON.stringify(obj)) > 65536) errors.push('output over 65536 bytes');
  return errors;
}

function runEntrypoint(caseObj, workRoot, tag) {
  const inDir = join(workRoot, `${tag}-in`);
  const outDir = join(workRoot, `${tag}-out`);
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const file = `${caseObj.id}.in`;
  writeFileSync(join(inDir, file), JSON.stringify(caseObj));
  const start = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [MAIN], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const outPath = join(outDir, `${caseObj.id}.out`);
  let text = null;
  try { text = readFileSync(outPath, 'utf8'); } catch { /* reported below */ }
  return { status: res.status, stderr: res.stderr, stdout: res.stdout, ms, text };
}

function hourMap(hourly) {
  const map = new Map();
  for (const p of hourly) {
    const t = Date.parse(p.from);
    if (!Number.isFinite(t) || !Number.isFinite(p.viewers)) continue;
    if (!map.has(t)) map.set(t, Math.max(1, p.viewers));
  }
  return map;
}

function comparableCurve(comp) {
  const map = hourMap(comp.hourly);
  const day = Date.parse(comp.day_start);
  const curve = [];
  for (let h = 1; h <= 24; h++) curve.push(map.get(day + (h - 1) * HOUR_MS) ?? null);
  return { day, curve, map };
}

function pseudoCase(comp, pool, id) {
  const { day, curve, map } = comparableCurve(comp);
  const history = [];
  const historyHourly = [];
  const start = day - 14 * 24 * HOUR_MS;
  for (const p of comp.hourly) {
    const t = Date.parse(p.from);
    if (!Number.isFinite(t) || t < start || t > day) continue;
    const v = Math.max(1, p.viewers);
    history.push({ at: isoHour(t), viewers: v, channels: p.channels ?? null });
    historyHourly.push({ from: isoHour(t), viewers: v, channels: p.channels ?? null, reads: 1 });
  }
  history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  historyHourly.sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  const forecast = [];
  for (let h = 2; h <= 24; h++) {
    forecast.push({ hour: h, from: isoHour(day + (h - 1) * HOUR_MS), until: isoHour(day + h * HOUR_MS) });
  }
  const ch = comp.hourly.find((p) => Date.parse(p.from) === day)?.channels ?? null;
  return {
    schema: 'makefun/twitch-ccu-case/v1',
    id,
    game: { name: comp.name, twitch_id: '0' },
    day_start: comp.day_start,
    checkpoint: isoHour(day + HOUR_MS),
    levels: LEVELS,
    known: [{ hour: 1, from: isoHour(day), until: isoHour(day + HOUR_MS), viewers: curve[0], channels: ch, reads: 1 }],
    forecast,
    history,
    history_hourly: historyHourly,
    streams: null,
    categories_hourly: null,
    comparables: pool,
    notes: 'leave-one-comparable-out pseudo-case built by validation.mjs',
  };
}

function main() {
  const practiceFile = join(INPUT_DIR, 'p00.in');
  const source = JSON.parse(readFileSync(practiceFile, 'utf8'));
  const allComps = (source.comparables ?? []).filter((c) => {
    const { curve } = comparableCurve(c);
    return curve[0] != null && curve.slice(0, 24).every((v) => v != null);
  });

  const workRoot = mkdtempSync(join(tmpdir(), 'gta6-forecast-val-'));
  let items = 0;
  let modelLoss = 0;
  let houseLoss = 0;
  let modelMedianAbs = 0;
  let covered = 0;
  let hoursScored = 0;
  let maxMs = 0;
  let failures = 0;
  const perHour = Array.from({ length: 23 }, () => ({ model: 0, house: 0, n: 0 }));

  console.log(`backtest: ${allComps.length} held-out comparable launches, ${LEVELS.length} levels, hours 2..24`);
  for (let i = 0; i < allComps.length; i++) {
    const held = allComps[i];
    const pool = allComps.filter((c) => c !== held).concat(
      (source.comparables ?? []).filter((c) => !allComps.includes(c)),
    );
    const id = `c${String(i).padStart(2, '0')}`;
    const caseObj = pseudoCase(held, pool, id);
    const { day, curve } = comparableCurve(held);
    const first = runEntrypoint(caseObj, workRoot, `${id}-a`);
    maxMs = Math.max(maxMs, first.ms);
    let text = first.text;
    if (first.status !== 0) {
      failures++;
      console.log(`  ${held.name}: run failed (${first.stderr.trim().split('\n')[0]})`);
      continue;
    }
    if (RUNS > 1) {
      const second = runEntrypoint(caseObj, workRoot, `${id}-b`);
      maxMs = Math.max(maxMs, second.ms);
      if (second.text !== text) {
        failures++;
        console.log(`  ${held.name}: non-deterministic output`);
        continue;
      }
    }
    let out;
    try { out = JSON.parse(text); } catch {
      failures++;
      console.log(`  ${held.name}: output is not JSON`);
      continue;
    }
    const schemaErrors = isValidOutput(out, id);
    if (schemaErrors.length > 0) {
      failures++;
      console.log(`  ${held.name}: invalid output (${schemaErrors[0]})`);
      continue;
    }
    const p1 = Math.max(1, curve[0]);
    for (const row of out.hours) {
      const h = row.hour;
      const actual = curve[h - 1];
      if (actual == null) continue;
      const ml = pinball(actual, row.q);
      const hl = pinball(actual, houseQuantiles(p1, h));
      const med = row.q[2];
      modelLoss += ml;
      houseLoss += hl;
      items++;
      perHour[h - 2].model += ml;
      perHour[h - 2].house += hl;
      perHour[h - 2].n++;
      modelMedianAbs += Math.abs(logFloor(actual) - Math.log(Math.max(1e-9, med)));
      if (row.q[0] <= actual && actual <= row.q[4]) covered++;
      hoursScored++;
    }
  }

  console.log(`\nscored items: ${items}`);
  console.log(`model  mean pinball loss : ${(modelLoss / items).toFixed(6)}`);
  console.log(`house  mean pinball loss : ${(houseLoss / items).toFixed(6)}`);
  console.log(`improvement vs house    : ${(100 * (1 - modelLoss / houseLoss)).toFixed(2)}%`);
  console.log(`model  typical miss     : ${(100 * (Math.exp(modelMedianAbs / hoursScored) - 1)).toFixed(2)}%`);
  console.log(`model  90% coverage     : ${(covered / hoursScored).toFixed(4)}`);
  console.log(`max run                 : ${maxMs.toFixed(1)} ms (cap 8000 ms)`);
  console.log(`failures                : ${failures}`);
  console.log('\nper-hour mean loss (hour: model / house)');
  for (let i = 0; i < perHour.length; i++) {
    const p = perHour[i];
    if (p.n === 0) continue;
    console.log(`  ${String(i + 2).padStart(2)}: ${(p.model / p.n).toFixed(4)} / ${(p.house / p.n).toFixed(4)}`);
  }

  if (PRACTICE) {
    console.log('\npractice inputs (schema, determinism, runtime; no local answers exist)');
    for (const id of ['p00', 'p01', 'p02', 'p03']) {
      let caseObj;
      try {
        caseObj = JSON.parse(readFileSync(join(INPUT_DIR, `${id}.in`), 'utf8'));
      } catch {
        console.log(`  ${id}: missing or unreadable`);
        failures++;
        continue;
      }
      const first = runEntrypoint(caseObj, workRoot, `${id}-a`);
      maxMs = Math.max(maxMs, first.ms);
      const second = runEntrypoint(caseObj, workRoot, `${id}-b`);
      maxMs = Math.max(maxMs, second.ms);
      let ok = first.status === 0 && second.status === 0 && first.text === second.text;
      let detail = '';
      if (ok) {
        try {
          const errors = isValidOutput(JSON.parse(first.text), id);
          if (errors.length > 0) { ok = false; detail = errors[0]; }
        } catch { ok = false; detail = 'not JSON'; }
      } else {
        detail = first.stderr.trim().split('\n')[0] || 'run failed or not deterministic';
      }
      if (!ok) failures++;
      console.log(`  ${id}: ${ok ? 'ok' : 'FAIL'} (${first.ms.toFixed(1)} ms, ${second.ms.toFixed(1)} ms)${detail ? ` -- ${detail}` : ''}`);
    }
  }

  if (maxMs >= 8000) {
    console.log(`\nFAIL: a run took ${maxMs.toFixed(1)} ms, at or over the 8000 ms cap`);
    failures++;
  }
  rmSync(workRoot, { recursive: true, force: true });
  if (failures > 0 || items === 0) process.exitCode = 1;
}

main();
