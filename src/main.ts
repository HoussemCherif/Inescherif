import './style.css';
import { LichenScene } from './scene/LichenScene';
import { renderFallback } from './scene/fallback2d';
import type { TierName } from './scene/quality';

/** Couleurs du fond lues dans les variables CSS : une seule source de vérité pour la page et le canvas. */
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return { hi: get('--paper-hi', '#f8faf6'), paper: get('--paper', '#f1f4ef'), deep: get('--paper-deep', '#e2e7df') };
}

const stage = document.getElementById('stage');
const header = document.querySelector<HTMLElement>('.site-header');
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(window.location.search);

let scene: LichenScene | null = null;
let disposeFallback: (() => void) | null = null;

function supportsWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2');
    const ok = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/** ?tier=high|medium|low impose un niveau de rendu (vérifications, démonstrations). */
function parseTier(value: string | null): TierName | undefined {
  return value === 'high' || value === 'medium' || value === 'low' ? value : undefined;
}

/** Hauteur occupée par la navigation, plus une marge : la sculpture reste en dessous. */
const navInset = () => (header ? header.offsetHeight + 12 : 0);

const hero = document.querySelector<HTMLElement>('.hero');
const portrait = document.querySelector<HTMLElement>('[data-portrait]');
const portraitVideo = portrait?.querySelector('video') ?? null;
let heroVisible = true;

/** Retire l'écran de chargement : la navigation apparaît et la sculpture s'assemble. */
function reveal(): void {
  delete document.documentElement.dataset.loading;
  document.getElementById('loader')?.setAttribute('aria-hidden', 'true');
  // La vidéo ne se télécharge qu'une fois la sculpture affichée : elle ne retarde pas l'ouverture.
  if (portraitVideo && portraitVideo.preload === 'none') portraitVideo.preload = 'auto';
}

/** La sculpture ne tourne que si le premier écran est visible (batterie, fluidité du défilement). */
function syncScene(): void {
  if (!scene) return;
  if (heroVisible && !document.hidden) scene.start();
  else scene.stop();
}

const heroObserver = new IntersectionObserver(([entry]) => {
  heroVisible = entry.isIntersecting;
  syncScene();
});
if (hero) heroObserver.observe(hero);

const soundButton = portrait?.querySelector<HTMLButtonElement>('[data-sound]') ?? null;
const soundLabel = soundButton?.querySelector('[data-sound-label]') ?? null;
/** Choix explicite du visiteur (bouton) ; null tant qu'il n'a rien choisi. */
let soundChoice: boolean | null = null;

/** Le visiteur a-t-il déjà cliqué, touché ou tapé au clavier sur la page ? (condition du son automatique) */
const hasInteracted = () =>
  (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? false;

function setSound(on: boolean): void {
  if (!portraitVideo) return;
  portraitVideo.muted = !on;
  soundButton?.setAttribute('aria-pressed', String(on));
  if (soundLabel) soundLabel.textContent = on ? 'Couper le son' : 'Activer le son';
}

/** Lance la vidéo ; si le navigateur refuse le son, elle repart en muet (le bouton reste proposé). */
function playPortrait(): void {
  if (!portraitVideo) return;
  portraitVideo.play().catch(() => {
    if (portraitVideo.muted) return;
    setSound(false);
    portraitVideo.play().catch(() => {});
  });
}

/**
 * Portrait : s'ouvre une seule fois à son arrivée à l'écran, puis se lit tant qu'il est visible.
 * Avec son si le visiteur a déjà interagi avec la page, sinon en muet avec le bouton « Activer le son ».
 * Avec le mouvement réduit, pas de lecture automatique : le bouton lance la vidéo.
 */
const portraitObserver = new IntersectionObserver(
  ([entry]) => {
    if (!portrait || !portraitVideo) return;
    if (entry.isIntersecting) {
      portrait.classList.add('is-revealed');
      if (portraitVideo.preload === 'none') portraitVideo.preload = 'auto';
      if (soundChoice === null && hasInteracted()) setSound(true);
      if (!motionQuery.matches || !portraitVideo.muted) playPortrait();
    } else {
      portraitVideo.pause();
    }
  },
  { threshold: 0.35 },
);
if (portrait) portraitObserver.observe(portrait);

/** Bouton ou toucher sur le portrait : active ou coupe le son. En l'activant, la vidéo repart du début. */
function toggleSound(): void {
  if (!portraitVideo) return;
  const on = portraitVideo.muted;
  soundChoice = on;
  setSound(on);
  if (on) {
    portraitVideo.currentTime = 0;
    playPortrait();
  }
}

soundButton?.addEventListener('click', toggleSound);
portraitVideo?.addEventListener('click', toggleSound);

function showFallback(): void {
  if (!stage) return;
  scene?.destroy();
  scene = null;
  if (!disposeFallback) disposeFallback = renderFallback(stage, readPalette().paper, navInset);
  document.documentElement.dataset.render = 'fallback';
  reveal();
}

function boot(): void {
  if (!stage) {
    reveal();
    return;
  }
  // ?fallback force l'affichage de secours (utile pour le vérifier sans désactiver WebGL).
  if (params.has('fallback') || !supportsWebGL2()) {
    showFallback();
    return;
  }
  try {
    scene = new LichenScene({
      container: stage,
      reducedMotion: motionQuery.matches || params.get('motion') === 'reduced',
      palette: readPalette(),
      onContextLost: showFallback,
      forceTier: parseTier(params.get('tier')),
      startAt: Number(params.get('at')) || 0,
      topInset: navInset,
    });
    document.documentElement.dataset.render = 'webgl';
    document.documentElement.dataset.tier = scene.tier.name;
    syncScene();
    // Révélé après la première image dessinée : l'assemblage démarre pendant que le chargement s'efface.
    requestAnimationFrame(reveal);
  } catch (error) {
    console.warn('Rendu WebGL indisponible, affichage de secours.', error);
    showFallback();
  }
}

motionQuery.addEventListener('change', (event) => scene?.setReducedMotion(event.matches));

document.addEventListener('visibilitychange', syncScene);

// Les liens d'attente ne doivent pas faire sauter la page vers le haut.
document.querySelectorAll<HTMLAnchorElement>('a[data-placeholder]').forEach((link) => {
  link.addEventListener('click', (event) => event.preventDefault());
});

// La génération de la sculpture bloque le fil principal un instant :
// on laisse d'abord le navigateur afficher l'écran de chargement.
requestAnimationFrame(() => setTimeout(boot, 0));

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    heroObserver.disconnect();
    portraitObserver.disconnect();
    scene?.destroy();
    disposeFallback?.();
    scene = null;
    disposeFallback = null;
  });
}
