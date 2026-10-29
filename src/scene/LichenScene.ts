import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { generateLichen, type LichenData } from './generate';
import { AdaptiveQuality, getTier, guessTier, refineTier, type Tier, type TierName } from './quality';
import {
  backgroundFragment,
  backgroundVertex,
  particleFragment,
  particleVertex,
  shadowFragment,
  shadowVertex,
} from './shaders';

export interface LichenSceneOptions {
  /** Conteneur dans lequel le canvas est inséré (il en prend toute la taille). */
  container: HTMLElement;
  reducedMotion: boolean;
  /** Couleurs du dégradé de fond (mêmes valeurs que le CSS), redessiné dans le canvas. */
  palette: { hi: string; paper: string; deep: string };
  /** Appelé si le contexte WebGL est perdu : la page bascule sur le repli. */
  onContextLost?: () => void;
  /** Force un niveau de rendu (tests, démonstration). */
  forceTier?: TierName;
  /** Démarre l'horloge à cet instant, en secondes (captures reproductibles). */
  startAt?: number;
  /** Hauteur réservée à la navigation en haut de l'écran, en pixels CSS : la sculpture n'y passe jamais. */
  topInset?: () => number;
}

const FOV = 28;
const SPIN_SPEED = 0.085; // rad/s, un tour complet ≈ 74 s
const INTRO_DURATION = 3.8; // s, avant que la forme soit entièrement assemblée
const BASE_POINT_SIZE = 0.029; // diamètre d'une particule, en unités monde, à densité maximale
const REFERENCE_COUNT = 60000;
const MOTIF_SCALE = 1.35; // taille de la sculpture à l'écran (1 = cadrage d'origine)

/**
 * Couleur CSS « #rrggbb » → valeurs sRGB brutes. Les shaders écrivent directement en sRGB :
 * on évite la conversion linéaire automatique de THREE.Color, qui assombrirait le fond.
 */
