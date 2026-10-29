/**
 * Génération procédurale de la sculpture de lichen.
 *
 * La forme est construite à partir de :
 *  - une colonne vertébrale courbe (spline Catmull-Rom) au profil d'épaisseur variable,
 *    déformée par du bruit fractal → silhouette asymétrique en croissant ;
 *  - des centaines de lobes foliacés ondulés (disques déformés, bords frisés) ;
 *  - de petites cupules tubulaires et quelques grandes apothécies en coupe ;
 *  - un cœur sombre visible dans les interstices, qui donne la profondeur.
 *
 * La structure ne dépend que de la graine : seul le nombre de particules change
 * selon la puissance de l'appareil, la forme reste identique.
 */
import { createRng, createSimplex3, fbm3 } from './noise';

export interface LichenData {
  count: number;
  /** Position finale de chaque particule (xyz). */
  positions: Float32Array;
  /** Position de départ pour l'animation d'entrée (xyz). */
  starts: Float32Array;
  /** Orientation de la surface locale (xyz, normalisée). */
  normals: Float32Array;
  /** Couleur sRGB, occlusion ambiante déjà appliquée (rgb). */
  colors: Float32Array;
  /** x : phase, y : délai d'apparition, z : taille relative, w : amplitude de frémissement. */
  params: Float32Array;
  /** Demi-étendues de la boîte englobante, après recentrage. */
  extent: { x: number; y: number; z: number };
}

type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const mix = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const hex = (h: string): V3 => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Palette tirée de la référence : thalle vert-de-gris, cupules olive, liserés ocre, cœur brun. */
const PAL = {
  frost: hex('#dfe7da'),
  mint: hex('#c4d7bf'),
  sage: hex('#a2bd9b'),
  lichen: hex('#8ead80'),
  olive: hex('#869650'),
  deepOlive: hex('#5f6934'),
  ochre: hex('#b39a43'),
  bark: hex('#4f4231'),
};

// ---------------------------------------------------------------------------
// Colonne vertébrale : croissant asymétrique, bras gauche fin, masse droite.
// ---------------------------------------------------------------------------
const SPINE: V3[] = [
  [-1.62, 0.2, 0.06],
  [-1.15, 0.12, -0.04],
  [-0.6, -0.08, 0.08],
  [-0.05, -0.2, -0.04],
  [0.5, -0.02, 0.06],
  [0.98, 0.16, -0.06],
  [1.38, 0.1, 0.02],
  [1.6, -0.06, 0.0],
];

/** Épaisseur du corps le long de la colonne (t ∈ [0, 1]). */
const PROFILE_T = [0, 0.07, 0.18, 0.33, 0.46, 0.58, 0.72, 0.86, 0.95, 1];
const PROFILE_R = [0.06, 0.26, 0.36, 0.37, 0.3, 0.44, 0.6, 0.6, 0.38, 0.1];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function spineAt(t: number): V3 {
  const n = SPINE.length - 1;
  const f = clamp(t, 0, 1) * n;
  const i = Math.min(Math.floor(f), n - 1);
  const u = f - i;
  const p0 = SPINE[Math.max(i - 1, 0)];
  const p1 = SPINE[i];
  const p2 = SPINE[i + 1];
  const p3 = SPINE[Math.min(i + 2, n)];
  return [
    catmull(p0[0], p1[0], p2[0], p3[0], u),
    catmull(p0[1], p1[1], p2[1], p3[1], u),
    catmull(p0[2], p1[2], p2[2], p3[2], u),
  ];
}

function profileAt(t: number): number {
  for (let i = 0; i < PROFILE_T.length - 1; i++) {
    if (t <= PROFILE_T[i + 1]) {
      const u = (t - PROFILE_T[i]) / (PROFILE_T[i + 1] - PROFILE_T[i]);
      const s = u * u * (3 - 2 * u);
      return PROFILE_R[i] + (PROFILE_R[i + 1] - PROFILE_R[i]) * s;
    }
  }
  return PROFILE_R[PROFILE_R.length - 1];
}

interface Frame {
  c: V3;
  T: V3;
  up: V3;
  side: V3;
  r: number;
}

function frameAt(t: number): Frame {
  const e = 0.002;
  const c = spineAt(t);
  const T = norm(sub(spineAt(Math.min(1, t + e)), spineAt(Math.max(0, t - e))));
  const worldUp: V3 = [0, 1, 0];
  const up = norm(sub(worldUp, mul(T, dot(worldUp, T))));
  const side = cross(T, up);
  return { c, T, up, side, r: profileAt(t) };
}

