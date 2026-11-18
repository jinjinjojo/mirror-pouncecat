// Vortex: deep space around a black hole whose accretion disk is a volume of glowing matter, with the mascot's cat
// eyes on the shadow. Trades are stars: buys spiral into the disk as golden streaks, sells flare outward as red sparks.
//
// Everything behind the hole is bent by a weak-field point lens, per vertex (`lensImage`): the far side of the disk
// arches over the top and under the bottom of the shadow, and background stars swirl around it as the camera moves.
// The sky (nebulosity and a galactic band) is baked once into a cube map and lensed per pixel.
import { THREE, GLSL_NOISE, Trails, Halos, clamp, lerp, damp, disposeTree } from "./common.js";
import { rng, sizeForUsd } from "./format.js";

export const VORTEX_DEFAULTS = { accent: "#ffb547", accent2: "#8b5cf6", up: "#ffd36e", down: "#ff4d6d", bg: "#05040a" };

const TAU = Math.PI * 2;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const C = (hex) => new THREE.Color(hex);
const pause = () => new Promise((r) => setTimeout(r, 0));
// the right cat ear (mirrored for the left), in units of the shadow radius: drawn by the face shader and
// used by the bloom mask so the ears stay as black as the void
const EAR = [0.2, 0.975, 0.84, 0.55, 0.8, 1.5, 0.03];

// What each quality tier gets. `second` is the share of disk particles that also draw their second (inner) lensed
// image, `sky` the baked sky's cube face size, `neb` scales the nebula sprites.
const TIERS = {
  high: { disk: 300000, second: 0.4, gas: 12000, halo: 6000, jet: 900, far: 24000, mid: 3200, near: 420, galA: 42000, galB: 18000, neb: 1, sky: 1024, noise: 256 },
  medium: { disk: 140000, second: 0.3, gas: 6500, halo: 3500, jet: 600, far: 16000, mid: 2800, near: 300, galA: 22000, galB: 9000, neb: 0.7, sky: 512, noise: 256 },
  low: { disk: 60000, second: 0.25, gas: 3000, halo: 1800, jet: 300, far: 10000, mid: 1800, near: 200, galA: 9000, galB: 4000, neb: 0.45, sky: 384, noise: 128 },
};

const SDTRI = /* glsl */ `
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
`;

const BILLBOARD_VERT = /* glsl */ `
uniform float uSize;
uniform float uR;
uniform float uForward;
varying vec2 vQ;
varying vec3 vNV;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.z += uForward;
  mv.xy += position.xy * uSize;
  vQ = position.xy * uSize / uR;
  vNV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  gl_Position = projectionMatrix * mv;
}`;

// Weak-field point lens at the world origin. `mv` is a view-space point; img = 1 gives its primary image (outside the
// Einstein ring), -1 its secondary image (inside the ring, on the far side of the hole). Points in front of the lens
// plane are not bent (the secondary then has mag 0). Also returns the radial direction on screen (er) and the
// image's stretch (x: tangential, y: radial) so sprites can be drawn as arcs. The bending fades out far from the hole
// so the whole sky doesn't shift with the camera.
const LENS = /* glsl */ `
uniform float uLensRs;
vec3 lensImage(vec3 mv, float img, out float mag, out vec2 er, out vec2 st) {
  vec3 hc = viewMatrix[3].xyz;
  er = vec2(0.0, 1.0);
  st = vec2(1.0);
  float dl = -hc.z;
  float ds = -mv.z;
  float dls = ds - dl;
  if (dl <= 0.01 || dls <= 0.0) {
    mag = img > 0.0 ? 1.0 : 0.0;
    return mv;
  }
  vec2 s = mv.xy * (dl / ds) - hc.xy;
  float sl = length(s);
  float re2 = 2.0 * uLensRs * dls * dl / ds;
  re2 *= 1.0 - smoothstep(0.5, 0.95, sl / dl);
  float q = sqrt(sl * sl + 4.0 * re2);
  float b = 0.5 * (sl + img * q);
  er = sl > 1e-5 ? s / sl : vec2(0.0, 1.0);
  float u = sl / sqrt(max(re2, 1e-8));
  float mp = (u * u + 2.0) / (2.0 * u * sqrt(u * u + 4.0) + 1e-5);
  mag = mp + 0.5 * img;
  st = vec2(abs(b) / max(sl, 1e-4), 0.5 * (1.0 + img * sl / max(q, 1e-5)));
  return vec3((hc.xy + er * b) * (ds / dl), mv.z);
}
// World-space direction in which the light leaves a source (mv0) that shows at its image (mv): straight at the camera
// when it is in front of the hole, otherwise toward the point beside the hole where the lens bends it to us.
vec3 emitDir(vec3 mv0, vec3 mv) {
  vec3 hc = viewMatrix[3].xyz;
  // (only when the hole is in front of the camera: lensImage bends nothing otherwise)
  vec3 dv = hc.z < -0.01 && mv0.z < hc.z ? normalize(mv * (hc.z / mv.z) - mv0) : normalize(-mv0);
  return transpose(mat3(viewMatrix)) * dv;
}
`;

const HASH11 = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

// Light of the disk's matter at radius r, angle phi (world point p): hot inner edge to violet outer edge, a two-armed
// density wave turning slower than the gas, Doppler beaming (the side coming at the camera is brighter and whiter),
// and a little self-shadowing when seen edge-on.
const DISK = /* glsl */ `
uniform float uTime;
uniform float uSpin;
uniform float uInner;
uniform float uOuter;
uniform float uGain;
uniform float uPulse;
uniform vec3 uHot;
uniform vec3 uMid;
uniform vec3 uWarm;
uniform vec3 uCool;
vec3 diskColor(float rn) {
  vec3 c = mix(uHot, uMid, smoothstep(0.0, 0.14, rn));
  c = mix(c, uWarm, smoothstep(0.1, 0.42, rn));
  return mix(c, uCool, smoothstep(0.32, 0.82, rn));
}
// value noise that wraps around the orbit (x has period per)
float hashP(vec2 i, float per) { i.x = mod(i.x, per); return hash12(i); }
float pnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashP(i, per), hashP(i + vec2(1.0, 0.0), per), u.x),
             mix(hashP(i + vec2(0.0, 1.0), per), hashP(i + vec2(1.0, 1.0), per), u.x), u.y);
}
// Streaks in the gas: a pattern long along the orbit and thin across it, sheared by the differential rotation. Two
// copies born half a cycle apart are cross-faded, so the shear never winds the pattern up into noise.
float streakField(float phi, float r, float T) {
  const float P = 16.0;
  float om = pow(uInner / r, 1.5);
  float t1 = fract(T / P);
  float t2 = fract(T / P + 0.5);
  float w1 = 1.0 - abs(2.0 * t1 - 1.0);
  float lr = log(r) * 17.0;
  float a1 = (phi - om * t1 * P) * 0.15915494;
  float a2 = (phi - om * t2 * P) * 0.15915494 + 0.37;
  float n1 = pnoise(vec2(a1 * 13.0, lr), 13.0) * 0.62 + pnoise(vec2(a1 * 41.0, lr * 3.1 + 7.0), 41.0) * 0.38;
  float n2 = pnoise(vec2(a2 * 13.0, lr + 13.0), 13.0) * 0.62 + pnoise(vec2(a2 * 41.0, lr * 3.1 + 21.0), 41.0) * 0.38;
  return mix(n2, n1, w1);
}
vec3 diskLight(float r, float phi, vec3 V, float T, out float rn) {
  rn = (r - uInner) / max(uOuter - uInner, 0.1);
  float prof = pow(uInner / max(r, uInner * 0.5), 2.3);
  float edge = 1.0 - smoothstep(0.7, 1.02, rn);
  float sw = 0.5 + 0.5 * cos(2.0 * (phi - 0.21 * T) + 7.0 * log(r / uInner));
  float beta = dot(vec3(-sin(phi), 0.0, cos(phi)), V) * 0.3 * sqrt(uInner / max(r, uInner));
  float dop = pow(max(1.0 + beta, 0.05), 2.2);
  vec3 col = diskColor(clamp(rn, 0.0, 1.0));
  col = mix(col, uHot, clamp(beta * 2.0, 0.0, 0.35));
  col *= mix(vec3(1.0), vec3(1.0, 0.66, 0.6), clamp(-beta * 2.4, 0.0, 0.5));
  // the disk is nearly opaque: seen at a grazing angle, each bit of it shows less of its light
  float thick = mix(0.26, 1.0, smoothstep(0.0, 0.55, abs(V.y)));
  float I = prof * edge * (0.6 + 0.8 * sw * sw) * dop * thick * uGain * (1.0 + uPulse * exp(-max(rn, 0.0) * 4.0));
  return col * I;
}
`;

