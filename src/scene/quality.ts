/**
 * Choix du niveau de rendu selon l'appareil, puis ajustement dynamique
 * de la densité de particules d'après le temps de rendu réellement mesuré.
 */

export type TierName = 'high' | 'medium' | 'low';

export interface Tier {
  name: TierName;
  /** Nombre maximal de particules générées. */
  particles: number;
  /** Plancher sous lequel l'ajustement dynamique ne descend pas. */
  minParticles: number;
  maxPixelRatio: number;
  antialias: boolean;
  /** Profondeur de champ simulée dans le shader. */
  dof: boolean;
  /** Écartement des particules sous le curseur. */
  hover: boolean;
  /** Ombre portée diffuse sous la sculpture. */
  shadow: boolean;
}

const TIERS: Record<TierName, Tier> = {
  high: { name: 'high', particles: 60000, minParticles: 22000, maxPixelRatio: 2, antialias: true, dof: true, hover: true, shadow: true },
  medium: { name: 'medium', particles: 28000, minParticles: 12000, maxPixelRatio: 1.75, antialias: true, dof: false, hover: true, shadow: true },
  low: { name: 'low', particles: 13000, minParticles: 7000, maxPixelRatio: 1, antialias: false, dof: false, hover: false, shadow: false },
};

interface NavigatorHints extends Navigator {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

export function getTier(name: TierName): Tier {
  return TIERS[name];
}

/** Estimation avant la création du contexte WebGL (indices du navigateur seuls). */
export function guessTier(): Tier {
  const nav = navigator as NavigatorHints;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 8;
  if (nav.connection?.saveData || cores <= 2 || memory <= 2) return TIERS.low;
  if (coarse || small || cores <= 4 || memory <= 4) return TIERS.medium;
  return TIERS.high;
}

/** Affinage une fois le contexte créé : un rendu logiciel ou un GPU d'entrée de gamme rétrograde le niveau. */
export function refineTier(base: Tier, gl: WebGLRenderingContext | WebGL2RenderingContext): Tier {
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    renderer = '';
  }
  if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) return TIERS.low;
  if (base.name === 'high' && /intel.*(hd|uhd) graphics [0-9]{3}\b|mali-[gt][0-9]{2}\b|adreno.*[0-5][0-9]{2}\b/i.test(renderer)) {
    return TIERS.medium;
  }
  return base;
}

/**
 * Contrôleur adaptatif : moyenne glissante du temps de frame,
 * baisse rapide si l'animation saccade, remontée prudente si la marge est confortable.
 */
export class AdaptiveQuality {
  private ema = 1 / 60;
  private sinceChange = 0;
  private lastDowngrade = -Infinity;
  private clock = 0;
  private ceiling: number;
  count: number;
  pixelRatio: number;

  constructor(
    private readonly tier: Tier,
    maxCount: number,
    devicePixelRatio: number,
    private readonly onChange: (count: number, pixelRatio: number) => void,
  ) {
    this.ceiling = maxCount;
    this.count = maxCount;
    this.pixelRatio = Math.min(devicePixelRatio, tier.maxPixelRatio);
  }

  /** À appeler à chaque frame, une fois l'animation d'entrée terminée. */
  sample(dt: number): void {
    // Les longues pauses (onglet masqué) ne doivent pas fausser la mesure.
    if (dt > 0.25) return;
    this.clock += dt;
    this.sinceChange += dt;
    this.ema += (dt - this.ema) * 0.06;
    if (this.sinceChange < 1.5) return;

    const slow = this.ema > 1 / 44;
    // Sur un écran 60 Hz, le rendu est plafonné à ~16,7 ms : « confortable » = synchro tenue.
    const comfortable = this.ema < 1 / 57;

    if (slow) {
      if (this.pixelRatio > 1.25) {
        this.pixelRatio = Math.max(1, this.pixelRatio - 0.5);
      } else if (this.count > this.tier.minParticles) {
        // Mémorise la densité qui a posé problème pour ne jamais y remonter (pas d'oscillation).
        this.ceiling = Math.min(this.ceiling, Math.round(this.count * 0.9));
        this.count = Math.max(this.tier.minParticles, Math.round(this.count * 0.72));
      } else {
        return;
      }
      this.lastDowngrade = this.clock;
      this.commit();
    } else if (comfortable && this.clock - this.lastDowngrade > 10 && this.count < this.ceiling) {
      this.count = Math.min(this.ceiling, Math.round(this.count * 1.12));
      this.commit();
    }
  }

  private commit(): void {
    this.sinceChange = 0;
    this.onChange(this.count, this.pixelRatio);
  }
}
