/**
 * Repli sans WebGL : la même sculpture procédurale, projetée une seule fois
 * sur un canvas 2D (image fixe, pas d'animation).
 */
import { generateLichen } from './generate';

const LIGHT = normalize3(-0.48, 0.74, 0.47);

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

export function renderFallback(container: HTMLElement, hazeColor: string, topInset: () => number = () => 0): () => void {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage__canvas stage__canvas--fallback';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    'Sculpture numérique de lichen composée de milliers de particules vert-de-gris, olive et ocre (image fixe).',
  );
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return () => {};
  }

  const data = generateLichen(22000);
  const n = data.count;
  const haze = parseHex(hazeColor);

  // Rotation fixe de trois quarts, comme la pose de départ de la version 3D.
  const ry = -0.18, rx = 0.16;
  const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
  const proj = new Float32Array(n * 3);
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = data.positions[i * 3], y = data.positions[i * 3 + 1], z = data.positions[i * 3 + 2];
    const x1 = cy * x + sy * z;
    const z1 = -sy * x + cy * z;
    const y2 = cx * y - sx * z1;
    const z2 = sx * y + cx * z1;
    proj[i * 3] = x1;
    proj[i * 3 + 1] = y2;
    proj[i * 3 + 2] = z2;
    const nx = data.normals[i * 3], ny = data.normals[i * 3 + 1], nz = data.normals[i * 3 + 2];
    const nx1 = cy * nx + sy * nz;
    const nz1 = -sy * nx + cy * nz;
    const ny2 = cx * ny - sx * nz1;
    const nz2 = sx * ny + cx * nz1;
    const wrap = (nx1 * LIGHT[0] + ny2 * LIGHT[1] + nz2 * LIGHT[2]) * 0.5 + 0.5;
    shade[i] = 0.68 + 0.52 * wrap * wrap;
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => proj[a * 3 + 2] - proj[b * 3 + 2]);

  const draw = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ext = data.extent;
    // Sous la navigation, avec une marge en bas : sur un écran bas, la sculpture descend et rétrécit.
    const inset = topInset();
    const span = ext.y * 1.15;
    const scale = Math.min(
      (w * Math.min(0.47, (w / h < 0.8 ? 0.44 : 0.28) * 1.35)) / ext.x,
      (h * 0.24 * 1.35) / ext.y,
      (h - inset - h * 0.06) / (2 * span),
    );
    const ox = w / 2;
    const oy = Math.max(h * 0.46, inset + span * scale);
    const radius = Math.max(1, 0.0125 * scale);

    for (const i of order) {
      const z = proj[i * 3 + 2];
      const persp = 1 + z * 0.08;
      const px = ox + proj[i * 3] * scale * persp;
      const py = oy - proj[i * 3 + 1] * scale * persp;
      const fog = Math.min(0.5, Math.max(0, -z * 0.22 + 0.05));
      const s = shade[i];
      const r = (data.colors[i * 3] * s * (1 - fog) + haze[0] * fog) * 255;
      const g = (data.colors[i * 3 + 1] * s * (1 - fog) + haze[1] * fog) * 255;
      const b = (data.colors[i * 3 + 2] * s * (1 - fog) + haze[2] * fog) * 255;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.beginPath();
      ctx.arc(px, py, radius * data.params[i * 4 + 2] * persp, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  draw();
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });
  observer.observe(container);

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    canvas.remove();
  };
}

function parseHex(h: string): [number, number, number] {
  const v = parseInt(h.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}
