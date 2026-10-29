/**
 * Shaders GLSL des particules.
 *
 * Chaque particule est un sprite (gl.POINTS) dessiné comme une petite sphère :
 * le fragment shader reconstruit la normale de la sphère pour un ombrage réel,
 * ce qui évite d'instancier des dizaines de milliers de maillages.
 * Toute l'animation (assemblage, frémissement, réaction au curseur) se fait sur le GPU.
 */


/**
 * Fond de page recalculé sur le GPU, à l'identique du CSS (body + .stage::before).
 * Le canvas devient opaque : bords des sphères antialiasés sans halo, et brume
 * de profondeur qui se fond exactement dans le fond réellement visible derrière.
 */
const backgroundChunk = /* glsl */ `
uniform vec2 uResolution;
uniform vec3 uBgHi;
uniform vec3 uBgPaper;
uniform vec3 uBgDeep;

vec3 pageBackground(vec2 frag) {
  vec2 uv = vec2(frag.x / uResolution.x, 1.0 - frag.y / uResolution.y);
  // radial-gradient(120% 85% at 50% 40%, hi 0%, paper 46%, deep 100%)
  float t = length((uv - vec2(0.5, 0.4)) / vec2(1.2, 0.85));
  vec3 col = t < 0.46
    ? mix(uBgHi, uBgPaper, t / 0.46)
    : mix(uBgPaper, uBgDeep, clamp((t - 0.46) / 0.54, 0.0, 1.0));
  // Lumière diffuse : radial-gradient(38% 34% at 40% 36%, blanc 75 % → 0 à 70 %)
  float g1 = length((uv - vec2(0.40, 0.36)) / vec2(0.38, 0.34));
  col = mix(col, vec3(1.0), 0.75 * (1.0 - clamp(g1 / 0.7, 0.0, 1.0)));
  // Reflet bas : radial-gradient(60% 40% at 58% 72%, rgb(214 222 208) 35 % → 0 à 70 %)
  float g2 = length((uv - vec2(0.58, 0.72)) / vec2(0.60, 0.40));
  col = mix(col, vec3(214.0, 222.0, 208.0) / 255.0, 0.35 * (1.0 - clamp(g2 / 0.7, 0.0, 1.0)));
  return col;
}
`;

export const particleVertex = /* glsl */ `
uniform float uTime;
uniform float uIntro;
uniform float uMotion;
uniform float uPointScale;
uniform float uSize;
uniform float uDof;
uniform float uFocus;
uniform float uHazeAmount;
uniform vec3 uRayOrigin;
uniform vec3 uRayDir;
uniform float uHover;

attribute vec3 aStart;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec4 aParams;

varying vec3 vColor;
varying float vLight;
varying float vSoft;
varying float vAlpha;
varying float vHaze;

const vec3 LIGHT = vec3(-0.48, 0.74, 0.47);

vec3 rotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void main() {
  float phase = aParams.x * 6.2831853;

  // Assemblage : chaque particule part de sa poussière initiale avec un léger retard.
  float t = clamp((uIntro - aParams.y * 1.5) / 2.1, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - t, 3.0);

  // Matière vivante : frémissement des bords de lobes, respiration d'ensemble.
  vec3 target = position;
  float flutter = aParams.w * uMotion * 0.6;
  float w1 = sin(uTime * 0.85 + phase + position.x * 1.7);
  float w2 = sin(uTime * 0.53 + phase * 1.7 + position.y * 2.3);
  target += aNormal * (w1 * flutter);
  target += vec3(w2, sin(uTime * 0.61 + phase * 2.3), cos(uTime * 0.47 + phase * 1.3)) * flutter * 0.35;
  target *= 1.0 + 0.007 * sin(uTime * 0.42) * uMotion;

  // Présence du curseur : la matière se soulève doucement vers l'observateur
  // et s'entrouvre à peine autour du rayon, comme un thalle effleuré.
  vec3 toP = target - uRayOrigin;
  vec3 away = toP - uRayDir * dot(toP, uRayDir);
  float d2 = dot(away, away);
  float infl = exp(-d2 / 0.06) * uHover;
  target += away * inversesqrt(d2 + 1e-4) * infl * 0.028 - uRayDir * infl * 0.06 + aNormal * infl * 0.02;

  vec3 start = rotY(aStart, (1.0 - e) * 1.8);
  vec3 p = mix(start, target, e);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = -mv.z;

  // Éclairage à grande échelle d'après l'orientation de la surface du lobe.
  vec3 n = normalize(normalMatrix * aNormal);
  vec3 L = normalize(LIGHT);
  // Contraste marqué entre faces éclairées et faces à l'ombre : le relief de chaque lobe se lit.
  float wrap = dot(n, L) * 0.5 + 0.5;
  vLight = 0.5 + 0.7 * wrap * wrap + pow(1.0 - abs(n.z), 3.0) * 0.08;

  float pulse = 1.0 + 0.06 * sin(uTime * 1.1 + phase * 3.0) * uMotion;
  vColor = aColor * pulse * (1.0 + infl * 0.12);

  float blur = clamp(abs(depth - uFocus) * 0.25 - 0.12, 0.0, 1.0) * uDof;
  vSoft = blur;
  float appear = smoothstep(0.0, 0.5, t);
  vAlpha = appear;
  vHaze = clamp((depth - uFocus) * uHazeAmount + 0.03, 0.0, 0.35);

  float size = uSize * aParams.z * (1.0 + blur * 0.6) * mix(0.3, 1.0, appear);
  gl_PointSize = max(size * uPointScale / depth, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const particleFragment = /* glsl */ `
uniform float uHardEdge;
${backgroundChunk}

varying vec3 vColor;
varying float vLight;
varying float vSoft;
varying float vAlpha;
varying float vHaze;

const vec3 LIGHT = vec3(-0.48, 0.74, 0.47);

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;

  // Sphère reconstruite : petite brillance qui fait lire chaque particule comme une perle.
  vec3 N = vec3(c.x, -c.y, sqrt(1.0 - r2));
  vec3 L = normalize(LIGHT);
  // Modelé discret : c'est l'éclairage d'ensemble des lobes, pas chaque perle, qui dessine la forme.
  float sph = 0.88 + 0.16 * max(dot(N, L), 0.0);
  float spec = pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 28.0) * 0.06;

  vec3 col = vColor * vLight * sph + spec;
  col = mix(col, pageBackground(gl_FragCoord.xy), vHaze);

  float fw = fwidth(r2);
  float alpha = (1.0 - smoothstep(1.0 - fw * 1.5 - vSoft * 0.7, 1.0, r2)) * vAlpha;
  // Sans MSAA (appareils modestes) : bord net plutôt que couverture partielle.
  if (uHardEdge > 0.5) {
    if (alpha < 0.5) discard;
    alpha = 1.0;
  }
  gl_FragColor = vec4(col, alpha);
}
`;

export const shadowVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const shadowFragment = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float a = pow(1.0 - smoothstep(0.0, 1.0, d), 2.2);
  gl_FragColor = vec4(uColor, a * uOpacity);
}
`;

export const backgroundVertex = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const backgroundFragment = /* glsl */ `
${backgroundChunk}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec3 col = pageBackground(gl_FragCoord.xy);
  // Tramage léger : évite les paliers visibles dans un dégradé aussi doux.
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;
