import { App, TFile, TFolder } from "obsidian";
import { FSRS_DEFAULT_WEIGHTS, parseReviewLog, type ParsedLogEntry } from "./leitner";

// Self-contained parameterized FSRS replay so optimization doesn't have to
// mutate the active weights in leitner.ts mid-run (which would race with the
// rest of the plugin reading them).

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1;
const S_MIN = 0.1;
const S_MAX = 36500;
const D_MIN = 1;
const D_MAX = 10;
const GRADE_CORRECT = 3;
const GRADE_WRONG = 1;
const MS_PER_DAY = 86400000;
const EPS = 1e-7;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function retrievability(elapsedDays: number, S: number): number {
  return Math.pow(1 + (FACTOR * elapsedDays) / Math.max(S, S_MIN), DECAY);
}

function initDFromGrade(W: ArrayLike<number>, grade: number): number {
  return clamp(W[4] - Math.exp(W[5] * (grade - 1)) + 1, D_MIN, D_MAX);
}

function initS(W: ArrayLike<number>, correct: boolean): number {
  return clamp(W[correct ? GRADE_CORRECT - 1 : GRADE_WRONG - 1], S_MIN, S_MAX);
}

function initD(W: ArrayLike<number>, correct: boolean): number {
  return initDFromGrade(W, correct ? GRADE_CORRECT : GRADE_WRONG);
}

function updS(W: ArrayLike<number>, S: number, D: number, correct: boolean, R: number): number {
  const s = clamp(S, S_MIN, S_MAX);
  const d = clamp(D, D_MIN, D_MAX);
  const r = clamp(R, 0.001, 0.999);
  if (correct) {
    const growth = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1);
    return clamp(s * (1 + growth), S_MIN, S_MAX);
  }
  const lapsed = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return clamp(Math.min(lapsed, s), S_MIN, S_MAX);
}

function updD(W: ArrayLike<number>, D: number, correct: boolean): number {
  const d = clamp(D, D_MIN, D_MAX);
  const g = correct ? GRADE_CORRECT : GRADE_WRONG;
  const deltaD = -W[6] * (g - 3);
  const damped = d + (deltaD * (10 - d)) / 9;
  const target = initDFromGrade(W, 4);
  const blend = clamp(W[7], 0, 1);
  const reverted = blend * target + (1 - blend) * damped;
  return clamp(reverted, D_MIN, D_MAX);
}

export interface CardLog {
  entries: ParsedLogEntry[];
}

/** Mean log-loss across all post-first reviews. Returns Infinity if no samples. */
export function meanLogLoss(W: ArrayLike<number>, cards: CardLog[]): number {
  let loss = 0;
  let samples = 0;
  for (const card of cards) {
    if (card.entries.length < 2) continue;
    const e0 = card.entries[0];
    let S = initS(W, e0.correct);
    let D = initD(W, e0.correct);
    let prevT = e0.timestamp;
    for (let i = 1; i < card.entries.length; i++) {
      const e = card.entries[i];
      const elapsed = Math.max(0, (e.timestamp - prevT) / MS_PER_DAY);
      const R = clamp(retrievability(elapsed, S), EPS, 1 - EPS);
      const y = e.correct ? 1 : 0;
      loss += -(y * Math.log(R) + (1 - y) * Math.log(1 - R));
      samples++;
      S = updS(W, S, D, e.correct, R);
      D = updD(W, D, e.correct);
      prevT = e.timestamp;
    }
  }
  return samples === 0 ? Infinity : loss / samples;
}

export function collectCardLogs(app: App, cardsFolder: string): CardLog[] {
  const folder = app.vault.getAbstractFileByPath(cardsFolder);
  if (!folder || !(folder instanceof TFolder)) return [];
  const out: CardLog[] = [];
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const fm = app.metadataCache.getFileCache(child)?.frontmatter;
    if (!fm) continue;
    const entries = parseReviewLog(fm);
    if (entries.length >= 2) out.push({ entries });
  }
  return out;
}

export function countSamples(cards: CardLog[]): number {
  let n = 0;
  for (const c of cards) n += Math.max(0, c.entries.length - 1);
  return n;
}

// ───────────────────────── CMA-ES ─────────────────────────

function identity(n: number): number[][] {
  const m: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(0);
    row[i] = 1;
    m.push(row);
  }
  return m;
}