interface BodyPoint {
  p: V3;
  n: V3;
  c: V3;
  r: number;
  t: number;
}

// ---------------------------------------------------------------------------

export function generateLichen(count: number, seed = 7): LichenData {
  const structRng = createRng(seed);
  const partRng = createRng(seed * 7919 + 13);
  const noise = createSimplex3(createRng(seed + 101));

  // Échantillonnage de t proportionnel à la surface locale (rayon × longueur d'arc).
  const CDF_N = 512;
  const cdf = new Float32Array(CDF_N + 1);
  {
    let acc = 0;
    let prev = spineAt(0);
    for (let i = 1; i <= CDF_N; i++) {
      const t = i / CDF_N;
      const cur = spineAt(t);
      acc += len(sub(cur, prev)) * (profileAt(t) + 0.05);
      cdf[i] = acc;
      prev = cur;
    }
    for (let i = 0; i <= CDF_N; i++) cdf[i] /= acc;
  }
  const sampleT = (u: number) => {
    let lo = 0;
    let hi = CDF_N;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const f = (u - cdf[i - 1]) / Math.max(1e-6, cdf[i] - cdf[i - 1]);
    return (i - 1 + f) / CDF_N;
  };

  const randUnit = (rng: () => number): V3 => {
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
  };

  /** Point à la surface du corps, déformé par le bruit fractal. */
  const bodyPoint = (t: number, phi: number, shell = 1): BodyPoint => {
    const f = frameAt(t);
    const cy = Math.cos(phi);
    const sz = Math.sin(phi);
    const dir = add(mul(f.up, cy * 1.06), mul(f.side, sz * 0.84));
    const p0 = add(f.c, mul(dir, f.r));
    const lump = 1 + 0.32 * fbm3(noise, p0[0] * 1.6, p0[1] * 1.6, p0[2] * 1.6, 3);
    const rad = f.r * lump * shell;
    const p = add(f.c, mul(dir, rad));
    let n = norm(add(mul(f.up, cy / 1.06), mul(f.side, sz / 0.84)));
    // Aux extrémités, les lobes s'ouvrent dans l'axe : contour effiloché.
    const endBias = -smooth(0.16, 0, t) * 1.3 + smooth(0.84, 1, t) * 1.1;
    n = norm(add(n, mul(f.T, endBias)));
    return { p, n, c: f.c, r: f.r * lump, t };
  };

  const basis = (w: V3, hint: V3): [V3, V3] => {
    let u = sub(hint, mul(w, dot(hint, w)));
    if (len(u) < 1e-3) u = Math.abs(w[1]) < 0.9 ? cross(w, [0, 1, 0]) : cross(w, [1, 0, 0]);
    u = norm(u);
    return [u, cross(w, u)];
  };

  // ---- Structures (dépendent uniquement de la graine) ----------------------
  interface Lobe {
    C: V3; u: V3; v: V3; w: V3; L: number; e: number; k: number;
    ruffle: number; cup: number; a: number[]; base: V3; inner: V3; ochre: number;
    anchor: BodyPoint; area: number;
  }
  interface Tube { B: V3; a: V3; e1: V3; e2: V3; r: number; h: number; anchor: BodyPoint; }
  interface Cup { C: V3; w: V3; u: V3; v: V3; R: number; depth: number; anchor: BodyPoint; a: number[]; }

  const lobes: Lobe[] = [];
  // Lobes moins nombreux mais plus larges : chacun se lit comme une feuille distincte.
  const LOBES = 220;
  for (let i = 0; i < LOBES; i++) {
    const t = sampleT(structRng());
    const bp = bodyPoint(t, structRng() * Math.PI * 2);
    const thick = clamp(bp.r / 0.6, 0.35, 1.25);
    const L = (0.11 + 0.22 * Math.pow(structRng(), 1.5)) * (0.6 + 0.6 * thick);
    // Lobes plutôt couchés sur le corps : ils se chevauchent en écailles lisibles.
    let w = norm(add(mul(bp.n, 0.85), mul(randUnit(structRng), 0.7)));
    if (dot(w, bp.n) < 0) w = mul(w, -1);
    const [u, v] = basis(w, bp.n);
    const C = add(add(bp.p, mul(bp.n, L * 0.25)), mul(u, L * 0.5));
    const greenish = structRng();
    const base =
      greenish < 0.55 ? mix(PAL.mint, PAL.sage, structRng()) :
      greenish < 0.85 ? mix(PAL.sage, PAL.lichen, structRng()) :
      mix(PAL.lichen, PAL.olive, structRng() * 0.8);
    const inner = mix(base, PAL.deepOlive, 0.45 + structRng() * 0.25);
    const e = 0.6 + structRng() * 0.35;
    lobes.push({
      C, u, v, w, L, e,
      k: 5 + Math.floor(structRng() * 7),
      ruffle: 0.06 + structRng() * 0.1,
      cup: -0.12 + structRng() * 0.5,
      a: Array.from({ length: 6 }, () => structRng() * Math.PI * 2),
      base, inner,
      ochre: structRng() < 0.6 ? 0.15 + structRng() * 0.35 : 0.03,
      anchor: bp,
      area: L * L * e,
    });
  }

  const tubes: Tube[] = [];
  const TUBES = 70;
  for (let i = 0; i < TUBES; i++) {
    const t = sampleT(structRng());
    const bp = bodyPoint(t, structRng() * Math.PI * 2);
    const a = norm(add(bp.n, mul(randUnit(structRng), 0.4)));
    const [e1, e2] = basis(a, [0, 1, 0]);
    const lift = 0.05 + structRng() * 0.11;
    tubes.push({
      B: add(bp.p, mul(bp.n, lift)),
      a, e1, e2,
      r: 0.034 + Math.pow(structRng(), 1.4) * 0.04,
      h: 0.05 + structRng() * 0.06,
      anchor: bp,
    });
  }

  const cups: Cup[] = [];
  const CUP_SPOTS: Array<[number, number, number]> = [
    // t, phi, rayon — phi ≈ 0 : dessus ; > 0 : vers l'avant
    [0.58, 0.5, 0.17],
    [0.76, 0.15, 0.21],
    [0.3, -0.8, 0.13],
    [0.86, 2.4, 0.15],
    [0.44, 3.6, 0.12],
  ];
  for (const [t, phi, R] of CUP_SPOTS) {
    const bp = bodyPoint(t, phi);
    const w = norm(add(bp.n, mul(randUnit(structRng), 0.25)));
    const [u, v] = basis(w, [1, 0, 0]);
    cups.push({
      C: add(bp.p, mul(bp.n, 0.1)),
      w, u, v, R, depth: R * (0.32 + structRng() * 0.12), anchor: bp,
      a: Array.from({ length: 4 }, () => structRng() * Math.PI * 2),
    });
  }

  // ---- Répartition du budget de particules ---------------------------------
  const nCore = Math.round(count * 0.11);
  const nCups = Math.round(count * 0.06);
  const nTubes = Math.round(count * 0.1);
  const nLobes = count - nCore - nCups - nTubes;

  const positions = new Float32Array(count * 3);
  const starts = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const params = new Float32Array(count * 4);
  let idx = 0;

  const push = (p: V3, n: V3, col: V3, ao: number, size: number, flutter: number, growth: number) => {
    if (idx >= count) return;
    const i3 = idx * 3;
    const i4 = idx * 4;
    positions[i3] = p[0];
    positions[i3 + 1] = p[1];
    positions[i3 + 2] = p[2];
    normals[i3] = n[0];
    normals[i3 + 1] = n[1];
    normals[i3 + 2] = n[2];
    // Légère variation individuelle de teinte : matière vivante, jamais uniforme.
    const jitter = 0.94 + partRng() * 0.12;
    colors[i3] = clamp(col[0] * ao * jitter, 0, 1);
    colors[i3 + 1] = clamp(col[1] * ao * jitter, 0, 1);
    colors[i3 + 2] = clamp(col[2] * ao * jitter, 0, 1);
    // Départ : poussière dispersée sur une large coquille, légèrement aplatie.
    const d = randUnit(partRng);
    const R = 3.2 + partRng() * 3.2;
    starts[i3] = d[0] * R * 1.25;
    starts[i3 + 1] = d[1] * R * 0.8;
    starts[i3 + 2] = d[2] * R - 0.5;
    params[i4] = partRng();
    params[i4 + 1] = clamp(0.55 * partRng() + 0.45 * growth, 0, 1);
    params[i4 + 2] = size;
    params[i4 + 3] = flutter;
    idx++;
  };

  /** Occlusion ambiante : plus la particule est proche de l'axe du corps, plus elle est sombre. */
  const aoFor = (p: V3, a: BodyPoint) => {
    const f = len(sub(p, a.c)) / Math.max(0.05, a.r);
    return { ao: clamp(0.62 + 0.45 * (f - 0.7) / 0.7, 0.62, 1.05), growth: clamp((f - 0.5) / 1.3, 0, 1) };
  };

  // ---- Lobes foliacés ------------------------------------------------------
  {
    const totalArea = lobes.reduce((s, l) => s + l.area, 0);
    let remaining = nLobes;
    lobes.forEach((lobe, li) => {
      const n = li === lobes.length - 1 ? remaining : Math.round((nLobes * lobe.area) / totalArea);
      remaining -= n;
      const { C, u, v, w, L, e, k, ruffle, cup, a } = lobe;
      const height = (rho: number, th: number) =>
        L * (cup * rho * rho + ruffle * Math.pow(rho, 2.2) * Math.sin(k * th + a[3]) * (1 + 0.35 * Math.sin(2 * k * th + a[4])));
      const radius = (th: number) =>
        L * (1 + 0.2 * Math.sin(3 * th + a[0]) + 0.1 * Math.sin(5 * th + a[1]) + 0.05 * Math.sin(11 * th + a[2]));
      const surf = (rho: number, th: number): V3 => {
        const R = radius(th) * rho;
        return add(add(add(C, mul(u, R * Math.cos(th))), mul(v, R * Math.sin(th) * e)), mul(w, height(rho, th)));
      };
      for (let j = 0; j < n; j++) {
        const th = partRng() * Math.PI * 2;
        // Répartition uniforme sur la surface du lobe : une feuille pleine, au contour net.
        const rho = Math.sqrt(partRng());
        const p = surf(rho, th);
        // Normale analytique approchée par différences finies sur la surface ondulée.
        const pr = surf(Math.min(1, rho + 0.03), th);
        const pt = surf(Math.max(0.05, rho), th + 0.03);
        let nrm = norm(cross(sub(pr, p), sub(pt, p)));
        if (dot(nrm, w) < 0) nrm = mul(nrm, -1);
        if (!isFinite(nrm[0])) nrm = w;
        const { ao, growth } = aoFor(p, lobe.anchor);
        let col = mix(lobe.inner, lobe.base, smooth(0.05, 0.8, rho));
        // Liseré clair, parfois ocre : c'est lui qui dessine le contour frisé de chaque lobe.
        const rim = rho > 0.84;
        if (rim) {
          // L'ocre suit des arcs continus du bord, comme sur le thalle réel, plutôt que des points épars.
          const arc = Math.sin(2 * th + a[5]) > 1 - lobe.ochre * 2.2;
          col = arc && partRng() < 0.8 ? mix(PAL.ochre, PAL.olive, partRng() * 0.35) : mix(col, PAL.frost, 0.72);
        }
        push(p, nrm, col, ao, rim ? 0.82 : 0.9 + partRng() * 0.25, (0.004 + 0.014 * rho * rho) * (L / 0.2), growth);
      }
    });
  }

  // ---- Cupules tubulaires --------------------------------------------------
  {
    const per = Math.max(6, Math.floor(nTubes / tubes.length));
    for (let ti = 0; ti < tubes.length && idx < count; ti++) {
      const tb = tubes[ti];
      const n = ti === tubes.length - 1 ? nTubes - per * (tubes.length - 1) : per;
      for (let j = 0; j < n; j++) {
        const ang = partRng() * Math.PI * 2;
        const radial = add(mul(tb.e1, Math.cos(ang)), mul(tb.e2, Math.sin(ang)));
        const kind = partRng();
        let p: V3;
        let nrm: V3;
        let col: V3;
        let size = 0.8;
        if (kind < 0.42) {
          // Lèvre : anneau clair et dense, très lisible.
          const rr = tb.r * (1 + (partRng() - 0.5) * 0.18);
          p = add(add(tb.B, mul(tb.a, tb.h + (partRng() - 0.5) * 0.008)), mul(radial, rr));
          nrm = norm(add(tb.a, mul(radial, 0.6)));
          col = mix(PAL.frost, PAL.mint, partRng() * 0.4);
          size = 0.62;
        } else if (kind < 0.72) {
          const hh = partRng() * tb.h;
          p = add(add(tb.B, mul(tb.a, hh)), mul(radial, tb.r * (0.92 + partRng() * 0.1)));
          nrm = radial;
          col = mix(PAL.sage, PAL.mint, hh / tb.h);
        } else {
          // Fond de la cupule : olive, en retrait.
          const rr = tb.r * Math.sqrt(partRng()) * 0.86;
          p = add(add(tb.B, mul(tb.a, tb.h * 0.45)), mul(radial, rr));
          nrm = tb.a;
          col = mix(PAL.olive, PAL.deepOlive, partRng() * 0.6);
        }
        const { ao, growth } = aoFor(p, tb.anchor);
        push(p, nrm, col, Math.max(ao, 0.82), size, 0.004, Math.min(1, growth + 0.2));
      }
    }
  }

  // ---- Grandes apothécies en coupe ----------------------------------------
  {
    const per = Math.floor(nCups / cups.length);
    cups.forEach((cp, ci) => {
      const n = ci === cups.length - 1 ? nCups - per * (cups.length - 1) : per;
      for (let j = 0; j < n; j++) {
        const th = partRng() * Math.PI * 2;
        const wav = 1 + 0.06 * Math.sin(4 * th + cp.a[0]) + 0.04 * Math.sin(9 * th + cp.a[1]);
        const isRim = partRng() < 0.36;
        let rho: number;
        let h: number;
        let col: V3;
        if (isRim) {
          rho = (0.94 + partRng() * 0.12) * wav;
          h = cp.depth + (partRng() - 0.5) * cp.R * 0.12 + 0.02 * Math.sin(7 * th + cp.a[2]);
          col = mix(PAL.frost, PAL.mint, partRng() * 0.5);
        } else {
          rho = Math.sqrt(partRng()) * 0.93 * wav;
          h = cp.depth * rho * rho;
          const tex = fbm3(noise, Math.cos(th) * rho * 6 + ci * 3, Math.sin(th) * rho * 6, ci, 2);
          col = mix(PAL.deepOlive, PAL.olive, clamp(0.45 + tex * 0.9 + rho * 0.25, 0, 1));
        }
        const R = cp.R * rho;
        const p = add(add(add(cp.C, mul(cp.u, R * Math.cos(th))), mul(cp.v, R * Math.sin(th))), mul(cp.w, h));
        // Normale du bol : tournée vers l'intérieur et le haut.
        const radial = add(mul(cp.u, Math.cos(th)), mul(cp.v, Math.sin(th)));
        const nrm = isRim ? norm(add(cp.w, mul(radial, 0.5))) : norm(sub(cp.w, mul(radial, 2 * cp.depth * rho / cp.R)));
        const { growth } = aoFor(p, cp.anchor);
        push(p, nrm, col, 1, isRim ? 0.85 : 0.95, isRim ? 0.006 : 0.002, Math.min(1, growth + 0.25));
      }
    });
  }

  // ---- Cœur sombre ---------------------------------------------------------
  while (idx < count) {
    const t = sampleT(partRng());
    // Plus profond et d'un ton d'ombre régulier : les interstices se lisent comme des creux, pas comme du bruit.
    const shell = 0.45 + Math.pow(partRng(), 0.6) * 0.33;
    const bp = bodyPoint(t, partRng() * Math.PI * 2, shell);
    const col = mix(PAL.bark, PAL.deepOlive, 0.45 + partRng() * 0.3);
    push(bp.p, bp.n, col, 0.7 + shell * 0.15, 1.0, 0, 0);
  }

  // ---- Recentrage ----------------------------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  for (let i = 0; i < count; i++) {
    positions[i * 3] -= cx;
    positions[i * 3 + 1] -= cy;
    positions[i * 3 + 2] -= cz;
  }

  // ---- Mélange : réduire le nombre de particules affichées (drawRange)
  // éclaircit la forme uniformément au lieu de supprimer des régions entières.
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(partRng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const permute = (src: Float32Array, stride: number) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < count; i++) {
      const from = order[i] * stride;
      const to = i * stride;
      for (let s = 0; s < stride; s++) out[to + s] = src[from + s];
    }
    return out;
  };

  return {
    count,
    positions: permute(positions, 3),
    starts: permute(starts, 3),
    normals: permute(normals, 3),
    colors: permute(colors, 3),
    params: permute(params, 4),
    extent: { x: (maxX - minX) / 2, y: (maxY - minY) / 2, z: (maxZ - minZ) / 2 },
  };
}
