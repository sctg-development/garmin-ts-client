/**
 * Descent analysis from the altitude series of a FIT file.
 *
 * The activity summary gives one number (metres lost). For muscular load that is not enough: the same 500 m of descent
 * is far harder on the legs over 2 km than over 8 km, because lengthening contractions grow with the downhill grade
 * (Vernillo 2017). This module walks the altitude trace in fixed horizontal steps, ignores flat noise, and returns the
 * descent split by grade plus a grade-weighted "eccentric units" figure.
 *
 * The weighting is a plugin convention, not a validated model: 1 unit per metre on gentle slopes (under 8 %), rising
 * linearly to 1.5 units per metre at 20 % and beyond. Barometric altitude is smooth; GPS altitude is noisy, which the
 * step averaging and the flat-noise deadband absorb. Every figure is derived from the file: nothing is estimated.
 *
 * Calibration (three real trail runs on a flat, undulating course, device descent 172 / 33 / 50 m): with 15 m steps and
 * a 1 % deadband this gives 104 / 31 / 56 m. The device counts every micro-undulation of the barometer, so it reads
 * higher on a course full of small bumps; smaller steps detect short steep slopes but make the grade of each step noisy
 * (altitude resolution is 0.2 m), larger steps blur them. 15 m is the compromise.
 */
import type { FitFile, FitRecord } from "./fit.ts";

/** Horizontal distance of one analysis step, in metres. */
export const STEP_M = 15;
/** Steps flatter than this (percent) are noise, not terrain, and count as neither ascent nor descent. */
export const DEADBAND_PCT = 1.0;
/** Downhill grade from which a descent counts as steep, in percent. */
export const STEEP_PCT = 15;
export const GENTLE_PCT = 8;
export const MAX_WEIGHT_PCT = 20;
export const MAX_WEIGHT = 1.5;
/** Fewer usable samples than this and the file is not analysed. */
export const MIN_SAMPLES = 20;

export type DescentAnalysis = {
  descentM: number;
  ascentM: number;
  /** Metres of descent on a downhill grade of STEEP_PCT or more. */
  steepDescentM: number;
  /** Grade-weighted descent: the eccentric load in "metres of gentle descent". */
  eccentricUnits: number;
  /** Mean grade of the descent, percent (positive number), or null without descent. */
  meanDescentGradePct: number | null;
  distanceM: number;
  samples: number;
  /** The descent the device wrote in the session summary, for comparison (null when absent). */
  deviceDescentM: number | null;
};

/** Weight of one metre of descent at a downhill grade `pct` (positive for downhill). */
export function descentWeight(pct: number): number {
  if (pct <= GENTLE_PCT) return 1;
  if (pct >= MAX_WEIGHT_PCT) return MAX_WEIGHT;
  return 1 + ((MAX_WEIGHT - 1) * (pct - GENTLE_PCT)) / (MAX_WEIGHT_PCT - GENTLE_PCT);
}

/** Median of up to `width` values around each index (odd width): removes single-sample altitude spikes. */
function smooth(values: number[], width = 5): number[] {
  const half = Math.floor(width / 2);
  return values.map((_, i) => {
    const window = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1)).sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)] as number;
  });
}

/** Cumulative distance of each record: the recorded distance when present, else integrated from speed and time. */
function distances(records: FitRecord[]): number[] {
  const out: number[] = [];
  let last = 0;
  let lastTime: number | null = null;
  for (const r of records) {
    let d = r.distanceM;
    if (d === null) {
      const dt = r.timeMs !== null && lastTime !== null ? (r.timeMs - lastTime) / 1000 : 0;
      d = last + (r.speedMs ?? 0) * Math.max(0, Math.min(dt, 10));
    }
    d = Math.max(d, last); // distance never goes backwards
    out.push(d);
    last = d;
    if (r.timeMs !== null) lastTime = r.timeMs;
  }
  return out;
}

/** @returns the analysis, or null when the file has too little altitude data to say anything. */
export function analyzeDescent(file: FitFile, options: { stepM?: number; deadbandPct?: number } = {}): DescentAnalysis | null {
  const stepM = options.stepM ?? STEP_M;
  const deadband = options.deadbandPct ?? DEADBAND_PCT;
  const usable = file.records.filter((r) => r.altitudeM !== null);
  if (usable.length < MIN_SAMPLES) return null;
  const alt = smooth(usable.map((r) => r.altitudeM as number));
  const dist = distances(usable);
  let descent = 0;
  let ascent = 0;
  let steep = 0;
  let eccentric = 0;
  let descentRun = 0; // horizontal metres spent descending, for the mean grade
  // A step is the stretch of the track covering at least STEP_M metres. Its altitude and position are the MEAN of its
  // samples, so measurement noise (which is not correlated from one sample to the next) averages out instead of being
  // counted as terrain; the terrain is the difference between successive steps.
  let previous: { alt: number; dist: number } | null = null;
  let sumAlt = 0;
  let sumDist = 0;
  let count = 0;
  let stepStart = dist[0] as number;
  for (let i = 0; i < usable.length; i += 1) {
    sumAlt += alt[i] as number;
    sumDist += dist[i] as number;
    count += 1;
    if ((dist[i] as number) - stepStart < stepM) continue;
    const step = { alt: sumAlt / count, dist: sumDist / count };
    sumAlt = 0;
    sumDist = 0;
    count = 0;
    stepStart = dist[i] as number;
    if (!previous) {
      previous = step;
      continue;
    }
    const run = step.dist - previous.dist;
    const delta = step.alt - previous.alt;
    previous = step;
    if (run <= 0) continue;
    const pct = (delta / run) * 100;
    if (Math.abs(pct) < deadband) continue;
    if (delta > 0) {
      ascent += delta;
      continue;
    }
    const loss = -delta;
    const down = -pct;
    descent += loss;
    descentRun += run;
    eccentric += loss * descentWeight(down);
    if (down >= STEEP_PCT) steep += loss;
  }
  const total = dist[dist.length - 1] as number;
  return {
    descentM: Math.round(descent),
    ascentM: Math.round(ascent),
    steepDescentM: Math.round(steep),
    eccentricUnits: Math.round(eccentric),
    meanDescentGradePct: descentRun > 0 ? Math.round((descent / descentRun) * 1000) / 10 : null,
    distanceM: Math.round(total),
    samples: usable.length,
    deviceDescentM: file.sessions.find((s) => s.totalDescentM !== null)?.totalDescentM ?? null,
  };
}