function matVec(M: number[][], v: number[]): number[] {
  const n = M.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += M[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

function matTVec(M: number[][], v: number[]): number[] {
  const n = M.length;
  const out = new Array(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += M[i][j] * v[i];
    out[j] = s;
  }
  return out;
}

// Standard normal samples via Box-Muller.
function randn(n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const u1 = Math.max(Math.random(), 1e-12);
    const u2 = Math.random();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    if (out.length < n) out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out;
}

// Jacobi eigenvalue method for symmetric matrices. Produces orthogonal V and
// real eigenvalues such that A = V diag(values) V^T. n=17 → trivially fast.
function jacobiEig(A: number[][]): { values: number[]; vectors: number[][] } {
  const n = A.length;
  const a: number[][] = A.map(row => row.slice());
  const v = identity(n);
  const maxSweeps = 100;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++)
      for (let q = p + 1; q < n; q++)
        off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        let t: number;
        if (Math.abs(theta) > 1e10) {
          t = 1 / (2 * theta);
        } else {
          const sign = theta >= 0 ? 1 : -1;
          t = sign / (Math.abs(theta) + Math.sqrt(1 + theta * theta));
        }
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        const tau = s / (1 + c);
        a[p][p] -= t * apq;
        a[q][q] += t * apq;
        a[p][q] = 0;
        a[q][p] = 0;
        for (let r = 0; r < n; r++) {
          if (r !== p && r !== q) {
            const arp = a[r][p];
            const arq = a[r][q];
            a[r][p] = arp - s * (arq + tau * arp);
            a[r][q] = arq + s * (arp - tau * arq);
            a[p][r] = a[r][p];
            a[q][r] = a[r][q];
          }
          const vrp = v[r][p];
          const vrq = v[r][q];
          v[r][p] = vrp - s * (vrq + tau * vrp);
          v[r][q] = vrq + s * (vrp - tau * vrq);
        }
      }
    }
  }
  const values = a.map((row, i) => row[i]);
  return { values, vectors: v };
}

export interface OptimizeOptions {
  initialMean?: number[];
  initialSigma?: number;
  popSize?: number;
  maxIter?: number;
  tolFun?: number;
  signal?: AbortSignal;
  onProgress?: (gen: number, bestF: number, sigma: number) => void;
}

export interface OptimizeResult {
  weights: number[];
  loss: number;
  iter: number;
  samples: number;
  baselineLoss: number;
  stopped: "converged" | "maxIter" | "aborted";
}

/**
 * (μ/μ_w, λ)-CMA-ES in log-parameter space (W_i = exp(x_i)) so weights stay
 * positive and the search is scale-invariant. Default weights map to x = 0.
 */
