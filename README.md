# Sculpture de lichen — landing page

Page d'accueil plein écran : une sculpture de lichen générée procéduralement (≈ 60 000 particules sur ordinateur) s'assemble au chargement, flotte, tourne lentement et réagit au curseur. Navigation minimaliste en haut à droite (réseaux sociaux + Architecture / Urbanisme / Conseil).

Stack : **Vite 7 + TypeScript + Three.js (r180)**, sans framework. Aucune image ni modèle 3D externe : tout est calculé dans le navigateur.

## Lancer le projet

Prérequis : Node.js **20.19+** ou **22.12+**.

```bash
npm install
npm run dev          # http://localhost:5173
```

Autres commandes :

| Commande | Effet |
| --- | --- |
| `npm run typecheck` | Vérification TypeScript stricte |
| `npm run build` | Typecheck + build de production dans `dist/` (chemins relatifs, déployable n'importe où) |
| `npm run preview` | Sert `dist/` sur http://localhost:4173 |
| `npm run build:single` | Build + version **monofichier** dans `dist-single/index.html` (s'ouvre directement dans le navigateur) et `dist-single/fragment.html` (sans `<html>/<head>/<body>`, à intégrer dans une page hôte) |

## Paramètres de vérification (URL)

| Paramètre | Effet |
| --- | --- |
| `?tier=high` / `medium` / `low` | Impose un niveau de rendu au lieu de la détection automatique |
| `?fallback` | Affiche le repli sans WebGL (image fixe en Canvas 2D) |
| `?motion=reduced` | Simule `prefers-reduced-motion` |
| `?at=12` | Démarre l'horloge à 12 s (captures reproductibles, saute l'assemblage) |

## Structure

```
index.html                 Structure de la page, navigation, liens d'attente
src/main.ts                Démarrage : WebGL ou repli, mouvement réduit, visibilité, HMR
src/style.css              Mise en page, typographie, survols, responsive
src/scene/generate.ts      Génération procédurale de la sculpture (forme, couleurs, AO)
src/scene/shaders.ts       Shaders GLSL : sphères-imposteurs, assemblage, frémissement, curseur, fond
src/scene/LichenScene.ts   Rendu Three.js : caméra, rotation, flottement, souris, redimensionnement, nettoyage
src/scene/quality.ts       Niveaux de rendu et ajustement dynamique de la densité
src/scene/fallback2d.ts    Repli Canvas 2D si WebGL 2 est indisponible
src/scene/noise.ts         PRNG à graine + bruit simplex 3D
scripts/inline-build.mjs   Production de la version monofichier
```

## Comment la sculpture est construite

- **Forme** : une colonne vertébrale courbe (spline) au profil d'épaisseur variable, déformée par un bruit fractal → croissant asymétrique, bras gauche fin, masse droite plus volumineuse, comme la référence.
- **Surface** : ~290 lobes foliacés (disques ondulés aux bords frisés, liserés clairs ou ocre), ~70 petites cupules tubulaires, 5 grandes apothécies olive en coupe, et un cœur brun visible dans les interstices.
- **Rendu** : un seul objet `THREE.Points` ; chaque particule est dessinée comme une petite sphère éclairée dans le fragment shader. Pas de milliers d'objets Three.js.
- **Animation (GPU)** : assemblage d'entrée en spirale avec délais échelonnés (le cœur d'abord, les bords ensuite), frémissement des bords de lobes, respiration, légère variation de luminosité, soulèvement de la matière sous le curseur.
- **Animation (CPU)** : rotation continue (plus lente quand la grande face est visible), oscillations sur deux autres axes, flottement par sinusoïdes incommensurables, orientation amortie vers le curseur, ombre diffuse qui suit la hauteur et la largeur projetée.
- **Profondeur** : brume qui fond les particules lointaines dans le fond réel, profondeur de champ légère (niveau haut uniquement).

## Performance et accessibilité

- Deuxième section : portrait vidéo (`public/media/lichen.mp4`, en boucle). Les navigateurs n'autorisent le son qu'après un clic ou un toucher sur la page : la vidéo démarre avec le son si le visiteur a déjà interagi, sinon en muet avec un bouton « Activer le son » (le toucher du portrait fait de même et relance la vidéo du début). Son fond blanc se fond dans la page (`mix-blend-mode: multiply`) ; à son arrivée à l'écran, une ligne olive se trace puis le portrait s'ouvre depuis elle. Lecture seulement quand il est visible, téléchargement après l'affichage de la sculpture ; la sculpture s'arrête quand le premier écran n'est plus visible. Avec `prefers-reduced-motion`, pas de lecture automatique (un toucher lance la vidéo). La version monofichier (`build:single`) n'embarque pas la vidéo : copiez `public/media/` à côté.
- Écran de chargement (styles en ligne dans `index.html`) affiché dès le premier rendu, pendant le téléchargement du script et le calcul de la sculpture ; retiré par `reveal()` dans `src/main.ts` à la première image, la navigation apparaît alors avec l'assemblage.
- Niveau choisi selon l'appareil (cœurs, mémoire, écran tactile, `saveData`, GPU logiciel) : 60 000 / 28 000 / 13 000 particules.
- Ajustement dynamique : si le rendu passe sous ~44 images/s, la résolution puis la densité baissent (particules mélangées à la génération : la forme s'éclaircit uniformément, sans trou). Pas d'oscillation : une densité qui a posé problème n'est jamais retentée.
- Pas de saut d'animation après un onglet en arrière-plan ; boucle arrêtée quand la page est masquée.
- `prefers-reduced-motion` : image fixe de la sculpture assemblée, navigation sans animation (changement pris en compte à chaud).
- Sans WebGL 2 ou en cas de perte de contexte : repli Canvas 2D.
- Redimensionnement géré par `ResizeObserver` ; `destroy()` libère géométries, matériaux, rendu et écouteurs (utilisé par le HMR de Vite).
- Canvas annoncé comme image (`role="img"` + description), titre `h1` masqué visuellement, focus clavier visible.

## Personnaliser

- **Liens** : dans `index.html`, tous les liens portent `data-placeholder` (destination à définir). Remplacez `href`, puis retirez l'attribut `data-placeholder` pour réactiver la navigation normale.
- **Couleurs du fond** : variables `--paper-hi`, `--paper`, `--paper-deep` dans `src/style.css` (lues aussi par le canvas).
- **Couleurs du lichen** : objet `PAL` dans `src/scene/generate.ts`.
- **Silhouette** : tableaux `SPINE`, `PROFILE_T`, `PROFILE_R` et la graine `seed` de `generateLichen()`.
- **Vitesses** : `SPIN_SPEED`, `INTRO_DURATION` et le flottement dans `src/scene/LichenScene.ts`.
- **Densités par niveau** : `TIERS` dans `src/scene/quality.ts`.

## Crédits

- [three.js](https://threejs.org) — MIT
- Icônes réseaux sociaux : [Tabler Icons](https://tabler.io/icons) — MIT (marques appartenant à leurs propriétaires respectifs)
- Police [Jost](https://fonts.google.com/specimen/Jost) — SIL Open Font License, chargée depuis Google Fonts