const SOFT_POINT_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vCol * max(exp(-d * 3.6) - 0.028, 0.0), 1.0);
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vSpike;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  float k = exp(-d * 14.0) * 1.25 + exp(-d * 4.0) * 0.16;
  if (vSpike > 0.0) {
    vec2 a = abs(q);
    k += vSpike * (exp(-a.x * 30.0) * exp(-a.y * 2.8) + exp(-a.y * 30.0) * exp(-a.x * 2.8)) * 0.75 * (1.0 - d);
  }
  gl_FragColor = vec4(vCol * k, 1.0);
}`;

/** Blackbody color of a star (Tanner Helland's fit), as a linear THREE.Color. */
function kelvin(T, out = new THREE.Color()) {
  const t = T / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708 * Math.log(t) - 161.1196;
    b = t <= 19 ? 0 : 138.5177 * Math.log(t - 10) - 305.0448;
  } else {
    r = 329.6987 * Math.pow(t - 60, -0.1332);
    g = 288.1222 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  return out.setRGB(clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255, THREE.SRGBColorSpace);
}

/** A star's temperature, drawn roughly like the stars one sees: many orange K/M, fewer white, a few blue. */
function starTemp(R) {
  const u = R();
  if (u < 0.28) return 2900 + R() * 900;
  if (u < 0.58) return 3800 + R() * 1400;
  if (u < 0.78) return 5200 + R() * 800;
  if (u < 0.9) return 6000 + R() * 1500;
  if (u < 0.97) return 7500 + R() * 2500;
  return 10000 + R() * 16000;
}

/** Four tileable noise fields in one RGBA texture: cloud fbm, ridged filaments, a smooth tint field, fine detail. */
function noiseTexture(size, seed) {
  const R = rng(seed);
  const data = new Uint8Array(size * size * 4);
  const field = new Float32Array(size * size);
  const octave = (period, amp, ridged) => {
    const lat = new Float32Array(period * period);
    for (let i = 0; i < lat.length; i++) lat[i] = R();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * period;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      const y0 = (iy % period) * period;
      const y1 = ((iy + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * period;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % period;
        const x1 = (ix + 1) % period;
        const a = lat[y0 + x0] + (lat[y0 + x1] - lat[y0 + x0]) * sx;
        const b = lat[y1 + x0] + (lat[y1 + x1] - lat[y1 + x0]) * sx;
        let v = a + (b - a) * sy;
        if (ridged) v = 1 - Math.abs(2 * v - 1);
        field[y * size + x] += v * amp;
      }
    }
  };
  const channels = [
    { base: 4, oct: 5, ridged: false },
    { base: 5, oct: 5, ridged: true },
    { base: 3, oct: 3, ridged: false },
    { base: 8, oct: 4, ridged: false },
  ];
  channels.forEach((ch, c) => {
    field.fill(0);
    let norm = 0;
    for (let o = 0, p = ch.base, a = 0.5; o < ch.oct && p <= size; o++, p *= 2, a *= 0.5) {
      octave(p, a, ch.ridged);
      norm += a;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < field.length; i++) {
      field[i] /= norm;
      if (field[i] < lo) lo = field[i];
      if (field[i] > hi) hi = field[i];
    }
    const k = 255 / Math.max(hi - lo, 1e-6);
    for (let i = 0; i < field.length; i++) data[i * 4 + c] = Math.round((field[i] - lo) * k);
  });
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export async function createVortex(ctx) {
  const { palette, quality, reduced, px, progress = () => {}, maxCreatures = 400, mascotEyes = true, renderer = null } = ctx;
  const TIER = TIERS[quality] || TIERS.high;
  const R = rng(20260928);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = R();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * R());
  };
  const scene = new THREE.Scene();
  const BH = 3; // shadow radius
  const INNER = 4.3; // inner edge of the disk
  const RMAX = 17.4; // particles reach this far; growth fades the disk out from uOuter
  const motion = reduced ? 0.3 : 1;

  const amber = palette.accent.clone();
  const violet = palette.accent2.clone();
  const hot = C("#fff2d8").lerp(amber, 0.18);
  const warm = amber.clone().lerp(C("#ff4f7a"), 0.55);
  const downCol = palette.down.clone();
  const bg = palette.bg ? palette.bg.clone() : C(VORTEX_DEFAULTS.bg);
  const dpr0 = Math.min(quality === "high" ? 2 : quality === "medium" ? 1.5 : 1, window.devicePixelRatio || 1);

  const U = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uGain: { value: 1 },
    uOuter: { value: 15 },
    uLensRs: { value: (BH / 2.598) * 1.9 },
    uLensBg: { value: (BH / 2.598) * 0.5 }, // the background bends less: a softer Einstein ring on the sky
    uDpr: { value: dpr0 },
    uMotion: { value: motion },
  };
  const disposables = [];

  /* ------------------------------------------------------------ sky */
  progress(0.04, "Lighting the stars");
  // The galactic band: a great circle tilted across the sky, its bright core off to one side.
  const dirFrom = (azDeg, elDeg) => {
    const az = THREE.MathUtils.degToRad(azDeg);
    const el = THREE.MathUtils.degToRad(elDeg);
    return V3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  };
  const GC = dirFrom(232, 4);
  const GN = dirFrom(322, 28).addScaledVector(GC, -dirFrom(322, 28).dot(GC)).normalize().cross(GC).normalize();
  const GE = V3().crossVectors(GN, GC).normalize();

  const farGroup = new THREE.Group(); // follows the camera: infinitely far away
  scene.add(farGroup);
  const skyColors = {
    uBg: { value: bg.clone().lerp(C("#07051a"), 0.5) },
    uNeb1: { value: violet.clone().lerp(C("#3b1f78"), 0.45) },
    uNeb2: { value: C("#0f4a5e") },
    uNeb3: { value: amber.clone().lerp(C("#8a2a60"), 0.6) },
    uBand: { value: C("#c9d2ff").lerp(violet, 0.22) },
    uCore: { value: C("#ffd9a8").lerp(amber, 0.3) },
    uGN: { value: GN.clone() },
    uGC: { value: GC.clone() },
    uGE: { value: GE.clone() },
  };
  const SKY_BAKE_FRAG =
    GLSL_NOISE +
    /* glsl */ `
    uniform vec3 uBg;
    uniform vec3 uNeb1;
    uniform vec3 uNeb2;
    uniform vec3 uNeb3;
    uniform vec3 uBand;
    uniform vec3 uCore;
    uniform vec3 uGN;
    uniform vec3 uGC;
    uniform vec3 uGE;
    uniform int uOct; // 6; a uniform so the loops stay loops (unrolled, this shader takes seconds to compile on D3D)
    varying vec3 vDir;
    float fbmN(vec3 p, int oct) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < oct; i++) { s += a * vnoise3(p); p = p * 2.03 + vec3(11.3, 7.1, 3.7); a *= 0.5; }
      return s;
    }
    void main() {
      vec3 d = normalize(vDir);
      int o6 = uOct, o4 = uOct - 2, o3 = uOct - 3;
      vec3 w = vec3(fbmN(d * 1.6 + 3.1, o3), fbmN(d * 1.6 + 11.7, o3), fbmN(d * 1.6 + 23.3, o3));
      float n1 = fbmN(d * 2.1 + w * 1.5, o6);
      float n2 = fbmN(d * 4.4 + w * 2.2 + 7.0, o6);
      float neb = smoothstep(0.42, 0.86, n1);
      vec3 col = uBg * (0.85 + 0.3 * n2);
      col += uNeb1 * pow(neb, 1.5) * 0.11;
      col += uNeb2 * smoothstep(0.55, 0.9, n2) * neb * 0.07;
      col += uNeb3 * pow(smoothstep(0.6, 0.95, n2), 2.0) * 0.04;
      // galactic band: latitude from its plane, longitude from its core
      float lat = asin(clamp(dot(d, uGN), -1.0, 1.0));
      float lon = atan(dot(d, uGE), dot(d, uGC));
      float core = exp(-lon * lon / 0.35);
      float wig = (fbmN(vec3(lon * 1.7, 0.3, 1.3), o4) - 0.5) * 0.09;
      float width = 0.1 + 0.07 * core;
      float band = exp(-pow((lat - wig) / width, 2.0));
      float wide = exp(-pow(lat / (width * 3.2), 2.0));
      float clouds = fbmN(d * 7.5 + w * 0.7, o6);
      float fine = fbmN(d * 30.0, o4);
      float em = band * (0.3 + 1.2 * smoothstep(0.38, 0.78, clouds)) * (0.65 + 0.7 * fine) + wide * 0.22;
      em += exp(-pow(lat / 0.07, 2.0)) * core * 1.0;
      // dust: dark filaments along the band and a rift down its middle
      float dl = fbmN(d * 9.5 + w * 1.3 + 31.0, o6);
      float lanes = smoothstep(0.5, 0.7, dl) * exp(-pow((lat - wig * 1.3) / (width * 0.6), 2.0));
      float rift = exp(-pow((lat - wig * 1.1 + 0.012) / (width * 0.2), 2.0)) * smoothstep(0.32, 0.6, fbmN(d * 5.0 + 3.0, o4));
      float absorb = clamp(lanes * 0.85 + rift * 0.75, 0.0, 0.95);
      vec3 bandCol = mix(uBand, uCore, clamp(core * 0.9 + 0.1, 0.0, 1.0));
      col += bandCol * em * (1.0 - absorb) * (0.034 + 0.05 * core);
      // unresolved starlight: a fine grain in the band
      col += bandCol * band * pow(vnoise3(d * 520.0), 8.0) * 0.07 * (1.0 - absorb);
      col *= 1.0 - 0.45 * absorb * wide;
      gl_FragColor = vec4(col, 1.0);
    }`;
  let skyRT = null;
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uSky: { value: null }, uLensRs: U.uLensBg, uTime: U.uTime },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader:
      GLSL_NOISE +
      /* glsl */ `
      uniform samplerCube uSky;
      uniform float uLensRs;
      uniform float uTime;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float dl = length(cameraPosition);
        vec3 h = -cameraPosition / max(dl, 1e-3);
        float c = dot(d, h);
        if (c > 0.72) {
          // the lens equation in angles: a pixel at angle th from the hole shows the sky at beta (the bending has
          // faded out by ~44 degrees from the hole, see lensImage)
          float th = acos(clamp(c, -1.0, 1.0));
          float te2 = 2.0 * uLensRs / max(dl, 1e-3) * (1.0 - smoothstep(0.5, 0.95, tan(min(th, 1.4))));
          float beta = th - te2 / max(th, 1e-4);
          vec3 ax = d - h * c;
          float al = length(ax);
          ax = al > 1e-6 ? ax / al : vec3(0.0, 1.0, 0.0);
          d = h * cos(beta) + ax * sin(beta);
        }
        vec3 col = textureCube(uSky, d).rgb;
        col *= 1.0 + (hash12(gl_FragCoord.xy + fract(uTime) * 71.0) - 0.5) * 0.05;
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), skyMat);
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  farGroup.add(sky);
  // The bake's shader compiles in the background (where the browser can) while the particles are built; the six
  // faces are rendered at the end of createVortex. Without a renderer the sky is baked on the first frame instead.
  function prepareSky(r) {
    skyRT = new THREE.WebGLCubeRenderTarget(TIER.sky, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    const bakeMat = new THREE.ShaderMaterial({
      uniforms: { ...skyColors, uOct: { value: 6 } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: SKY_BAKE_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const bakeScene = new THREE.Scene();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), bakeMat);
    bakeScene.add(ball);
    const cam = new THREE.CubeCamera(0.1, 100, skyRT);
    let ready = Promise.resolve();
    if (r.compileAsync && r.extensions.has("KHR_parallel_shader_compile")) {
      // compiled for the cube target, so the program matches the one the bake uses
      const prev = r.getRenderTarget();
      r.setRenderTarget(skyRT);
      ready = r.compileAsync(bakeScene, cam.children[0]).catch(() => {});
      r.setRenderTarget(prev);
    }
    let done = false;
    const free = () => {
      done = true;
      ball.geometry.dispose();
      bakeMat.dispose();
    };
    return {
      ready,
      run() {
        if (done || !skyRT) return;
        cam.update(r, bakeScene);
        free();
        skyMat.uniforms.uSky.value = skyRT.texture;
      },
      cancel: () => done || free(),
    };
  }
  const skyBake = renderer ? prepareSky(renderer) : null;
  if (!renderer)
    scene.onBeforeRender = (r) => {
      scene.onBeforeRender = () => {};
      prepareSky(r).run();
    };

  // Stars: three layers. Far ones ride with the camera (no parallax), mid and near ones sit in the world, so they
  // slide against each other as the camera orbits. Each layer also draws the inner (secondary) lensed images.
  const starVert = (far) => /* glsl */ `
    attribute vec4 aStar; // brightness, size (far: pixels, else world units), twinkle, seed
    attribute vec3 aColor;
    uniform float uTime;
    uniform float uPx;
    uniform float uDpr;
    uniform float uMotion;
    uniform float uImg;
    varying vec3 vCol;
    varying float vSpike;
    ${LENS}
    void main() {
      vec4 mv0 = modelViewMatrix * vec4(position, 1.0);
      float mag; vec2 er, st;
      vec3 mv = lensImage(mv0.xyz, uImg, mag, er, st);
      if (mag <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); vSpike = 0.0; return; }
      mag = min(mag, 8.0);
      float tw = 1.0 + aStar.z * sin(uTime * uMotion * (0.7 + aStar.w * 2.6) + aStar.w * 91.0);
      float k = aStar.x * tw * mag;
      float bright = step(2.0, aStar.x);
      ${
        far
          ? `float ps = aStar.y * uDpr * (bright > 0.5 ? 5.0 : 1.0);`
          : `float depth = -mv.z;
      float ps = aStar.y * uPx / max(depth, 0.05) * (bright > 0.5 ? 3.0 : 1.0);
      float minPs = 1.8 * uDpr;
      k *= min(1.0, ps * ps / (minPs * minPs));
      ps = clamp(ps, minPs, 320.0);
      k *= smoothstep(0.6, 3.0, depth);`
      }
      vSpike = bright * clamp((aStar.x - 2.0) * 0.8, 0.35, 1.0);
      vCol = aColor * k;
      gl_PointSize = ps;
      vec4 p = projectionMatrix * vec4(mv, 1.0);
      ${far ? "gl_Position = p.xyww;" : "gl_Position = p;"}
    }`;
  function starLayer(geo, far, renderOrder, parent) {
    const make = (img) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: U.uTime, uPx: px, uDpr: U.uDpr, uMotion: U.uMotion, uLensRs: U.uLensBg, uImg: { value: img } },
        vertexShader: starVert(far),
        fragmentShader: STAR_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const p = new THREE.Points(geo, m);
      p.renderOrder = renderOrder;
      p.frustumCulled = false;
      parent.add(p);
      return p;
    };
    make(1);
    make(-1);
  }
  const starAttrs = (n, placeFn) => {
    const pos = new Float32Array(n * 3);
    const star = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const T = starTemp(R);
      kelvin(T, c);
      // luminosity: a power law like real star counts (most are faint pinpricks, a few percent stand out), hotter
      // stars a little brighter
      let b = Math.min(1.6, 0.085 * Math.pow(1 - R() * 0.999, -0.62)) * (T > 9000 ? 1.25 : 1);
      if (R() < 0.0016) b = 2.1 + R() * 0.9; // a rare few with diffraction spikes
      const p = placeFn(i, b);
      pos.set(p, i * 3);
      star.set([b, 0, (R() < 0.3 ? 0.35 : 0.12) * (reduced ? 0.5 : 1), R()], i * 4);
      col.set([c.r, c.g, c.b], i * 3);
    }
    return { pos, star, col };
  };
  const bandDir = (spread) => {
    const lon = (R() * 2 - 1) * Math.PI;
    const coreBoost = R() < 0.35 ? gauss() * 0.6 : lon;
    const L = Math.abs(coreBoost) < Math.PI ? coreBoost : lon;
    const lat = gauss() * spread * (1 + 0.8 * Math.exp((-L * L) / 0.35));
    return V3()
      .addScaledVector(GC, Math.cos(lat) * Math.cos(L))
      .addScaledVector(GE, Math.cos(lat) * Math.sin(L))
      .addScaledVector(GN, Math.sin(lat))
      .normalize();
  };
  const randDir = () => {
    const u = R() * 2 - 1;
    const a = R() * TAU;
    const r = Math.sqrt(1 - u * u);
    return V3(Math.cos(a) * r, u, Math.sin(a) * r);
  };
  {
    // far: pixel-sized, half of them crowd the galactic band
    const n = TIER.far;
    const { pos, star, col } = starAttrs(n, () => (R() < 0.5 ? bandDir(0.11) : randDir()).multiplyScalar(1300).toArray());
    for (let i = 0; i < n; i++) {
      star[i * 4] *= 1.2;
      star[i * 4 + 1] = 0.95 + Math.min(star[i * 4] * 0.8, 1.3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aStar", new THREE.BufferAttribute(star, 4));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    starLayer(g, true, -99, farGroup);
  }
  {
    // mid: a shell 350-1100 units out, world-fixed
    const n = TIER.mid;
    const { pos, star, col } = starAttrs(n, () => (R() < 0.3 ? bandDir(0.14) : randDir()).multiplyScalar(350 + Math.pow(R(), 0.7) * 750).toArray());
    for (let i = 0; i < n; i++) star[i * 4 + 1] = 0.55 + Math.min(star[i * 4], 1.0) * 0.45;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aStar", new THREE.BufferAttribute(star, 4));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    starLayer(g, false, -80, scene);
  }
  {
    // near: 70-320 units out, around the camera's orbit, so they show the strongest parallax
    const n = TIER.near;
    const { pos, star, col } = starAttrs(n, () => randDir().multiplyScalar(70 + Math.pow(R(), 0.8) * 250).toArray());
    for (let i = 0; i < n; i++) star[i * 4 + 1] = 0.12 + Math.min(star[i * 4], 1.0) * 0.12;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aStar", new THREE.BufferAttribute(star, 4));
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    starLayer(g, false, -79, scene);
  }
  await pause();

  /* ------------------------------------------------- nebulae and dust */
  progress(0.12, "Gathering the nebulae");
  const noiseTex = noiseTexture(TIER.noise, 9151);
  {
    const clouds = [
      { az: 250, el: 6, dist: 560, size: 150, n: 22, a: violet.clone().lerp(C("#b04cff"), 0.3), b: C("#ff5fa8").lerp(violet, 0.35), k: 0.1 },
      { az: 162, el: -12, dist: 640, size: 170, n: 20, a: C("#1d6f8f"), b: violet.clone().lerp(C("#4c7dff"), 0.5), k: 0.085 },
      { az: 18, el: 12, dist: 520, size: 140, n: 18, a: amber.clone().lerp(C("#ff3d6e"), 0.6), b: violet.clone(), k: 0.085 },
      { az: 95, el: -30, dist: 700, size: 190, n: 18, a: violet.clone().lerp(C("#3b5bff"), 0.4), b: C("#2aa6b8"), k: 0.075 },
      { az: 300, el: -22, dist: 620, size: 130, n: 14, a: C("#ff6a8f").lerp(violet, 0.5), b: amber.clone().lerp(C("#ff8a3d"), 0.4), k: 0.07 },
      { az: 120, el: 26, dist: 600, size: 150, n: 16, a: C("#2a8fb0").lerp(violet, 0.3), b: C("#ff7ab8").lerp(violet, 0.5), k: 0.075 },
    ];
    const emit = [];
    const dark = [];
    for (const cl of clouds) {
      const center = dirFrom(cl.az, cl.el).multiplyScalar(cl.dist);
      // each cloud is an ellipsoid of sprites, flattened along a random axis so it reads as a sheet or a filament
      const ax = randDir();
      const n = Math.max(6, Math.round(cl.n * TIER.neb));
      for (let i = 0; i < n; i++) {
        const o = V3(gauss(), gauss(), gauss()).multiplyScalar(cl.size * 0.42);
        o.addScaledVector(ax, -o.dot(ax) * 0.6);
        const knot = i < 3;
        emit.push({
          p: center.clone().add(knot ? o.multiplyScalar(0.3) : o),
          s: cl.size * (knot ? 0.25 + R() * 0.2 : 0.45 + R() * 0.6),
          rot: R() * TAU,
          uv: [R(), R()],
          k: cl.k * (knot ? 2.2 : 0.55 + R() * 0.7),
          a: cl.a,
          b: cl.b,
        });
      }
      // dark dust in front of the brighter half of the clouds
      const nd = Math.max(2, Math.round(cl.n * 0.3 * TIER.neb));
      for (let i = 0; i < nd; i++) {
        const o = V3(gauss(), gauss() * 0.5, gauss()).multiplyScalar(cl.size * 0.4);
        dark.push({ p: center.clone().multiplyScalar(0.9).add(o), s: cl.size * (0.3 + R() * 0.4), rot: R() * TAU, uv: [R(), R()], k: 0.45 + R() * 0.35 });
      }
    }
    const spriteGeo = (list, withColor) => {
      const g = new THREE.InstancedBufferGeometry();
      const quad = new THREE.PlaneGeometry(2, 2);
      g.index = quad.index;
      g.setAttribute("position", quad.attributes.position);
      const c = new Float32Array(list.length * 4);
      const p = new Float32Array(list.length * 4);
      const a = new Float32Array(list.length * 3);
      const b = new Float32Array(list.length * 3);
      list.forEach((s, i) => {
        c.set([s.p.x, s.p.y, s.p.z, s.s], i * 4);
        p.set([s.rot, s.uv[0], s.uv[1], s.k], i * 4);
        if (withColor) {
          a.set([s.a.r, s.a.g, s.a.b], i * 3);
          b.set([s.b.r, s.b.g, s.b.b], i * 3);
        }
      });
      g.setAttribute("aC", new THREE.InstancedBufferAttribute(c, 4));
      g.setAttribute("aP", new THREE.InstancedBufferAttribute(p, 4));
      if (withColor) {
        g.setAttribute("aCol", new THREE.InstancedBufferAttribute(a, 3));
        g.setAttribute("aCol2", new THREE.InstancedBufferAttribute(b, 3));
      }
      g.instanceCount = list.length;
      return g;
    };
    const vert = (withColor) => /* glsl */ `
      attribute vec4 aC;
      attribute vec4 aP;
      ${withColor ? "attribute vec3 aCol; attribute vec3 aCol2; varying vec3 vCol; varying vec3 vCol2;" : ""}
      uniform float uTime;
      uniform float uMotion;
      varying vec2 vQ;
      varying vec2 vUv;
      varying float vK;
      void main() {
        vec4 mv = modelViewMatrix * vec4(aC.xyz, 1.0);
        float a = aP.x + uTime * uMotion * 0.004 * (fract(aP.y * 7.0) - 0.5);
        float c = cos(a), s = sin(a);
        vec2 q = position.xy;
        vec2 rq = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        mv.xy += rq * aC.w;
        vQ = q;
        vUv = q * 0.36 + aP.yz;
        ${withColor ? "vCol = aCol; vCol2 = aCol2;" : ""}
        vK = aP.w * smoothstep(aC.w * 0.5, aC.w * 1.8, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`;
    const emitMat = new THREE.ShaderMaterial({
      uniforms: { uNoise: { value: noiseTex }, uTime: U.uTime, uMotion: U.uMotion },
      vertexShader: vert(true),
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise;
        varying vec2 vQ;
        varying vec2 vUv;
        varying float vK;
        varying vec3 vCol;
        varying vec3 vCol2;
        void main() {
          float r = length(vQ);
          if (r > 1.0) discard;
          vec4 n = texture2D(uNoise, vUv);
          vec4 m = texture2D(uNoise, vUv * 2.3 + n.rg * 0.3 + 0.37);
          float edge = r + (n.r - 0.5) * 0.6 + (m.a - 0.5) * 0.3;
          float shape = 1.0 - smoothstep(0.3, 1.0, edge);
          float body = smoothstep(0.3, 0.85, n.r);
          float wisps = pow(m.g, 2.4);
          float dens = shape * (0.45 * body + 1.1 * wisps * (0.35 + body)) * (0.6 + 0.5 * n.a);
          vec3 col = mix(vCol, vCol2, smoothstep(0.3, 0.75, n.b));
          gl_FragColor = vec4(col * dens * vK, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const neb = new THREE.Mesh(spriteGeo(emit, true), emitMat);
    neb.frustumCulled = false;
    neb.renderOrder = -90;
    scene.add(neb);
    const darkMat = new THREE.ShaderMaterial({
      uniforms: { uNoise: { value: noiseTex }, uTime: U.uTime, uMotion: U.uMotion },
      vertexShader: vert(false),
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise;
        varying vec2 vQ;
        varying vec2 vUv;
        varying float vK;
        void main() {
          float r = length(vQ);
          if (r > 1.0) discard;
          vec4 n = texture2D(uNoise, vUv + 0.19);
          vec4 m = texture2D(uNoise, vUv * 1.9 + n.rg * 0.25);
          float shape = 1.0 - smoothstep(0.25, 1.0, r + (n.r - 0.5) * 0.7);
          float dens = shape * smoothstep(0.35, 0.8, n.r * 0.65 + m.g * 0.55);
          gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(dens * vK, 0.0, 0.9));
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const darkMesh = new THREE.Mesh(spriteGeo(dark, false), darkMat);
    darkMesh.frustumCulled = false;
    darkMesh.renderOrder = -89;
    scene.add(darkMesh);
  }
  await pause();

  /* ------------------------------------------------------- galaxies */
  progress(0.18, "Placing distant galaxies");
  const galaxies = [];
  {
    const galVert = /* glsl */ `
      attribute vec4 aStar; // brightness, world size, -, seed
      attribute vec3 aColor;
      uniform float uPx;
      uniform float uDpr;
      uniform float uK;
      varying vec3 vCol;
      ${LENS}
      void main() {
        vec4 mv0 = modelViewMatrix * vec4(position, 1.0);
        float mag; vec2 er, st;
        vec3 mv = lensImage(mv0.xyz, 1.0, mag, er, st);
        mag = min(mag, 4.0);
        float depth = -mv.z;
        float ps = aStar.y * uPx / max(depth, 1.0);
        float k = aStar.x * uK * mag;
        float minPs = 1.25 * uDpr;
        k *= min(1.0, ps * ps / (minPs * minPs));
        vCol = aColor * k;
        gl_PointSize = max(ps, minPs);
        gl_Position = projectionMatrix * vec4(mv, 1.0);
      }`;
    const glowFrag = /* glsl */ `
      uniform vec3 uCore;
      uniform vec3 uDisk;
      uniform vec3 uArm;
      uniform float uArms;
      uniform float uPitch;
      uniform float uK;
      uniform float uLane;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        if (r > 1.3) discard;
        float ang = atan(vP.y, vP.x);
        float lr = log(max(r, 0.02));
        float arm = pow(0.5 + 0.5 * cos(uArms * (ang - lr / uPitch)), 3.0);
        float lanes = pow(0.5 + 0.5 * cos(uArms * (ang - lr / uPitch) + 1.0), 8.0) * smoothstep(0.06, 0.25, r) * exp(-r / 0.7);
        float bulge = exp(-r * r / 0.01);
        float disk = exp(-r / 0.24);
        float edge = 1.0 - smoothstep(0.9, 1.3, r);
        vec3 col = uCore * bulge * 1.4 + uDisk * disk * 0.45 + uArm * arm * exp(-r / 0.45) * smoothstep(0.04, 0.18, r) * 0.55;
        col *= 1.0 - uLane * lanes;
        gl_FragColor = vec4(col * edge * uK, 1.0);
      }`;
    const specs = [
      // a face-on-ish grand-design spiral and a smaller one seen nearly edge-on with a dust lane
      // inc: degrees from face-on as seen from the middle of the scene; pa: turn of the disk on the sky
      { n: TIER.galA, full: TIERS.high.galA, az: 214, el: 3, dist: 900, radius: 78, inc: 52, pa: 35, arms: 2, pitch: 0.36, lane: false, k: 1 },
      { n: TIER.galB, full: TIERS.high.galB, az: 183, el: -23, dist: 980, radius: 58, inc: 84, pa: 62, arms: 3, pitch: 0.3, lane: true, k: 0.9 },
    ];
    const cA = new THREE.Color();
    for (const G of specs) {
      const group = new THREE.Group();
      group.position.copy(dirFrom(G.az, G.el).multiplyScalar(G.dist));
      {
        const toG = group.position.clone().normalize();
        const side = V3(0, 1, 0).cross(toG).normalize();
        const inc = THREE.MathUtils.degToRad(G.inc);
        const normal = toG.clone().multiplyScalar(-Math.cos(inc)).addScaledVector(side, Math.sin(inc)).normalize();
        normal.applyAxisAngle(toG, THREE.MathUtils.degToRad(G.pa));
        group.quaternion.setFromUnitVectors(V3(0, 1, 0), normal);
      }
      group.scale.setScalar(G.radius);
      scene.add(group);
      galaxies.push(group);
      const n = G.n;
      const pos = new Float32Array(n * 3);
      const star = new Float32Array(n * 4);
      const col = new Float32Array(n * 3);
      const hii = violet.clone().lerp(C("#ff5fa2"), 0.55);
      const coreC = C("#ffd7a0").lerp(amber, 0.25);
      for (let i = 0; i < n; i++) {
        const u = R();
        let x, y, z, b, T;
        let tint = null;
        if (u < 0.17) {
          // bulge
          const r = Math.abs(gauss()) * 0.11;
          const a = R() * TAU;
          const e = gauss() * 0.6;
          x = Math.cos(a) * r;
          z = Math.sin(a) * r;
          y = e * r * 0.7;
          b = 0.9 + R() * 0.5;
          T = 4200 + R() * 1400;
        } else if (u < 0.45) {
          // smooth disk
          const r = Math.min(1.25, -Math.log(1 - R() * 0.98) * 0.26);
          const a = R() * TAU;
          x = Math.cos(a) * r;
          z = Math.sin(a) * r;
          y = gauss() * (G.lane ? 0.035 : 0.02);
          b = 0.35 + R() * 0.4;
          T = 4300 + R() * 3000;
        } else {
          // spiral arms: young blue stars, pink star-forming knots
          const arm = Math.floor(R() * G.arms);
          const r = 0.07 + Math.pow(R(), 0.85) * 1.05;
          const th = (arm / G.arms) * TAU + Math.log(r / 0.07) / Math.tan(G.pitch) + gauss() * 0.16;
          const w = 0.03 + 0.05 * r;
          x = Math.cos(th) * r + gauss() * w;
          z = Math.sin(th) * r + gauss() * w;
          y = gauss() * 0.018;
          b = 0.5 + R() * 0.6;
          T = R() < 0.7 ? 8000 + R() * 14000 : 4500 + R() * 2500;
          if (u > 0.95) {
            tint = hii;
            b = 1.2 + R();
          }
        }
        // the edge-on galaxy's dust lane: its mid-plane goes dark
        if (G.lane && Math.abs(y) < 0.014 && Math.hypot(x, z) < 0.9) b *= 0.12;
        if (tint) cA.copy(tint);
        else kelvin(T, cA);
        if (u < 0.17) cA.lerp(coreC, 0.5);
        pos.set([x, y, z], i * 3);
        star.set([b, 0.5 + R() * 1.1, 0, R()], i * 4);
        col.set([cA.r, cA.g, cA.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("aStar", new THREE.BufferAttribute(star, 4));
      g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
      const pts = new THREE.Points(
        g,
        new THREE.ShaderMaterial({
          uniforms: { uPx: px, uDpr: U.uDpr, uK: { value: 0.12 * G.k * Math.sqrt(G.full / Math.max(G.n, 1)) }, uLensRs: U.uLensBg },
          vertexShader: galVert,
          fragmentShader: SOFT_POINT_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      pts.frustumCulled = false;
      pts.renderOrder = -86;
      group.add(pts);
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.7, 2.7),
        new THREE.ShaderMaterial({
          uniforms: {
            uCore: { value: coreC.clone() },
            uDisk: { value: C("#b9c4ff").lerp(violet, 0.3) },
            uArm: { value: C("#8fb0ff").lerp(violet, 0.35) },
            uArms: { value: G.arms },
            uPitch: { value: Math.tan(G.pitch) },
            uK: { value: 0.14 * G.k },
            uLane: { value: G.lane ? 0.2 : 0.6 },
            uLensRs: U.uLensBg,
          },
          vertexShader: /* glsl */ `
            varying vec2 vP;
            ${LENS}
            void main() {
              vP = position.xy;
              // the whole glow moves with the lensed image of the galaxy's centre, so it stays under its stars
              vec3 c0 = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              float mag; vec2 er, st;
              vec3 c1 = lensImage(c0, 1.0, mag, er, st);
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              mv.xy += (c1.xy - c0.xy) * (mv.z / c0.z);
              gl_Position = projectionMatrix * mv;
            }`,
          fragmentShader: glowFrag,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.frustumCulled = false;
      glow.renderOrder = -87;
      group.add(glow);
    }
  }
  await pause();

  /* -------------------------------------------------------- black hole */
  progress(0.26, "Folding spacetime");
  const hole = new THREE.Mesh(new THREE.SphereGeometry(BH, 64, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  hole.renderOrder = 0;
  scene.add(hole);

  // photon ring: a sharp bright circle hugging the shadow (a camera-facing billboard), brighter on the side where the
  // disk comes at the camera
  const ringMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime,
      uGain: U.uGain,
      uSize: { value: BH * 2.1 },
      uR: { value: BH },
      uHot: { value: hot },
      uMid: { value: amber },
      uCool: { value: violet },
      uMotion: U.uMotion,
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uR;
      varying vec2 vQ;
      varying vec2 vDop;
      void main() {
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy * uSize;
        vQ = position.xy * uSize / uR;
        // the approaching side of the disk, on screen
        vec3 c = normalize(cameraPosition);
        float h = length(c.xz);
        vec3 side = h > 1e-4 ? vec3(c.z, 0.0, -c.x) / h : vec3(1.0, 0.0, 0.0);
        vec2 sv = (viewMatrix * vec4(side, 0.0)).xy;
        vDop = length(sv) > 1e-4 ? normalize(sv) * h * 0.55 : vec2(0.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader:
      GLSL_NOISE +
      /* glsl */ `
      uniform float uTime;
      uniform float uGain;
      uniform float uMotion;
      uniform vec3 uHot;
      uniform vec3 uMid;
      uniform vec3 uCool;
      varying vec2 vQ;
      varying vec2 vDop;
      void main() {
        float rho = length(vQ);
        if (rho < 0.97) discard;
        vec2 dir = vQ / rho;
        float t = uTime * uMotion * 0.35;
        vec2 rd = mat2(cos(t), -sin(t), sin(t), cos(t)) * dir;
        float n = 0.7 + 0.6 * vnoise(rd * 4.0 + rho * 6.0);
        float side = max(1.0 + dot(dir, vDop), 0.2);
        float ring = exp(-pow((rho - 1.03) / 0.011, 2.0)) * 1.7;
        float ring2 = exp(-pow((rho - 1.065) / 0.018, 2.0)) * 0.32 * n;
        float halo = exp(-pow((rho - 1.1) / 0.1, 2.0)) * 0.12;
        vec3 col = (uHot * ring + mix(uMid, uHot, 0.5) * ring2) * side + uMid * halo * side;
        col += uCool * exp(-(rho - 1.0) * 2.2) * 0.05;
        col *= 1.0 - smoothstep(1.55, 2.1, rho);
        gl_FragColor = vec4(col * uGain, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMat);
  ring.renderOrder = 2;
  ring.frustumCulled = false;
  scene.add(ring);

  // the mascot: black cat ears on the shadow and two glowing almond eyes
  let faceMat = null;
  if (mascotEyes) {
    faceMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uSize: { value: BH * 1.85 },
        uR: { value: BH },
        uForward: { value: BH * 1.02 },
        uBlink: { value: 0 },
        uLook: { value: new THREE.Vector2() },
        uIris: { value: amber.clone().lerp(C("#ff6a10"), 0.45) },
        uIrisHot: { value: C("#ffd66e").lerp(amber, 0.25) },
        uRim: { value: amber.clone().lerp(hot, 0.4) },
        uCool: { value: violet },
        uEyeGain: { value: 2.8 },
      },
      vertexShader: BILLBOARD_VERT,
      fragmentShader:
        GLSL_NOISE +
        /* glsl */ `
        uniform float uTime;
        uniform float uBlink;
        uniform vec2 uLook;
        uniform vec3 uIris;
        uniform vec3 uIrisHot;
        uniform vec3 uRim;
        uniform vec3 uCool;
        uniform float uEyeGain;
        varying vec2 vQ;
        ${SDTRI}
        // one almond eye; p0 is relative to the eye center, side = -1 (left) or 1 (right)
        vec4 eye(vec2 p0, float side, float aa) {
          vec2 p = vec2(p0.x * side, p0.y);
          float c = cos(0.2), s = sin(0.2);
          p = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
          const float W = 0.32;
          float H = 0.18 * (1.0 - uBlink) + 0.004;
          float xn = p.x / W;
          float lid = H * pow(max(1.0 - xn * xn, 0.0), 0.72);
          float inside = lid - abs(p.y);
          float mask = smoothstep(-aa, aa, inside) * step(abs(xn), 1.0);
          vec2 lp = p - vec2(uLook.x * side * 0.085, uLook.y * 0.04);
          float rr = length(lp / vec2(0.27, 0.19));
          vec3 iris = mix(uIrisHot, uIris, smoothstep(0.0, 0.95, rr));
          vec2 dv = lp / max(length(lp), 1e-4);
          iris *= 0.72 + 0.42 * vnoise(dv * 6.0 + rr * 2.5) * smoothstep(0.1, 0.6, rr);
          iris *= 0.5 + 0.5 * smoothstep(0.0, 0.06, inside);
          float ph = 0.16;
          float yy = clamp(lp.y / ph, -1.0, 1.0);
          float pw = (0.024 + 0.012 * (0.5 + 0.5 * sin(uTime * 0.31))) * sqrt(max(1.0 - yy * yy, 0.0));
          float pupil = (1.0 - smoothstep(pw - aa, pw + aa, abs(lp.x))) * step(abs(lp.y), ph);
          vec3 col = iris * (1.0 - pupil * 0.97);
          vec2 gq = p0 - vec2(-0.075, 0.06);
          col += vec3(1.0, 0.96, 0.88) * exp(-dot(gq, gq) * 1600.0) * 1.6 * (1.0 - uBlink);
          return vec4(col, mask);
        }
        void main() {
          vec2 q = vQ;
          float aa = fwidth(q.x) * 1.25 + 1e-4;
          // ears
          vec2 qe = vec2(abs(q.x), q.y);
          float ear = sdTri(qe, vec2(${EAR[0]}, ${EAR[1]}), vec2(${EAR[2]}, ${EAR[3]}), vec2(${EAR[4]}, ${EAR[5]})) - ${EAR[6]};
          float head = length(q) - 1.0;
          float earMask = 1.0 - smoothstep(-aa, aa, ear);
          float outside = smoothstep(0.98, 1.04, length(q));
          float rim = exp(-max(ear, 0.0) / 0.022) * outside * smoothstep(0.35, 0.7, q.y);
          float inner = 1.0 - smoothstep(-aa, aa, sdTri(qe, vec2(0.34, 1.0), vec2(0.76, 0.72), vec2(0.75, 1.36)) + 0.01);
          // eyes
          vec4 L = eye(q - vec2(-0.43, 0.1), -1.0, aa);
          vec4 Rr = eye(q - vec2(0.43, 0.1), 1.0, aa);
          float eyeA = max(L.a, Rr.a);
          vec3 eyeC = (L.rgb * L.a + Rr.rgb * Rr.a) * uEyeGain;
          // soft glow around the eyes
          vec2 pl = (q - vec2(-0.43, 0.1)) / vec2(0.34, 0.14 + 0.1 * (1.0 - uBlink));
          vec2 pr = (q - vec2(0.43, 0.1)) / vec2(0.34, 0.14 + 0.1 * (1.0 - uBlink));
          float glow = exp(-max(length(pl) - 0.9, 0.0) * 5.5) + exp(-max(length(pr) - 0.9, 0.0) * 5.5);
          vec3 col = eyeC + uIris * glow * 0.3 * (1.0 - eyeA) * (1.0 - earMask) * (1.0 - 0.7 * uBlink);
          col += uRim * rim * 1.8 * (1.0 - earMask);
          col += uCool * inner * earMask * 0.035;
          float alpha = max(eyeA, earMask * outside);
          gl_FragColor = vec4(col, alpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), faceMat);
    face.renderOrder = 3;
    face.frustumCulled = false;
    scene.add(face);
    // depth-only copy of the ears: whatever glows behind them (far side of the disk, jets) stays hidden
    const earDepth = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uSize: faceMat.uniforms.uSize, uR: faceMat.uniforms.uR, uForward: faceMat.uniforms.uForward },
        vertexShader: BILLBOARD_VERT,
        fragmentShader: /* glsl */ `
          varying vec2 vQ;
          ${SDTRI}
          void main() {
            vec2 qe = vec2(abs(vQ.x), vQ.y);
            float ear = sdTri(qe, vec2(${EAR[0]}, ${EAR[1]}), vec2(${EAR[2]}, ${EAR[3]}), vec2(${EAR[4]}, ${EAR[5]})) - ${EAR[6]};
            if (ear > 0.0 || length(vQ) < 0.99) discard;
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          }`,
        colorWrite: false,
        depthWrite: true,
      }),
    );
    earDepth.renderOrder = 1;
    earDepth.frustumCulled = false;
    scene.add(earDepth);
  }
  await pause();

  /* ------------------------------------------------------ accretion disk */
  progress(0.34, "Spinning the disk");
  // Radial sampling: a smooth profile carved into ringlets and a few clear gaps, like Saturn's rings.
  const NB = 2048;
  const cdf = new Float64Array(NB + 1);
  {
    const n1 = new Float32Array(97);
    const n2 = new Float32Array(401);
    for (let i = 0; i < n1.length; i++) n1[i] = R();
    for (let i = 0; i < n2.length; i++) n2[i] = R();
    const noise1 = (tab, x) => {
      const f = clamp(x, 0, 0.9999) * (tab.length - 1);
      const i = Math.floor(f);
      const t = f - i;
      const s = t * t * (3 - 2 * t);
      return tab[i] + (tab[i + 1] - tab[i]) * s;
    };
    const GAPS = [
      [5.35, 0.08, 0.55],
      [7.25, 0.17, 0.82],
      [10.7, 0.3, 0.7],
      [13.3, 0.15, 0.6],
      [15.4, 0.22, 0.5],
    ];
    for (let i = 0; i < NB; i++) {
      const r = INNER + ((RMAX - INNER) * (i + 0.5)) / NB;
      const x = (r - INNER) / (RMAX - INNER);
      let w = (0.5 + 0.5 * noise1(n1, x)) * (0.72 + 0.28 * noise1(n2, x));
      for (const [gr, gw, gd] of GAPS) w *= 1 - gd * Math.exp(-(((r - gr) / gw) ** 2));
      w *= 0.4 + 0.6 * Math.pow(INNER / r, 0.4);
      cdf[i + 1] = cdf[i] + w;
    }
  }
  const sampleR = () => {
    const u = R() * cdf[NB];
    let lo = 0;
    let hi = NB;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] <= u) lo = mid;
      else hi = mid;
    }
    return INNER + ((RMAX - INNER) * (lo + R())) / NB;
  };
  const scaleH = (r) => 0.17 + 0.045 * Math.pow(Math.max(r - INNER, 0), 1.25); // vertical scale height (flares out)

  const diskU = {
    uTime: U.uTime,
    uSpin: { value: reduced ? 0.22 : 0.6 },
    uInner: { value: INNER },
    uOuter: U.uOuter,
    uGain: U.uGain,
    uPulse: U.uPulse,
    uHot: { value: hot },
    uMid: { value: amber.clone().lerp(C("#ff7a2a"), 0.3) },
    uWarm: { value: warm },
    uCool: { value: violet },
    uPx: px,
    uLensRs: U.uLensRs,
  };
  {
    const n = TIER.disk;
    const orb = new Float32Array(n * 3); // (position) r, phi, vertical amplitude
    const dat = new Float32Array(n * 4); // node, world size, brightness, clump seed
    const life = new Float32Array(n * 3); // clump / plunge life and phase (orbital-clock units), kind (0 smooth, 1 clump, 2 plunging)
    let i = 0;
    const put = (r, phi, h, size, bright, seed, kind, L, off) => {
      orb.set([r, phi, h], i * 3);
      dat.set([R() * TAU, size, bright, seed], i * 4);
      life.set([L, off, kind], i * 3);
      i++;
    };
    const nPlunge = Math.round(n * 0.015);
    const nClump = Math.round(n * 0.42);
    // clumps: knots of matter that are sheared into arcs by the differential rotation, fade, and form again elsewhere
    while (i < nClump) {
      const rc = sampleR();
      const pc = R() * TAU;
      const members = 24 + Math.floor(R() * 90);
      const dr = (0.04 + R() * 0.2) * (0.6 + rc / 10);
      const dp = 0.02 + R() * 0.11;
      const L = 9 + R() * 26;
      const off = R() * L;
      const b = 1.4 + R() * 1.8;
      const seed = R();
      for (let m = 0; m < members && i < nClump; m++) {
        const r = clamp(rc + gauss() * dr, INNER * 0.99, RMAX);
        put(r, pc + gauss() * dp, gauss() * scaleH(r) * 0.8, 0.028 + R() * 0.04, b * (0.6 + R() * 0.6), seed, 1, L, off);
      }
    }
    // matter plunging from the inner edge into the hole
    for (let k = 0; k < nPlunge; k++) put(INNER, R() * TAU, gauss() * 0.12, 0.03 + R() * 0.03, 1.2 + R() * 1.2, R(), 2, 3 + R() * 5, R() * 8);
    // the smooth bulk
    while (i < n) {
      const r = sampleR();
      put(r, R() * TAU, gauss() * scaleH(r), 0.026 + Math.pow(R(), 2) * 0.06, 0.35 + R() * 0.45, R(), 0, 0, 0);
    }
    // shuffle so any prefix of the buffer is a fair sample (the second lensed image draws only a prefix)
    const swap = (arr, w, a, b) => {
      for (let k = 0; k < w; k++) {
        const t = arr[a * w + k];
        arr[a * w + k] = arr[b * w + k];
        arr[b * w + k] = t;
      }
    };
    for (let a = n - 1; a > 0; a--) {
      const b = Math.floor(R() * (a + 1));
      swap(orb, 3, a, b);
      swap(dat, 4, a, b);
      swap(life, 3, a, b);
    }
    const aOrb = new THREE.BufferAttribute(orb, 3);
    const aDat = new THREE.BufferAttribute(dat, 4);
    const aLife = new THREE.BufferAttribute(life, 3);
    const vert = /* glsl */ `
      attribute vec4 aDat;
      attribute vec3 aLife;
      uniform float uPx;
      uniform float uK;
      uniform float uImg;
      varying vec3 vCol;
      ${GLSL_NOISE}
      ${LENS}
      ${HASH11}
      ${DISK}
      void main() {
        float T = uTime * uSpin;
        float r = position.x;
        float env = 1.0;
        float phi;
        float kind = aLife.z;
        if (kind < 0.5) {
          phi = position.y + pow(uInner / r, 1.5) * T;
        } else if (kind < 1.5) {
          float L = aLife.x;
          float tt = T + aLife.y;
          float k = floor(tt / L);
          float tau = tt - k * L;
          phi = position.y + hash11(k * 7.31 + aDat.w * 113.7) * 6.2831853 + pow(uInner / r, 1.5) * tau;
          env = sin(3.14159265 * tau / L);
          env *= env;
        } else {
          float L = aLife.x;
          float tt = T + aLife.y;
          float k = floor(tt / L);
          float f = (tt - k * L) / L;
          float ff = f * f;
          r = mix(uInner * 1.01, ${(BH * 0.97).toFixed(3)}, ff);
          phi = position.y + hash11(k * 3.71 + aDat.w * 71.3) * 6.2831853 + f * L * (1.0 + 1.4 * ff);
          env = smoothstep(0.0, 0.15, f) * (1.0 - smoothstep(0.7, 1.0, f));
        }
        float y = position.z * sin(phi + aDat.x);
        vec3 p = vec3(cos(phi) * r, y, sin(phi) * r);
        vec4 mv0 = modelViewMatrix * vec4(p, 1.0);
        float mag; vec2 er, st;
        vec3 mv = lensImage(mv0.xyz, uImg, mag, er, st);
        if (mag <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); return; }
        float rn;
        vec3 col = diskLight(r, phi, emitDir(mv0.xyz, mv), T, rn);
        // a lensed blob of gas keeps its surface brightness: it grows, it doesn't brighten
        float depth = -mv.z;
        float ps = aDat.y * (0.8 + 1.0 * clamp(rn, 0.0, 1.0)) * uPx / max(depth, 0.05) * sqrt(min(mag, 6.0));
        float k = aDat.z * env * uK * smoothstep(-0.015, 0.02, rn + step(1.5, kind));
        if (kind < 1.5) {
          float sf = streakField(phi, r, T);
          k *= kind < 0.5 ? 0.12 + 1.9 * sf * sf : 0.45 + 0.9 * sf;
        }
        const float MINP = 1.4;
        k *= min(1.0, ps * ps / (MINP * MINP));
        ps = clamp(ps, MINP, 22.0);
        k *= smoothstep(0.3, 1.6, depth);
        vCol = col * k;
        gl_PointSize = ps;
        gl_Position = projectionMatrix * vec4(mv, 1.0);
      }`;
    const makeMat = (img) =>
      new THREE.ShaderMaterial({
        uniforms: { ...diskU, uK: { value: 0.9 }, uImg: { value: img } },
        vertexShader: vert,
        fragmentShader: SOFT_POINT_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", aOrb);
    g.setAttribute("aDat", aDat);
    g.setAttribute("aLife", aLife);
    const disk = new THREE.Points(g, makeMat(1));
    disk.frustumCulled = false;
    disk.renderOrder = 4;
    scene.add(disk);
    // the second image: the far side seen under (or over) the shadow, squeezed against the photon ring
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", aOrb);
    g2.setAttribute("aDat", aDat);
    g2.setAttribute("aLife", aLife);
    g2.setDrawRange(0, Math.round(n * TIER.second));
    const disk2 = new THREE.Points(g2, makeMat(-1));
    disk2.frustumCulled = false;
    disk2.renderOrder = 4;
    scene.add(disk2);
  }
  await pause();

  // Gas: the disk's main light. Thin soft sprites stretched along the orbit, lit by the sheared streak pattern, so the
  // disk reads as a smooth glowing volume with streaks in it; behind the hole they bend into arcs around the shadow.
  {
    const n = TIER.gas;
    const orb = new Float32Array(n * 4);
    const gas = new Float32Array(n * 4); // radial half-width, stretch along the orbit, brightness, seed
    for (let i = 0; i < n; i++) {
      // most of the gas sits in the bright inner disk: out where the disk is faint the particles carry it
      const r = R() < 0.35 ? sampleR() : INNER + (RMAX - INNER) * Math.pow(R(), 2.2);
      orb.set([r, R() * TAU, gauss() * scaleH(r), R() * TAU], i * 4);
      gas.set([0.1 + R() * 0.18, 3 + R() * 6, 0.7 + R() * 0.6, R()], i * 4);
    }
    const quad = new THREE.PlaneGeometry(2, 2);
    const mk = (count) => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = quad.index;
      g.setAttribute("position", quad.attributes.position);
      g.setAttribute("aOrb", orbAttr);
      g.setAttribute("aGas", gasAttr);
      g.instanceCount = count;
      return g;
    };
    const orbAttr = new THREE.InstancedBufferAttribute(orb, 4);
    const gasAttr = new THREE.InstancedBufferAttribute(gas, 4);
    const vert = /* glsl */ `
      attribute vec4 aOrb;
      attribute vec4 aGas;
      uniform float uK;
      uniform float uImg;
      varying vec2 vQ;
      varying vec3 vCol;
      ${GLSL_NOISE}
      ${LENS}
      ${DISK}
      void main() {
        float T = uTime * uSpin;
        float r = aOrb.x;
        float phi = aOrb.y + pow(uInner / r, 1.5) * T;
        float y = aOrb.z * sin(phi + aOrb.w);
        vec3 p = vec3(cos(phi) * r, y, sin(phi) * r);
        float rn = (r - uInner) / max(uOuter - uInner, 0.1);
        vec4 mv0 = modelViewMatrix * vec4(p, 1.0);
        vec3 tv = mat3(modelViewMatrix) * vec3(-sin(phi), 0.0, cos(phi));
        float tl = length(tv.xy);
        vec2 ax = tl > 1e-4 ? tv.xy / tl : vec2(1.0, 0.0);
        vec2 ay = vec2(-ax.y, ax.x);
        float size = aGas.x * (0.8 + 0.9 * clamp(rn, 0.0, 1.0));
        vec2 off = ax * position.x * size * (1.0 + aGas.y * tl) + ay * position.y * size;
        float mag; vec2 er, st;
        vec3 c = lensImage(mv0.xyz, uImg, mag, er, st);
        if (mag <= 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vCol = vec3(0.0); vQ = vec2(0.0); return; }
        float rn2;
        vec3 col = diskLight(r, phi, emitDir(mv0.xyz, c), T, rn2);
        float sf = streakField(phi, r, T);
        col *= 0.08 + 2.1 * sf * sf;
        vec2 et = vec2(-er.y, er.x);
        // stretch around the ring, but never so far that a straight sprite leaves the ring's curve
        vec3 hc = viewMatrix[3].xyz;
        float bImg = hc.z < -0.01 ? length(c.xy - hc.xy * (c.z / hc.z)) : 1e6;
        float hl = abs(dot(ax, et)) * size * (1.0 + aGas.y * tl) + abs(dot(ay, et)) * size;
        float sx = clamp(st.x, 0.5, max(1.0, 0.45 * bImg / max(hl, 1e-3)));
        off = er * dot(off, er) * clamp(st.y, 0.1, 2.0) + et * dot(off, et) * sx;
        float depth = -c.z;
        vQ = position.xy;
        vCol = col * aGas.z * uK * smoothstep(size * 1.5, size * 5.0, depth) * smoothstep(-0.02, 0.04, rn);
        gl_Position = projectionMatrix * vec4(c.xy + off, c.z, 1.0);
      }`;
    const frag = /* glsl */ `
      varying vec2 vQ;
      varying vec3 vCol;
      void main() {
        float d = dot(vQ, vQ);
        if (d > 1.0) discard;
        gl_FragColor = vec4(vCol * exp(-d * 3.2) * (1.0 - d), 1.0);
      }`;
    const mat = (img, k) =>
      new THREE.ShaderMaterial({
        uniforms: { ...diskU, uK: { value: k }, uImg: { value: img } },
        vertexShader: vert,
        fragmentShader: frag,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    const gk = 0.3 * (TIERS.high.gas / n);
    const gas1 = new THREE.Mesh(mk(n), mat(1, gk));
    gas1.frustumCulled = false;
    gas1.renderOrder = 4;
    scene.add(gas1);
    const n2 = Math.round(n * 0.5);
    const gas2 = new THREE.Mesh(mk(n2), mat(-1, gk));
    gas2.frustumCulled = false;
    gas2.renderOrder = 4;
    scene.add(gas2);
    disposables.push(quad);
  }
  await pause();

  /* --------------------------------------------------------- jets + dust */
  progress(0.6, "Stirring the dust");
  let jetMat;
  const jetU = { uGain: { value: 0.05 } };
  {
    const cg = new THREE.CylinderGeometry(0.2, 1.9, 36, 36, 16, true);
    cg.translate(0, 18 + BH * 0.6, 0);
    jetMat = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uColor: { value: violet.clone().lerp(C("#b8c6ff"), 0.35) }, uGain: jetU.uGain, uMotion: U.uMotion },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vWorld = wp.xyz;
          vUv = uv;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uGain;
        uniform float uMotion;
        varying vec3 vN;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          vec3 V = normalize(cameraPosition - vWorld);
          float facing = pow(abs(dot(normalize(vN), V)), 1.5);
          float along = vUv.y;
          float tw = uTime * uMotion;
          float flow = vnoise(vec2(vUv.x * 12.0, along * 9.0 - tw * 1.5));
          float helix = 0.5 + 0.5 * sin(vUv.x * 12.566 - along * 24.0 + tw * 2.2);
          float knots = pow(vnoise(vec2(2.7, along * 6.0 - tw * 0.8)), 3.0) * 0.9;
          float k = facing * smoothstep(0.0, 0.07, along) * pow(1.0 - along, 1.7) * (0.3 + 0.55 * flow + 0.25 * helix * flow + knots);
          gl_FragColor = vec4(uColor * k * uGain, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const up = new THREE.Mesh(cg, jetMat);
    const down = new THREE.Mesh(cg, jetMat);
    down.rotation.x = Math.PI;
    up.renderOrder = down.renderOrder = 1;
    up.frustumCulled = down.frustumCulled = false;
    scene.add(up, down);
    // particles streaming out along the jets on a slow helix
    const n = TIER.jet;
    const aj = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) aj.set([R(), 0.6 + R() * 0.8, Math.pow(R(), 0.6), R() < 0.5 ? 0 : 1], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aJ", new THREE.BufferAttribute(aj, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uMotion: U.uMotion, uGain: jetU.uGain, uPx: px, uLensRs: U.uLensRs, uColor: { value: violet.clone().lerp(C("#dfe6ff"), 0.55) } },
      vertexShader: /* glsl */ `
        attribute vec4 aJ;
        uniform float uTime;
        uniform float uMotion;
        uniform float uGain;
        uniform float uPx;
        uniform vec3 uColor;
        varying vec3 vCol;
        ${LENS}
        void main() {
          float t = fract(uTime * uMotion * aJ.y * 0.04 + aJ.x);
          float h = mix(${(BH * 1.6).toFixed(2)}, 42.0, t);
          float side = aJ.w > 0.5 ? 1.0 : -1.0;
          float rad = (0.25 + h * 0.085) * aJ.z;
          float a = aJ.x * 6.2831853 * 7.0 + h * 0.35 + uTime * uMotion * 0.6;
          vec3 p = vec3(cos(a) * rad, side * h, sin(a) * rad);
          vec4 mv0 = modelViewMatrix * vec4(p, 1.0);
          float mag; vec2 er, st;
          vec3 mv = lensImage(mv0.xyz, 1.0, mag, er, st);
          float depth = -mv.z;
          float ps = (0.1 + 0.08 * aJ.z) * uPx / max(depth, 0.1);
          float k = pow(1.0 - t, 1.8) * smoothstep(0.0, 0.15, t) * uGain * 2.6;
          k *= min(1.0, ps * ps / 2.25);
          vCol = uColor * k * smoothstep(0.5, 2.0, depth);
          gl_PointSize = clamp(ps, 1.5, 16.0);
          gl_Position = projectionMatrix * vec4(mv, 1.0);
        }`,
      fragmentShader: SOFT_POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const jp = new THREE.Points(g, m);
    jp.frustumCulled = false;
    jp.renderOrder = 1;
    scene.add(jp);
  }
  {
    // a thick halo of dust grains around the disk, out past its edge
    const n = TIER.halo;
    const orb = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const r = INNER + 0.6 + Math.pow(R(), 1.5) * 30;
      orb.set([r, R() * TAU, gauss() * (0.12 + (r - INNER) * 0.075), R()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aOrbit", new THREE.BufferAttribute(orb, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uPx: px,
        uOuter: U.uOuter,
        uInner: { value: INNER },
        uSpin: diskU.uSpin,
        uHot: { value: hot },
        uMid: { value: amber },
        uCool: { value: violet.clone().lerp(C("#c8d0ff"), 0.25) },
        uGain: U.uGain,
        uMotion: U.uMotion,
        uLensRs: U.uLensRs,
      },
      vertexShader: /* glsl */ `
        attribute vec4 aOrbit;
        uniform float uTime;
        uniform float uPx;
        uniform float uOuter;
        uniform float uInner;
        uniform float uSpin;
        uniform float uGain;
        uniform float uMotion;
        uniform vec3 uHot;
        uniform vec3 uMid;
        uniform vec3 uCool;
        varying vec3 vCol;
        ${LENS}
        void main() {
          float r = aOrbit.x;
          float a = aOrbit.y + uTime * uSpin * pow(uInner / r, 1.5);
          vec3 p = vec3(cos(a) * r, aOrbit.z * (0.85 + 0.15 * sin(a * 2.0 + aOrbit.w * 20.0)), sin(a) * r);
          vec4 mv0 = modelViewMatrix * vec4(p, 1.0);
          float mag; vec2 er, st;
          vec3 mv = lensImage(mv0.xyz, 1.0, mag, er, st);
          mag = min(mag, 5.0);
          float rn = (r - uInner) / max(uOuter - uInner, 0.1);
          vec3 c = mix(uHot, uMid, smoothstep(0.0, 0.25, rn));
          c = mix(c, uCool, smoothstep(0.2, 0.9, rn));
          float fade = 1.0 - smoothstep(1.1, 2.6, rn);
          float tw = 0.65 + 0.35 * sin(uTime * uMotion * 2.0 + aOrbit.w * 50.0);
          float depth = -mv.z;
          float ps = (0.045 + aOrbit.w * 0.07) * uPx / max(depth, 0.1) * sqrt(mag);
          float k = fade * tw * (0.4 + aOrbit.w) * 0.3 * uGain;
          k *= min(1.0, ps * ps / 2.25);
          k *= smoothstep(0.4, 2.2, depth);
          vCol = c * k;
          gl_PointSize = clamp(ps, 1.5, 18.0);
          gl_Position = projectionMatrix * vec4(mv, 1.0);
        }`,
      fragmentShader: SOFT_POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(g, m);
    dust.frustumCulled = false;
    dust.renderOrder = 5;
    scene.add(dust);
  }
  await pause();

  /* --------------------------------------------------------- creatures */
  progress(0.74, "Aligning the stars");
  const MAX = maxCreatures;
  const trails = new Trails({ max: MAX, len: 22, minStep: 0.2, intensity: 2.0 });
  const halos = new Halos({ max: MAX, px, intensity: 2.3, flare: 1 });
  scene.add(trails.mesh, halos.points);
  for (let i = 0; i < MAX; i++) halos.hide(i);

  // absorption flashes
  const FL = 16;
  const flashPos = new Float32Array(FL * 3);
  const flashAge = new Float32Array(FL).fill(99);
  const flashSize = new Float32Array(FL);
  const fg = new THREE.BufferGeometry();
  const aFlashPos = new THREE.BufferAttribute(flashPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aFlashAge = new THREE.BufferAttribute(flashAge, 1).setUsage(THREE.DynamicDrawUsage);
  const aFlashSize = new THREE.BufferAttribute(flashSize, 1).setUsage(THREE.DynamicDrawUsage);
  fg.setAttribute("position", aFlashPos);
  fg.setAttribute("aAge", aFlashAge);
  fg.setAttribute("aSize", aFlashSize);
  const flashes = new THREE.Points(
    fg,
    new THREE.ShaderMaterial({
      uniforms: { uPx: px, uColor: { value: hot } },
      vertexShader: /* glsl */ `
        attribute float aAge;
        attribute float aSize;
        uniform float uPx;
        varying float vK;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float t = clamp(aAge, 0.0, 1.0);
          vK = (1.0 - t) * (1.0 - t) * step(aAge, 1.0);
          gl_PointSize = clamp(aSize * (0.6 + t * 2.2) * uPx / max(-mv.z, 0.1), 0.0, 220.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vK;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d = length(q);
          if (d > 1.0 || vK <= 0.0) discard;
          float ringK = exp(-pow((d - 0.7) / 0.12, 2.0)) * 0.8 + exp(-d * d * 10.0) * 1.6;
          gl_FragColor = vec4(uColor * ringK * vK * 2.2, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  flashes.frustumCulled = false;
  flashes.renderOrder = 7;
  scene.add(flashes);
  let flashNext = 0;
  function flash(p, size) {
    const i = flashNext++ % FL;
    flashPos[i * 3] = p.x;
    flashPos[i * 3 + 1] = p.y;
    flashPos[i * 3 + 2] = p.z;
    flashAge[i] = 0;
    flashSize[i] = size;
  }

  const slots = new Array(MAX).fill(null);
  const byId = new Map();
  const order = [];
  const buyCol = amber.clone().lerp(C("#ffe2a0"), 0.35);
  const sellCol = downCol.clone();
  const speedK = reduced ? 0.45 : 1;
  let presim = false;
  let selectedId = null;
  let growth = 0.5,
    growthTarget = 0.5;
  const api = { onRemove: null };

  function kill(c) {
    if (!c.alive) return;
    c.alive = false;
    slots[c.slot] = null;
    byId.delete(c.id);
    const i = order.indexOf(c);
    if (i >= 0) order.splice(i, 1);
    trails.hide(c.slot);
    halos.hide(c.slot);
    if (api.onRemove) api.onRemove(c);
  }

  function place(c) {
    c.pos.set(Math.cos(c.theta) * c.r, c.y, Math.sin(c.theta) * c.r);
  }

  function step(c, dt) {
    c.age += dt;
    if (c.side === "buy") {
      const omega = 0.95 * Math.pow(6 / c.r, 1.5) * speedK;
      c.theta += omega * dt;
      c.r -= (0.32 + 7.5 / c.r) * dt * speedK * c.fall;
      c.y *= Math.exp(-dt * 0.2 * speedK * c.fall);
      c.fade = Math.min(1, c.age / 1.2);
      if (c.r <= INNER + 0.12) {
        place(c);
        if (!presim) {
          flash(c.pos, 1.4 + c.size * 0.9);
          U.uPulse.value = Math.min(1.6, U.uPulse.value + 0.18 + c.size * 0.12);
        }
        kill(c);
        return;
      }
      place(c);
    } else {
      c.vel.multiplyScalar(Math.max(0, 1 - dt * 0.04));
      // keep a little of the disk's spin
      const r = Math.hypot(c.pos.x, c.pos.z);
      const sw = (0.6 * speedK) / Math.max(r, 2);
      c.pos.addScaledVector(c.vel, dt * speedK);
      const a = sw * dt;
      const x = c.pos.x,
        z = c.pos.z;
      c.pos.x = x * Math.cos(a) - z * Math.sin(a);
      c.pos.z = x * Math.sin(a) + z * Math.cos(a);
      const d = c.pos.length();
      c.fade = Math.min(1, c.age / 0.4) * (d > 42 ? Math.max(0, 1 - (d - 42) / 16) : 1);
      if (d > 58 || c.age > 40) kill(c);
    }
  }

  api.spawn = (trade, { age = 0 } = {}) => {
    if (byId.has(trade.id)) return byId.get(trade.id);
    let slot = slots.indexOf(null);
    if (slot < 0) {
      kill(order[0]);
      slot = slots.indexOf(null);
    }
    const c = {
      id: trade.id,
      trade,
      slot,
      side: trade.side,
      size: sizeForUsd(trade.usd),
      pos: V3(),
      vel: V3(),
      r: 0,
      theta: R() * TAU,
      y: 0,
      age: 0,
      fade: 0,
      fall: 0.85 + R() * 0.3,
      alive: true,
      born: performance.now(),
    };
    if (c.side === "buy") {
      c.r = 24 + R() * 10;
      c.y = (R() - 0.5) * 16;
      place(c);
    } else {
      const r0 = INNER + 0.5 + R() * 1.2;
      c.pos.set(Math.cos(c.theta) * r0, (R() - 0.5) * 0.3, Math.sin(c.theta) * r0);
      const outward = V3(Math.cos(c.theta), 0, Math.sin(c.theta));
      const tangent = V3(-Math.sin(c.theta), 0, Math.cos(c.theta));
      if (R() < 0.3) {
        // ejected along a jet
        c.vel.copy(outward).multiplyScalar(0.8 + R()).add(V3(0, (R() < 0.5 ? -1 : 1) * (6 + R() * 3), 0));
      } else {
        c.vel
          .copy(outward)
          .multiplyScalar(3.2 + R() * 2.6)
          .addScaledVector(tangent, 1.2 + R() * 1.5)
          .add(V3(0, (R() - 0.5) * 3.2, 0));
      }
    }
    slots[slot] = c;
    byId.set(c.id, c);
    order.push(c);
    trails.reset(slot, c.pos, c.side === "sell" ? sellCol : buyCol, 0.07 * c.size);
    if (age > 0) {
      // older trades start mid-flight (capped so seeded stars are still falling in, not already gone)
      const simAge = Math.min(age, c.side === "buy" ? 10 + R() * 12 : 8 + R() * 4);
      const stepDt = 1 / 15;
      const steps = Math.round(simAge / stepDt);
      presim = true;
      for (let i = 0; i < steps && c.alive; i++) {
        step(c, stepDt);
        if (c.alive) trails.push(slot, c.pos);
      }
      presim = false;
      c.born -= age * 1000;
    } else if (c.side === "buy") lookAtSoon(c);
    return c.alive ? c : null;
  };

  api.get = (id) => byId.get(id) || null;
  api.list = () => order;
  api.newest = () => {
    for (let i = order.length - 1; i >= 0; i--) if (order[i].alive) return order[i];
    return null;
  };
  api.select = (id) => {
    selectedId = id;
  };
  api.release = (filter) => {
    for (const c of order.slice()) if (filter(c) && c.side === "buy") c.fall = 3.5;
  };
  api.setGrowth = (g, immediate) => {
    growthTarget = clamp(g, 0, 1);
    if (immediate) growth = growthTarget;
    applyGrowth();
  };
  api.describe = (c) => (c.side === "sell" ? "Escaping the void" : c.r > 12 ? "Spiraling in" : "Crossing into the disk");
  api.goneText = (t) => (t.side === "sell" ? "Escaped into deep space" : "Swallowed by the void");
  const _m = V3();
  api.bloomMask = (camera) => {
    const d = camera.position.length();
    if (d < BH * 1.2) return null;
    _m.set(0, 0, 0).project(camera);
    if (_m.z > 1 || _m.z < -1) return null;
    const ang = Math.asin(BH / d);
    const r = (Math.tan(ang) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 0.5;
    // the face billboard sits just in front of the sphere, so it projects slightly larger
    const faceScale = Math.cos(ang) * (d / Math.max(d - BH * 1.02, 0.1));
    return { u: _m.x * 0.5 + 0.5, v: _m.y * 0.5 + 0.5, r, inner: 0.8, tri: mascotEyes ? EAR : null, triScale: faceScale };
  };
  api.followDistance = 3.4;
  api.look = { bloom: { strength: 0.62, radius: 0.12, threshold: 1.05 }, exposure: 0.7, clear: 0x000000 };
  api.scene = scene;

  function applyGrowth() {
    U.uOuter.value = lerp(9.5, 16.5, growth);
    U.uGain.value = lerp(0.55, 1.15, growth);
    jetU.uGain.value = lerp(0.018, 0.05, growth);
  }
  applyGrowth();

  api.view = (aspect = 16 / 9) => {
    const s = lerp(0.8, 1.0, growthTarget);
    const narrow = Math.max(1, 1.25 / Math.max(aspect, 0.3));
    const dist = (30 * s + 4) * Math.min(narrow, 1.8);
    const el = THREE.MathUtils.degToRad(15);
    const az = THREE.MathUtils.degToRad(18);
    return {
      pos: V3(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist + 0.6, Math.cos(az) * Math.cos(el) * dist),
      target: V3(0, 0.6, 0),
      fov: 45,
      limits: { minDistance: 8.5, maxDistance: 140, minPolar: 0.06, maxPolar: Math.PI - 0.06, flyRadius: 200, flyMinY: -200, flyMaxY: 200, flySpeed: 10 },
      autoRotateSpeed: 0.42,
      constrain: (p) => {
        if (p.lengthSq() < BH * BH * 2.6) p.setLength(BH * 1.62);
      },
    };
  };

  // ---------------------------------------------------------- eyes
  const eyes = {
    look: new THREE.Vector2(),
    want: new THREE.Vector2(),
    pointerAt: -10,
    nextSaccade: 1.5,
    blink: 0,
    blinkT: -1,
    nextBlink: 2 + R() * 3,
    double: false,
    glance: null,
  };
  const _c = V3();
  let now = 0;
  api.pointer = (nx, ny, camera) => {
    if (!faceMat || !camera) return;
    _c.set(0, 0, 0).project(camera);
    eyes.want.set(clamp((nx - _c.x) * 1.6, -1, 1), clamp((ny - _c.y) * 1.6, -1, 1));
    eyes.pointerAt = now;
  };
  function lookAtSoon(c) {
    eyes.glance = { id: c.id, until: now + 1.6 };
  }

  function updateEyes(dt, t, camera) {
    if (!faceMat) return;
    now = t;
    // idle: glance at a newborn star or wander
    if (now - eyes.pointerAt > 2.5) {
      const g = eyes.glance && now < eyes.glance.until ? byId.get(eyes.glance.id) : null;
      if (g) {
        _c.copy(g.pos).project(camera);
        const o = V3(0, 0, 0).project(camera);
        eyes.want.set(clamp((_c.x - o.x) * 1.4, -1, 1), clamp((_c.y - o.y) * 1.4, -1, 1));
      } else if (now > eyes.nextSaccade) {
        eyes.want.set((R() - 0.5) * 1.2, (R() - 0.5) * 0.7);
        if (R() < 0.35) eyes.want.set(0, 0);
        eyes.nextSaccade = now + 1.2 + R() * 2.8;
      }
    }
    eyes.look.lerp(eyes.want, damp(reduced ? 4 : 9, dt));
    faceMat.uniforms.uLook.value.copy(eyes.look);
    // blink
    if (eyes.blinkT < 0 && now > eyes.nextBlink) {
      eyes.blinkT = 0;
      eyes.double = R() < 0.18;
    }
    if (eyes.blinkT >= 0) {
      eyes.blinkT += dt;
      const dur = 0.26;
      const k = eyes.blinkT / dur;
      eyes.blink = k < 0.45 ? k / 0.45 : Math.max(0, 1 - (k - 0.45) / 0.55);
      if (k >= 1) {
        eyes.blink = 0;
        if (eyes.double) {
          eyes.double = false;
          eyes.blinkT = -0.001;
          eyes.nextBlink = now + 0.12;
        } else {
          eyes.blinkT = -1;
          eyes.nextBlink = now + 2.5 + R() * 4.5;
        }
      }
    }
    faceMat.uniforms.uBlink.value = eyes.blink;
  }

  const _col = new THREE.Color();
  api.update = (dt, t, camera) => {
    U.uTime.value = t;
    farGroup.position.copy(camera.position);
    if (renderer) U.uDpr.value = renderer.getPixelRatio();
    for (let i = 0; i < galaxies.length; i++) galaxies[i].rotateY(dt * 0.004 * motion * (i ? -1 : 1));
    if (Math.abs(growthTarget - growth) > 1e-4) {
      growth += (growthTarget - growth) * damp(0.9, dt);
      applyGrowth();
    }
    U.uPulse.value *= Math.exp(-dt * 1.6);
    for (let i = 0; i < FL; i++) if (flashAge[i] < 2) flashAge[i] += dt / (reduced ? 1.4 : 0.8);
    aFlashPos.needsUpdate = aFlashAge.needsUpdate = aFlashSize.needsUpdate = true;
    for (let i = 0; i < order.length; i++) {
      const c = order[i];
      step(c, dt);
      if (!c.alive) i--;
    }
    for (const c of order) {
      const sel = c.id === selectedId;
      trails.push(c.slot, c.pos);
      _col.copy(c.side === "sell" ? sellCol : buyCol).multiplyScalar(c.fade);
      trails.setColor(c.slot, _col);
      const hs = (sel ? 1.9 + 0.45 * Math.sin(t * 5) : 1.0) * (0.55 + 0.45 * c.size) * c.fade;
      halos.set(c.slot, c.pos, _col, hs);
    }
    trails.flush();
    halos.flush();
    updateEyes(dt, t, camera);
  };

  api.dispose = () => {
    trails.dispose();
    halos.dispose();
    disposeTree(scene);
    for (const d of disposables) d.dispose();
    if (skyBake) skyBake.cancel();
    if (skyRT) skyRT.dispose();
    skyRT = null;
    order.length = 0;
    byId.clear();
  };

  if (skyBake) {
    await Promise.race([skyBake.ready, new Promise((r) => setTimeout(r, 5000))]);
    skyBake.run();
  }
  progress(0.9, "Almost there");
  return api;
}