export async function optimizeFSRS(
  cards: CardLog[],
  opts: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const samples = countSamples(cards);
  const baselineLoss = meanLogLoss(FSRS_DEFAULT_WEIGHTS, cards);

  const dim = FSRS_DEFAULT_WEIGHTS.length;
  const logDefault = FSRS_DEFAULT_WEIGHTS.map(w => Math.log(w));
  const initMean = opts.initialMean ?? logDefault;
  let sigma = opts.initialSigma ?? 0.3;
  const lambda = opts.popSize ?? (4 + Math.floor(3 * Math.log(dim)));
  const mu = Math.floor(lambda / 2);
  const maxIter = opts.maxIter ?? 200;
  const tolFun = opts.tolFun ?? 1e-7;

  // Recombination weights (positive only — μ best).
  const wRaw: number[] = [];
  for (let i = 0; i < mu; i++) wRaw.push(Math.log(mu + 0.5) - Math.log(i + 1));
  const wSum = wRaw.reduce((s, x) => s + x, 0);
  const wRec = wRaw.map(x => x / wSum);
  const muEff = 1 / wRec.reduce((s, x) => s + x * x, 0);

  // Strategy parameters (Hansen 2016 tutorial).
  const cSigma = (muEff + 2) / (dim + muEff + 5);
  const dSigma =
    1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (dim + 1)) - 1) + cSigma;
  const cc = (4 + muEff / dim) / (dim + 4 + (2 * muEff) / dim);
  const c1 = 2 / ((dim + 1.3) ** 2 + muEff);
  const cMu = Math.min(
    1 - c1,
    (2 * (muEff - 2 + 1 / muEff)) / ((dim + 2) ** 2 + muEff),
  );
  const expectedNorm =
    Math.sqrt(dim) * (1 - 1 / (4 * dim) + 1 / (21 * dim * dim));

  let m = initMean.slice();
  let pSigma = new Array(dim).fill(0);
  let pC = new Array(dim).fill(0);
  let C = identity(dim);
  let B = identity(dim);
  let DvecStability = new Array(dim).fill(1);

  // toW: transform from log-space x to W vector (strict positivity).
  const toW = (x: number[]): number[] => x.map(xi => Math.exp(xi));

  let bestX = m.slice();
  let bestF = meanLogLoss(toW(m), cards);
  let prevBestF = bestF;
  let stopped: OptimizeResult["stopped"] = "maxIter";
  let lastEigenGen = -Infinity;
  // Hansen recommends re-eigendecomposing only every ≈n/(c1+cμ)/10 generations.
  const eigenInterval = Math.max(
    1,
    Math.floor(dim / (10 * (c1 + cMu))),
  );

  let gen = 0;
  for (; gen < maxIter; gen++) {
    if (opts.signal?.aborted) {
      stopped = "aborted";
      break;
    }

    if (gen - lastEigenGen >= eigenInterval) {
      // Symmetrize before eigendecomp to suppress accumulated numerical asymmetry.
      for (let i = 0; i < dim; i++)
        for (let j = i + 1; j < dim; j++) {
          const avg = 0.5 * (C[i][j] + C[j][i]);
          C[i][j] = avg;
          C[j][i] = avg;
        }
      const ev = jacobiEig(C);
      B = ev.vectors;
      DvecStability = ev.values.map(v => Math.sqrt(Math.max(v, 1e-20)));
      lastEigenGen = gen;
    }

    // Sample λ offspring.
    interface Sample { x: number[]; f: number }
    const offspring: Sample[] = [];
    for (let i = 0; i < lambda; i++) {
      const z = randn(dim);
      const dz = z.map((zi, j) => zi * DvecStability[j]);
      const y = matVec(B, dz);
      const x = m.map((mi, j) => mi + sigma * y[j]);
      const f = meanLogLoss(toW(x), cards);
      offspring.push({ x, f });
    }
    offspring.sort((a, b) => a.f - b.f);

    if (offspring[0].f < bestF) {
      bestF = offspring[0].f;
      bestX = offspring[0].x.slice();
    }

    // New mean: weighted recombination of best μ.
    const mNew = new Array(dim).fill(0);
    for (let i = 0; i < mu; i++) {
      for (let j = 0; j < dim; j++) {
        mNew[j] += wRec[i] * offspring[i].x[j];
      }
    }

    // y_w = (mNew - m) / σ
    const yW = mNew.map((v, j) => (v - m[j]) / sigma);

    // C^{-1/2} y_w = B D^{-1} B^T y_w
    const BTyW = matTVec(B, yW);
    const DinvBTyW = BTyW.map((v, j) => v / DvecStability[j]);
    const CinvHalfYw = matVec(B, DinvBTyW);

    // p_σ ← (1-c_σ) p_σ + √(c_σ(2-c_σ)μ_eff) C^{-1/2} y_w
    const sqrtCsig = Math.sqrt(cSigma * (2 - cSigma) * muEff);
    pSigma = pSigma.map((p, j) => (1 - cSigma) * p + sqrtCsig * CinvHalfYw[j]);
    const pSigmaNorm = Math.sqrt(pSigma.reduce((s, x) => s + x * x, 0));

    // h_σ stalls rank-1 update when |p_σ| is suspiciously large.
    const hSig =
      pSigmaNorm /
        Math.sqrt(1 - Math.pow(1 - cSigma, 2 * (gen + 1))) /
        expectedNorm <
      1.4 + 2 / (dim + 1)
        ? 1
        : 0;

    // p_c update.
    const sqrtCc = Math.sqrt(cc * (2 - cc) * muEff);
    pC = pC.map((p, j) => (1 - cc) * p + hSig * sqrtCc * yW[j]);

    // Rank-μ matrix from y_k = (x_k - m) / σ.
    const yK: number[][] = [];
    for (let i = 0; i < mu; i++) {
      yK.push(offspring[i].x.map((v, j) => (v - m[j]) / sigma));
    }

    // Covariance update.
    const deltaH = (1 - hSig) * cc * (2 - cc);
    const newC: number[][] = [];
    for (let i = 0; i < dim; i++) {
      const row = new Array(dim);
      for (let j = 0; j < dim; j++) {
        let cij = (1 - c1 - cMu) * C[i][j];
        cij += c1 * (pC[i] * pC[j] + deltaH * C[i][j]);
        let rankMu = 0;
        for (let k = 0; k < mu; k++) {
          rankMu += wRec[k] * yK[k][i] * yK[k][j];
        }
        cij += cMu * rankMu;
        row[j] = cij;
      }
      newC.push(row);
    }
    C = newC;

    // Step-size update.
    sigma *= Math.exp((cSigma / dSigma) * (pSigmaNorm / expectedNorm - 1));
    sigma = clamp(sigma, 1e-8, 10);

    m = mNew;
    opts.onProgress?.(gen, bestF, sigma);

    if (gen > 10 && Math.abs(prevBestF - bestF) < tolFun && sigma < 1e-3) {
      stopped = "converged";
      gen++;
      break;
    }
    prevBestF = bestF;

    // Yield to keep the UI responsive every few generations.
    if (gen % 3 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return {
    weights: toW(bestX),
    loss: bestF,
    iter: gen,
    samples,
    baselineLoss,
    stopped,
  };
}