const srgb = (hex: string) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return new Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const damp = (current: number, target: number, lambda: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

export class LichenScene {
  readonly canvas: HTMLCanvasElement;
  readonly tier: Tier;

  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 0.1, 60);
  private root = new Group();
  private points: Points;
  private geometry: BufferGeometry;
  private material: ShaderMaterial;
  private shadow: Mesh<PlaneGeometry, ShaderMaterial> | null = null;
  private background: Mesh<PlaneGeometry, ShaderMaterial>;
  private readonly bufferSize = new Vector2(1, 1);
  private data: LichenData;
  private quality: AdaptiveQuality;
  private resizeObserver: ResizeObserver;

  private reducedMotion: boolean;
  private raf = 0;
  private running = false;
  private lastNow = 0;
  private time = 0;
  private intro = 0;
  private motion = 1;
  private disposed = false;

  private lookY = 0;

  // Curseur : position normalisée [-1, 1], suivi amorti.
  private pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false, hover: 0 };
  private readonly tmpInv = new Matrix4();
  private readonly tmpOrigin = new Vector3();
  private readonly tmpDir = new Vector3();

  constructor(private readonly options: LichenSceneOptions) {
    this.reducedMotion = options.reducedMotion;
    this.time = this.intro = Math.max(0, options.startAt ?? 0);
    const preliminary = options.forceTier ? getTier(options.forceTier) : guessTier();

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage__canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute(
      'aria-label',
      "Sculpture numérique de lichen : des milliers de particules vert-de-gris, olive et ocre forment une masse foliacée qui flotte et tourne lentement.",
    );

    // Lève une exception si WebGL est indisponible : l'appelant affiche alors le repli.
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: preliminary.antialias,
      // Canvas opaque : le fond est redessiné à l'identique dans le shader.
      alpha: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(new Color(options.palette.paper), 1);

    this.tier = options.forceTier ? preliminary : refineTier(preliminary, this.renderer.getContext());
    this.data = generateLichen(this.tier.particles);

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.data.positions, 3));
    this.geometry.setAttribute('aStart', new BufferAttribute(this.data.starts, 3));
    this.geometry.setAttribute('aNormal', new BufferAttribute(this.data.normals, 3));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.data.colors, 3));
    this.geometry.setAttribute('aParams', new BufferAttribute(this.data.params, 4));

    this.material = new ShaderMaterial({
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      uniforms: {
        uTime: { value: 0 },
        uIntro: { value: this.reducedMotion ? 100 : 0 },
        uMotion: { value: this.reducedMotion ? 0 : 1 },
        uPointScale: { value: 1 },
        uSize: { value: this.pointSizeFor(this.data.count) },
        uDof: { value: this.tier.dof ? 1 : 0 },
        uFocus: { value: 8 },
        uHazeAmount: { value: 0.12 },
        uHardEdge: { value: 0 },
        ...this.backgroundUniforms(options.palette),
        uRayOrigin: { value: new Vector3(0, 0, 100) },
        uRayDir: { value: new Vector3(0, 0, -1) },
        uHover: { value: 0 },
      },
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });
    // Bords des sphères antialiasés sans tri de profondeur (nécessite le MSAA).
    this.material.alphaToCoverage = this.tier.antialias;
    this.material.uniforms.uHardEdge.value = this.tier.antialias ? 0 : 1;

    // Fond plein écran, dessiné en premier ; partage ses uniformes avec les particules.
    this.background = new Mesh(
      new PlaneGeometry(2, 2),
      new ShaderMaterial({
        vertexShader: backgroundVertex,
        fragmentShader: backgroundFragment,
        uniforms: {
          uResolution: this.material.uniforms.uResolution,
          uBgHi: this.material.uniforms.uBgHi,
          uBgPaper: this.material.uniforms.uBgPaper,
          uBgDeep: this.material.uniforms.uBgDeep,
        },
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.background.frustumCulled = false;
    this.background.renderOrder = -10;
    this.scene.add(this.background);

    this.points = new Points(this.geometry, this.material);
    // Les positions réelles sont calculées dans le shader : pas de test de visibilité côté CPU.
    this.points.frustumCulled = false;

    // Pose initiale : la face longue vers l'observateur, comme la référence.
    this.points.rotation.set(0.08, -0.32, 0.04);
    this.root.add(this.points);
    this.scene.add(this.root);

    if (this.tier.shadow) {
      const shadowMaterial = new ShaderMaterial({
        vertexShader: shadowVertex,
        fragmentShader: shadowFragment,
        uniforms: { uOpacity: { value: 0 }, uColor: { value: srgb('#38412f') } },
        transparent: true,
        depthWrite: false,
      });
      this.shadow = new Mesh(new PlaneGeometry(1, 1), shadowMaterial);
      this.shadow.renderOrder = -1;
      this.scene.add(this.shadow);
    }

    this.quality = new AdaptiveQuality(this.tier, this.data.count, window.devicePixelRatio || 1, (count, dpr) => {
      this.geometry.setDrawRange(0, count);
      this.material.uniforms.uSize.value = this.pointSizeFor(count);
      if (Math.abs(this.renderer.getPixelRatio() - dpr) > 0.01) {
        this.renderer.setPixelRatio(dpr);
        this.resize();
      }
    });
    this.renderer.setPixelRatio(this.quality.pixelRatio);

    options.container.appendChild(this.canvas);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.container);
    this.resize();

    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this.onPointerMove, { passive: true });
    window.addEventListener('pointerup', this.onPointerEnd, { passive: true });
    window.addEventListener('pointercancel', this.onPointerEnd, { passive: true });
    document.documentElement.addEventListener('pointerleave', this.onPointerEnd);
    window.addEventListener('blur', this.onPointerEnd);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
  }

  /** Lance la boucle d'animation (ou un rendu unique si le mouvement est réduit). */
  start(): void {
    if (this.disposed) return;
    if (this.reducedMotion) {
      this.renderStatic();
      return;
    }
    if (this.running) return;
    this.running = true;
    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  setReducedMotion(reduced: boolean): void {
    if (reduced === this.reducedMotion) return;
    this.reducedMotion = reduced;
    if (reduced) {
      this.stop();
      this.material.uniforms.uIntro.value = 100;
      this.material.uniforms.uMotion.value = 0;
      this.material.uniforms.uHover.value = 0;
      this.renderStatic();
    } else {
      this.intro = INTRO_DURATION; // déjà assemblée : pas de second assemblage
      this.start();
    }
  }

  /** Libère toutes les ressources GPU et les écouteurs. */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.resizeObserver.disconnect();
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerdown', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerEnd);
    window.removeEventListener('pointercancel', this.onPointerEnd);
    document.documentElement.removeEventListener('pointerleave', this.onPointerEnd);
    window.removeEventListener('blur', this.onPointerEnd);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.geometry.dispose();
    this.material.dispose();
    this.background.geometry.dispose();
    this.background.material.dispose();
    if (this.shadow) {
      this.shadow.geometry.dispose();
      this.shadow.material.dispose();
    }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  // -------------------------------------------------------------------------

  private resize = (): void => {
    if (this.disposed) return;
    const { clientWidth: w, clientHeight: h } = this.options.container;
    if (w === 0 || h === 0) return;
    const aspect = w / h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = aspect;

    // Cadrage : la sculpture occupe environ la moitié de la largeur sur grand écran,
    // davantage sur un écran étroit, en conservant beaucoup de vide autour.
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    const ext = this.data.extent;
    const reach = Math.hypot(ext.x, ext.z * 0.6) + 0.12;
    const widthShare = Math.min(0.95, (aspect < 0.8 ? 0.9 : aspect < 1.2 ? 0.72 : 0.58) * MOTIF_SCALE);
    const heightShare = Math.min(0.8, (aspect < 0.8 ? 0.38 : 0.5) * MOTIF_SCALE);
    const byWidth = reach / widthShare / (tanHalf * aspect);
    const byHeight = (ext.y + 0.25) / heightShare / tanHalf;
    let distance = Math.max(byWidth, byHeight);

    // Le centre visuel est placé un peu au-dessus du milieu de la fenêtre (en coordonnées écran -1…1).
    // Sur un écran bas (téléphone en paysage), la sculpture descend puis recule si besoin
    // pour ne jamais passer sous la navigation ; l'ombre reste dans l'écran.
    let halfHeight = distance * tanHalf;
    let center = aspect < 0.8 ? 0.1 : 0.07;
    const above = ext.y + 0.1 + ext.z * 0.3; // inclinaisons et flottement compris
    const below = ext.y + 0.75; // jusqu'au bas de l'ombre
    const ceiling = 1 - (2 * (this.options.topInset?.() ?? 0)) / h;
    const floor = -0.97;
    if (center + above / halfHeight > ceiling) {
      center = Math.max(ceiling - above / halfHeight, floor + below / halfHeight);
      if (center + above / halfHeight > ceiling) {
        halfHeight = (above + below) / (ceiling - floor);
        center = ceiling - above / halfHeight;
        distance = halfHeight / tanHalf;
      }
    }

    this.camera.position.set(0, distance * 0.075, distance);
    this.lookY = -halfHeight * center;
    this.camera.lookAt(0, this.lookY, 0);
    this.camera.updateProjectionMatrix();

    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.material.uniforms.uResolution.value.copy(this.bufferSize);
    this.material.uniforms.uPointScale.value = this.bufferSize.y / (2 * tanHalf);
    this.material.uniforms.uFocus.value = distance;

    if (this.shadow) {
      this.shadow.scale.set(ext.x * 2.3, ext.x * 0.34, 1);
      this.shadow.position.set(0, -ext.y - 0.48, -0.4);
      this.shadow.quaternion.copy(this.camera.quaternion);
    }

    // Redimensionner vide le tampon : on redessine aussitôt pour éviter tout clignotement.
    // Avant l'animation d'entrée, les particules sont invisibles : seul le fond apparaît.
    if (this.reducedMotion) this.renderStatic();
    else this.renderer.render(this.scene, this.camera);
  };

  private backgroundUniforms(palette: LichenSceneOptions['palette']) {
    return {
      uResolution: { value: new Vector2(1, 1) },
      uBgHi: { value: srgb(palette.hi) },
      uBgPaper: { value: srgb(palette.paper) },
      uBgDeep: { value: srgb(palette.deep) },
    };
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (this.reducedMotion) return;
    // Sur écran tactile, la sculpture ne réagit que pendant le contact.
    if (event.pointerType === 'touch' && event.type === 'pointermove' && event.buttons === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.pointer.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.ty = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    this.pointer.active = true;
  };

  private onPointerEnd = (event?: Event): void => {
    if (event instanceof PointerEvent && event.pointerType === 'mouse' && event.type === 'pointerup') return;
    this.pointer.active = false;
    this.pointer.tx = 0;
    this.pointer.ty = 0;
  };

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.stop();
    this.options.onContextLost?.();
  };

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    const rawDt = (now - this.lastNow) / 1000;
    this.lastNow = now;
    const dt = Math.min(rawDt, 1 / 20); // pas de saut après un onglet en arrière-plan

    this.time += dt;
    this.intro += dt;
    this.update(dt);
    this.renderer.render(this.scene, this.camera);

    if (this.intro > INTRO_DURATION + 1) this.quality.sample(rawDt);
  };

  private update(dt: number): void {
    const t = this.time;
    const u = this.material.uniforms;
    u.uTime.value = t;
    u.uIntro.value = this.intro;
    this.motion = damp(this.motion, 1, 2, dt);
    u.uMotion.value = this.motion;

    // Suivi amorti du curseur : orientation subtile vers l'utilisateur.
    const p = this.pointer;
    p.x = damp(p.x, p.tx, 2.2, dt);
    p.y = damp(p.y, p.ty, 2.2, dt);
    const introEase = Math.min(1, this.intro / INTRO_DURATION);
    p.hover = damp(p.hover, p.active && this.tier.hover ? introEase : 0, 3, dt);

    // Rotation continue sur l'axe vertical, oscillations lentes sur les deux autres.
    // La vitesse ralentit quand la grande face est vers l'observateur et accélère de profil :
    // la sculpture s'attarde sur ses vues les plus riches, sans jamais s'arrêter.
    const spin = t * SPIN_SPEED;
    const yaw = -0.32 + spin - 0.28 * Math.sin(2 * spin);
    this.points.rotation.y = yaw;
    this.points.rotation.x = 0.08 + Math.sin(t * 0.13) * 0.12;
    this.points.rotation.z = 0.04 + Math.sin(t * 0.09 + 1.1) * 0.07;

    this.root.rotation.order = 'YXZ';
    this.root.rotation.y = p.x * 0.34;
    this.root.rotation.x = -p.y * 0.2;

    // Flottement : somme de sinusoïdes incommensurables, jamais mécanique.
    const float = Math.sin(t * 0.55) * 0.055 + Math.sin(t * 0.31 + 1.3) * 0.03 + Math.sin(t * 0.83 + 2.1) * 0.012;
    this.root.position.set(p.x * 0.06, float, 0);

    if (this.shadow) {
      // L'ombre s'élargit et pâlit quand la sculpture monte.
      const lift = (float + 0.1) / 0.2;
      this.shadow.material.uniforms.uOpacity.value = (0.13 - lift * 0.035) * introEase * introEase;
      // Largeur projetée de la sculpture selon son orientation : l'ombre la suit.
      const ext = this.data.extent;
      const span = Math.abs(Math.cos(yaw)) * ext.x + Math.abs(Math.sin(yaw)) * ext.z;
      this.shadow.scale.x = span * (2.3 + lift * 0.2);
    }

    // Rayon du curseur exprimé dans le repère de la sculpture.
    if (p.hover > 0.001) {
      this.root.updateMatrixWorld();
      this.tmpOrigin.set(p.x, p.y, 0.5).unproject(this.camera);
      this.tmpDir.copy(this.tmpOrigin).sub(this.camera.position).normalize();
      this.tmpOrigin.copy(this.camera.position);
      this.tmpInv.copy(this.points.matrixWorld).invert();
      this.tmpOrigin.applyMatrix4(this.tmpInv);
      this.tmpDir.transformDirection(this.tmpInv);
      u.uRayOrigin.value.copy(this.tmpOrigin);
      u.uRayDir.value.copy(this.tmpDir);
    }
    u.uHover.value = p.hover;
  }

  /** Moins de particules → particules un peu plus grosses, pour garder une matière couvrante. */
  private pointSizeFor(count: number): number {
    return BASE_POINT_SIZE * Math.pow(REFERENCE_COUNT / Math.max(1, count), 0.4);
  }

  private renderStatic(): void {
    if (this.disposed) return;
    const u = this.material.uniforms;
    u.uIntro.value = 100;
    u.uMotion.value = 0;
    u.uHover.value = 0;
    this.points.rotation.set(0.12, -0.18, 0.05);
    this.root.rotation.set(0, 0, 0);
    this.root.position.set(0, 0, 0);
    if (this.shadow) this.shadow.material.uniforms.uOpacity.value = 0.11;
    this.renderer.render(this.scene, this.camera);
  }
}
