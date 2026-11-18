// Pounce: a dark living room at night, a ginger tabby and a laser pointer.
// Trades are laser dots on the floor. A buy is a red dot that skitters in quick zigzags until the cat spots it,
// crouches, wiggles and pounces (several buys: chained pounces; a burst of buys: zoomies round the rug). A sell flicks
// off and zips away into the dark while the cat sits, flicks its tail or grooms. The cat grows with the market cap.
// All procedural: plank floor, rug, window and moonbeam, box, sofa, yarn, and the cat itself, whose body, legs and
// tail are lofted along a small rig and rebuilt on the CPU every frame.
import { THREE, GLSL_NOISE, Trails, Halos, clamp, lerp, damp, disposeTree, mergeGeometries } from "./common.js";
import { rng, sizeForUsd } from "./format.js";

export const POUNCE_DEFAULTS = { accent: "#ff3b5c", accent2: "#ff9f43", up: "#ffd36e", down: "#c23a52", bg: "#0b0807" };

const TAU = Math.PI * 2;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const C = (hex) => new THREE.Color(hex);
const pause = () => new Promise((r) => setTimeout(r, 0));
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/* ------------------------------------------------ room layout (1 unit ≈ 10 cm) */
const WALL_Z = -24;
const WIN = { x0: -7, x1: 7, y0: 4, y1: 19 }; // the window opening in the back wall
const MULL = { x: 0, y: 12.2, w: 0.3 }; // its cross bars (centre x, centre y, half width)
const MOON = V3(-0.32, 1, -1).normalize(); // toward the moon, through the window
const RUG = { x: 1, z: -6, w: 19, d: 13, h: 0.09 };
const BOX = { x: -12, z: -16.2, rot: 0.3, w: 6.8, d: 5.5, h: 3.5, t: 0.14 };
const SOFA = { x: 25.5, z: -5, len: 21, depth: 8.6 };
const SOFA_FRONT = SOFA.x - SOFA.depth / 2;
const PLAY = { x0: -8, x1: 12, z0: -18, z1: 2.5 }; // where the dots go
const HOME = V3(6.8, 0, -10.8); // the cat's favourite spot, in the moonlight
const LOOP = { x: 1, z: -5.5, rx: 10.5, rz: 6.8 }; // zoomies track round the rug
const YARN_R = 0.85;

/* ------------------------------------------------------------------ GLSL */

// Light shared by everything in the room: the moonbeam through the window (with the cross bars' shadow), the
// window's soft skylight, a warm fill from the room, the laser dots as small point lights, fog and darkness away
// from the middle of the room.
const roomGlsl = (maxd) => /* glsl */ `
#define MAXD ${maxd}
uniform float uTime;
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uSkyCol;
uniform float uWallZ;
uniform vec4 uWin;
uniform vec3 uMull;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform vec3 uFillDir;
uniform vec3 uFillCol;
uniform vec3 uFogCol;
uniform float uFogK;
uniform float uFogNear;
uniform vec4 uRoom;
uniform vec4 uDotA[MAXD];
uniform vec4 uDotB[MAXD];
uniform int uDotN;
float paneMask(vec2 h, float soft) {
  float fx = smoothstep(uWin.x - soft, uWin.x + soft, h.x) * (1.0 - smoothstep(uWin.y - soft, uWin.y + soft, h.x));
  float fy = smoothstep(uWin.z - soft, uWin.z + soft, h.y) * (1.0 - smoothstep(uWin.w - soft, uWin.w + soft, h.y));
  float mx = smoothstep(uMull.z - soft, uMull.z + soft, abs(h.x - uMull.x));
  float my = smoothstep(uMull.z - soft, uMull.z + soft, abs(h.y - uMull.y));
  return fx * fy * mx * my;
}
float moonMask(vec3 wp) {
  float t = (uWallZ - wp.z) / uMoonDir.z;
  if (t <= 0.0) return 0.0;
  vec3 h = wp + uMoonDir * t;
  return paneMask(h.xy, 0.06 + t * 0.02);
}
float roomFade(vec3 wp) {
  vec2 q = (wp.xz - uRoom.xy) / uRoom.z;
  return exp(-dot(q, q));
}
vec3 dotLight(vec3 wp, vec3 n) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < MAXD; i++) {
    if (i >= uDotN) break;
    vec4 a = uDotA[i];
    vec3 d = a.xyz - wp;
    float dd = dot(d, d);
    float r2 = a.w * a.w;
    float fall = (1.0 / (1.0 + dd / r2)) * (1.0 - smoothstep(r2 * 4.0, r2 * 16.0, dd));
    float lam = clamp(dot(n, d * inversesqrt(dd + 1e-4)) * 0.8 + 0.2, 0.0, 1.0);
    sum += uDotB[i].rgb * fall * lam;
  }
  return sum;
}
vec3 fogIt(vec3 col, vec3 wp) {
  float d = length(wp - cameraPosition);
  return mix(col, uFogCol, 1.0 - exp(-max(d - uFogNear, 0.0) * uFogK));
}
vec3 lightProp(vec3 base, vec3 n, vec3 wp, float ao) {
  float fade = roomFade(wp);
  vec3 amb = mix(uAmbBot, uAmbTop, n.y * 0.5 + 0.5);
  float sky = max(dot(n, normalize(vec3(uMoonDir.x, 0.3, uMoonDir.z))), 0.0) * 0.7 + 0.3;
  vec3 l = (amb + uSkyCol * sky) * fade * ao;
  l += uFillCol * max(dot(n, uFillDir), 0.0) * fade * 0.6 * ao;
  l += uMoonCol * moonMask(wp) * max(dot(n, uMoonDir), 0.0);
  l += dotLight(wp, n);
  return base * l;
}
`;

// Soft contact shadow under the cat, and its shadow in the moonbeam.
const CAT_SHADOW = /* glsl */ `
uniform vec4 uCatSh;
uniform vec4 uCatShD;
uniform vec4 uCatMoon;
float catShadow(vec2 p) {
  vec2 d = p - uCatSh.xy;
  vec2 f = uCatShD.xy;
  vec2 q = vec2(dot(d, f) / uCatShD.z, dot(d, vec2(-f.y, f.x)));
  return (1.0 - smoothstep(0.15, 1.0, length(q) / max(uCatSh.z, 1e-3))) * uCatSh.w;
}
float catMoonShadow(vec2 p) {
  vec2 d = p - uCatMoon.xy;
  vec2 L = normalize(uMoonDir.xz);
  vec2 q = vec2(dot(d, L) / uCatMoon.z, dot(d, vec2(-L.y, L.x)) / uCatMoon.w);
  return (1.0 - smoothstep(0.3, 1.0, length(q))) * uCatShD.w;
}
float rectDist(vec2 p, vec2 c, vec2 hs, float a) {
  vec2 d = p - c;
  float cs = cos(a), sn = sin(a);
  d = vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  vec2 q = abs(d) - hs;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
`;

const WORLD_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vN;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/* ============================================================== the scene */

export async function createPounce(ctx) {
  const { palette, quality, reduced, px, progress = () => {}, maxCreatures = 60 } = ctx;
  const HIGH = quality === "high";
  const LOW = quality === "low";
  const MAXD = HIGH ? 12 : LOW ? 6 : 8;
  const R = rng(20261001);
  const scene = new THREE.Scene();
  const scratch = []; // build-time geometries that never reach the scene

  const laser = palette.accent.clone();
  const furCol = palette.accent2.clone();
  const downCol = palette.down.clone();
  const bg = palette.bg.clone();

  const U = {
    uTime: { value: 0 },
    uMoonDir: { value: MOON.clone() },
    uMoonCol: { value: new THREE.Color(0.95, 1.05, 1.35) },
    uSkyCol: { value: new THREE.Color(0.11, 0.13, 0.21) },
    uWallZ: { value: WALL_Z },
    uWin: { value: new THREE.Vector4(WIN.x0, WIN.x1, WIN.y0, WIN.y1) },
    uMull: { value: V3(MULL.x, MULL.y, MULL.w) },
    uAmbTop: { value: new THREE.Color(0.1, 0.1, 0.15) },
    uAmbBot: { value: new THREE.Color(0.15, 0.09, 0.06) },
    uFillDir: { value: V3(0.55, 0.6, 0.75).normalize() },
    uFillCol: { value: new THREE.Color(0.44, 0.27, 0.16) },
    uFogCol: { value: bg.clone() },
    uFogK: { value: 0.035 },
    uFogNear: { value: 26 },
    uRoom: { value: new THREE.Vector4(1, -6, 30, 0) },
    uDotA: { value: Array.from({ length: MAXD }, () => new THREE.Vector4()) },
    uDotB: { value: Array.from({ length: MAXD }, () => new THREE.Vector4()) },
    uDotN: { value: 0 },
    // cat shadows
    uCatSh: { value: new THREE.Vector4(0, 0, 2, 0) },
    uCatShD: { value: new THREE.Vector4(0, 1, 1.5, 0.7) },
    uCatMoon: { value: new THREE.Vector4(0, 0, 3, 1.5) },
  };
  const RU = {};
  for (const k of ["uTime", "uMoonDir", "uMoonCol", "uSkyCol", "uWallZ", "uWin", "uMull", "uAmbTop", "uAmbBot", "uFillDir", "uFillCol", "uFogCol", "uFogK", "uFogNear", "uRoom", "uDotA", "uDotB", "uDotN"]) RU[k] = U[k];
  const SHU = { uCatSh: U.uCatSh, uCatShD: U.uCatShD, uCatMoon: U.uCatMoon };
  const ROOM = roomGlsl(MAXD);
  const winGlow = new THREE.Color(0.32, 0.38, 0.58);
  const boxAO = { value: new THREE.Vector4(BOX.x, BOX.z, BOX.w / 2, BOX.d / 2) };
  const sofaAO = { value: new THREE.Vector4(SOFA.x, SOFA.z, SOFA.depth / 2, SOFA.len / 2 + 0.6) };

  /* --------------------------------------------------------- floor */
  progress(0.06, "Laying the floorboards");
  {
    const g = new THREE.PlaneGeometry(170, 110, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, WALL_Z + 55);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...RU,
        ...SHU,
        uWoodA: { value: C("#5e3a22") },
        uWoodB: { value: C("#8a5a36") },
        uWinGlow: { value: winGlow },
        uBoxAO: boxAO,
        uBoxRot: { value: BOX.rot },
        uSofaAO: sofaAO,
        uDetail: { value: LOW ? 0 : 1 },
      },
      vertexShader: WORLD_VERT,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        CAT_SHADOW +
        /* glsl */ `
        uniform vec3 uWoodA;
        uniform vec3 uWoodB;
        uniform vec3 uWinGlow;
        uniform vec4 uBoxAO;
        uniform float uBoxRot;
        uniform vec4 uSofaAO;
        uniform float uDetail;
        varying vec3 vWorld;
        void main() {
          vec3 wp = vWorld;
          vec2 p = wp.xz;
          // planks along x, staggered butt joints, a hairline gap between boards
          const float W = 1.25;
          float rowf = p.y / W;
          float row = floor(rowf);
          float fy = fract(rowf);
          float rh = hash12(vec2(row, 3.7));
          float L = 7.0 + 6.0 * rh;
          float xs = (p.x + rh * 41.0) / L;
          float cid = floor(xs);
          float fx = fract(xs);
          float id = hash12(vec2(row * 1.7 + 0.3, cid + 11.0));
          float ex = min(fx, 1.0 - fx) * L;
          float ey = min(fy, 1.0 - fy) * W;
          float aa = fwidth(p.y) + fwidth(p.x);
          float seam = 1.0 - smoothstep(0.015, 0.04 + aa, min(ex, ey));
          float fine = uDetail * (1.0 - smoothstep(0.03, 0.14, aa));
          float grain = vnoise(vec2(p.x * 0.55 + id * 30.0, p.y * 11.0)) * 0.6 + vnoise(vec2(p.x * 1.8, p.y * 38.0 + id * 9.0)) * 0.4 * fine;
          float figure = vnoise(vec2((p.x + id * 17.0) * 0.18, fy * 2.5 + id * 5.0));
          vec3 wood = mix(uWoodA, uWoodB, clamp(id * 0.7 + figure * 0.5 - 0.1, 0.0, 1.0));
          wood *= 0.78 + 0.34 * mix(0.5, grain, 0.35 + 0.65 * fine);
          wood *= 1.0 - seam * 0.72;
          float fade = roomFade(wp);
          float ao = 1.0 - 0.6 * (1.0 - smoothstep(0.0, 1.8, rectDist(p, uBoxAO.xy, uBoxAO.zw, uBoxRot)));
          ao *= 1.0 - 0.55 * (1.0 - smoothstep(0.0, 2.6, rectDist(p, uSofaAO.xy, uSofaAO.zw, 0.0)));
          float cs = catShadow(p);
          vec3 light = (uAmbTop * 0.7 + uAmbBot * 0.35 + uSkyCol * 0.8) * fade * ao * (1.0 - 0.62 * cs);
          float mm = moonMask(wp) * (1.0 - catMoonShadow(p)) * ao;
          light += uMoonCol * mm * uMoonDir.y;
          vec3 dl = dotLight(wp, vec3(0.0, 1.0, 0.0)) * (1.0 - 0.35 * cs);
          light += dl;
          vec3 col = wood * light + dl * 0.05;
          // polished boards: a soft reflection of the window
          vec3 V = normalize(wp - cameraPosition);
          vec3 Rv = vec3(V.x, -V.y, V.z);
          if (Rv.z < -0.02) {
            float t = (uWallZ - wp.z) / Rv.z;
            vec3 h = wp + Rv * t;
            float blur = 0.35 + t * 0.05;
            float wm = paneMask(h.xy + vec2(grain - 0.5, figure - 0.5) * blur * 0.7, blur);
            float fres = 0.03 + 0.45 * pow(1.0 - abs(V.y), 5.0);
            col += uWinGlow * wm * fres * (1.0 - seam) * (0.4 + 0.6 * fade);
          }
          col = fogIt(col, wp);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const floor = new THREE.Mesh(g, m);
    floor.renderOrder = -20;
    scene.add(floor);
  }
  await pause();

  /* ------------------------------------------------------------ rug */
  progress(0.12, "Rolling out the rug");
  {
    const s = new THREE.Shape();
    const hw = RUG.w / 2,
      hd = RUG.d / 2,
      rr = 0.5;
    s.moveTo(-hw + rr, -hd);
    s.lineTo(hw - rr, -hd);
    s.quadraticCurveTo(hw, -hd, hw, -hd + rr);
    s.lineTo(hw, hd - rr);
    s.quadraticCurveTo(hw, hd, hw - rr, hd);
    s.lineTo(-hw + rr, hd);
    s.quadraticCurveTo(-hw, hd, -hw, hd - rr);
    s.lineTo(-hw, -hd + rr);
    s.quadraticCurveTo(-hw, -hd, -hw + rr, -hd);
    const g = new THREE.ExtrudeGeometry(s, { depth: RUG.h * 0.6, bevelEnabled: true, bevelThickness: RUG.h * 0.2, bevelSize: 0.06, bevelSegments: 2, curveSegments: 4 });
    g.rotateX(-Math.PI / 2);
    g.translate(RUG.x, RUG.h * 0.2, RUG.z);
    g.deleteAttribute("uv");
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...RU,
        ...SHU,
        uField: { value: C("#4b5877") },
        uField2: { value: C("#5c6a8b") },
        uBorder: { value: C("#a2482c") },
        uCream: { value: C("#e2d0a8") },
        uRug: { value: new THREE.Vector4(RUG.x, RUG.z, hw, hd) },
      },
      vertexShader: WORLD_VERT,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        CAT_SHADOW +
        /* glsl */ `
        uniform vec3 uField;
        uniform vec3 uField2;
        uniform vec3 uBorder;
        uniform vec3 uCream;
        uniform vec4 uRug;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 wp = vWorld;
          vec2 q = wp.xz - uRug.xy;
          vec2 e = uRug.zw - abs(q);
          float edge = min(e.x, e.y);
          float aa = fwidth(edge) * 1.2 + 1e-3;
          vec3 c = uField;
          // a diamond lattice in the field
          vec2 lq = q * vec2(0.42, 0.42);
          float lat = abs(fract(lq.x + lq.y) - 0.5) + abs(fract(lq.x - lq.y) - 0.5);
          c = mix(c, uField2, smoothstep(0.62, 0.7, lat) * 0.8);
          // border: cream binding, a rust band with a cream zigzag, a cream line
          float band = smoothstep(1.55 + aa, 1.55 - aa, edge);
          float along = e.x < e.y ? q.y : q.x;
          float zig = abs(edge - 0.85 - 0.28 * (abs(fract(along * 0.55) - 0.5) * 2.0 - 0.5));
          c = mix(c, uBorder, band);
          c = mix(c, uCream, (1.0 - smoothstep(0.06, 0.06 + aa * 2.0, zig)) * band);
          c = mix(c, uCream, smoothstep(1.62 + aa, 1.62 - aa, edge) * smoothstep(1.47 - aa, 1.47 + aa, edge));
          c = mix(c, uCream * 0.8, smoothstep(0.22 + aa, 0.22 - aa, edge));
          // pile
          float fib = vnoise(wp.xz * 9.0) * 0.5 + vnoise(wp.xz * 23.0) * 0.5;
          c *= 0.82 + 0.3 * fib;
          vec3 n = normalize(vN);
          float cs = catShadow(wp.xz);
          float fade = roomFade(wp);
          vec3 light = (uAmbTop * 0.7 + uAmbBot * 0.35 + uSkyCol * 0.8) * fade * (1.0 - 0.62 * cs);
          light += uMoonCol * moonMask(wp) * (1.0 - catMoonShadow(wp.xz)) * max(dot(n, uMoonDir), 0.0);
          light += uFillCol * max(dot(n, uFillDir), 0.0) * fade * 0.25;
          vec3 dl = dotLight(wp, n) * (1.0 - 0.35 * cs);
          light += dl;
          vec3 col = fogIt(c * light + dl * 0.05, wp);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const rug = new THREE.Mesh(g, m);
    rug.renderOrder = -19;
    scene.add(rug);
  }
  await pause();

  /* --------------------------------------------------- wall + window */
  progress(0.2, "Opening the curtains");
  {
    // wall
    const g = new THREE.PlaneGeometry(170, 70, 1, 1);
    g.translate(0, 35, WALL_Z);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...RU, uWall: { value: C("#2d2429") }, uTrim: { value: C("#3a2c26") }, uWinGlow: { value: winGlow } },
      vertexShader: WORLD_VERT,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        /* glsl */ `
        uniform vec3 uWall;
        uniform vec3 uTrim;
        uniform vec3 uWinGlow;
        varying vec3 vWorld;
        void main() {
          vec3 wp = vWorld;
          vec3 n = vec3(0.0, 0.0, 1.0);
          float stripe = smoothstep(0.3, 0.46, abs(fract(wp.x / 2.4) - 0.5)) * 0.1;
          float mott = vnoise(wp.xy * 0.3) * 0.14 + vnoise(wp.xy * 1.7) * 0.05;
          vec3 base = uWall * (0.86 + stripe + mott);
          float skirt = 1.0 - smoothstep(1.2, 1.24, wp.y);
          base = mix(base, uTrim, skirt);
          base *= 1.0 - 0.4 * (1.0 - smoothstep(1.24, 1.32, wp.y)) * smoothstep(1.2, 1.24, wp.y);
          float fade = roomFade(vec3(wp.x, 0.0, wp.z + 4.0));
          vec3 light = (uAmbTop * 0.9 + uAmbBot * 0.3) * fade;
          vec2 wc = vec2(0.5 * (uWin.x + uWin.y), 0.5 * (uWin.z + uWin.w));
          vec2 wh = 0.5 * vec2(uWin.y - uWin.x, uWin.w - uWin.z);
          vec2 dq = max(abs(wp.xy - wc) - wh, 0.0);
          light += uWinGlow * 0.3 * exp(-dot(dq, dq) / 14.0);
          light += dotLight(wp, n);
          gl_FragColor = vec4(fogIt(base * light, wp), 1.0);
        }`,
    });
    const wall = new THREE.Mesh(g, m);
    wall.renderOrder = -21;
    scene.add(wall);

    // the view outside: night sky, a low moon and the city (looked up by direction, so it has parallax)
    const gg = new THREE.PlaneGeometry(WIN.x1 - WIN.x0 + 0.4, WIN.y1 - WIN.y0 + 0.4);
    gg.translate((WIN.x0 + WIN.x1) / 2, (WIN.y0 + WIN.y1) / 2, WALL_Z + 0.02);
    const gm = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uSkyTop: { value: new THREE.Color(0.012, 0.016, 0.05) },
        uSkyLow: { value: new THREE.Color(0.07, 0.06, 0.14) },
        uCityGlow: { value: new THREE.Color(0.3, 0.12, 0.07) },
        uCitySil: { value: new THREE.Color(0.006, 0.006, 0.012) },
        uCityLight: { value: new THREE.Color(1.0, 0.62, 0.28) },
        uMoonDisc: { value: new THREE.Color(1.5, 1.55, 1.7) },
      },
      vertexShader: WORLD_VERT,
      fragmentShader:
        GLSL_NOISE +
        /* glsl */ `
        uniform float uTime;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyLow;
        uniform vec3 uCityGlow;
        uniform vec3 uCitySil;
        uniform vec3 uCityLight;
        uniform vec3 uMoonDisc;
        varying vec3 vWorld;
        void main() {
          vec3 dir = normalize(vWorld - cameraPosition);
          float az = atan(dir.x, -dir.z);
          float el = dir.y / max(length(dir.xz), 1e-3);
          vec3 sky = mix(uSkyLow, uSkyTop, smoothstep(-0.05, 0.55, el));
          float md = length(vec2(az - 0.2, el - 0.2) * vec2(1.0, 1.0));
          sky += uMoonDisc * (smoothstep(0.036, 0.031, md) * (0.9 + 0.1 * vnoise(vec2(az, el) * 300.0)) * 2.4 + exp(-md * md * 70.0) * 0.28);
          vec2 sp = vec2(az, el) * 110.0;
          float st = step(0.988, hash12(floor(sp))) * smoothstep(0.08, 0.35, el);
          sky += vec3(0.9, 0.9, 1.0) * st * (0.5 + 0.5 * sin(uTime * 1.3 + hash12(floor(sp) + 4.0) * 30.0));
          // the city: a hazy far row of towers, then a darker near row with a few lit windows
          float edgeAA = fwidth(el) * 1.5;
          float fid = floor(az * 34.0);
          float fh = -0.13 + 0.07 * hash12(vec2(fid, 5.0)) + 0.05 * step(0.85, hash12(vec2(fid, 2.0)));
          float far = 1.0 - smoothstep(fh - edgeAA, fh + edgeAA, el);
          sky = mix(sky, mix(uSkyLow, uCityGlow, 0.35) * 0.55, far);
          float bx = az * 15.0;
          float bid = floor(bx);
          float bh = -0.19 + 0.09 * hash12(vec2(bid, 1.0)) + 0.07 * step(0.8, hash12(vec2(bid, 7.0)));
          float bldg = 1.0 - smoothstep(bh - edgeAA, bh + edgeAA, el);
          vec2 wq = vec2(fract(bx) * 7.0, (el + 0.4) * 160.0);
          float lit = step(0.86, hash12(floor(wq) + bid * 13.0)) * step(0.3, fract(wq.x)) * step(0.35, fract(wq.y));
          lit *= step(0.14, fract(bx)) * step(fract(bx), 0.86) * step(el, bh - 0.012);
          vec3 city = mix(uCitySil, uCityLight * (0.18 + 0.4 * hash12(floor(wq) + 3.0)), lit);
          vec3 col = mix(sky, city, bldg);
          col += uCityGlow * exp(-max(el + 0.12, 0.0) * 9.0) * 0.5 * (1.0 - bldg);
          // a faint sheen on the glass
          col += vec3(0.02, 0.025, 0.035) * smoothstep(0.3, 0.0, abs(fract((vWorld.x + vWorld.y) * 0.06) - 0.5));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const glass = new THREE.Mesh(gg, gm);
    glass.renderOrder = -21;
    scene.add(glass);

    // frame, cross bars and sill
    const fr = [];
    const cx = (WIN.x0 + WIN.x1) / 2;
    const ww = WIN.x1 - WIN.x0,
      wh = WIN.y1 - WIN.y0;
    const add = (w, h, d, x, y, z, r = 0.12) => {
      const b = roundedBox(w, h, d, r, 2, 1);
      b.translate(x, y, z);
      fr.push(b);
    };
    add(0.7, wh + 1.2, 0.8, WIN.x0 - 0.25, (WIN.y0 + WIN.y1) / 2, WALL_Z + 0.3);
    add(0.7, wh + 1.2, 0.8, WIN.x1 + 0.25, (WIN.y0 + WIN.y1) / 2, WALL_Z + 0.3);
    add(ww + 1.2, 0.7, 0.8, cx, WIN.y1 + 0.25, WALL_Z + 0.3);
    add(ww + 2.6, 0.45, 1.9, cx, WIN.y0 - 0.1, WALL_Z + 0.85, 0.15); // sill
    add(MULL.w * 2, wh, 0.45, MULL.x, (WIN.y0 + WIN.y1) / 2, WALL_Z + 0.2, 0.08);
    add(ww, MULL.w * 2, 0.45, cx, MULL.y, WALL_Z + 0.2, 0.08);
    const fg = mergeGeometries(fr);
    fr.forEach((x) => x.dispose());
    const fm = new THREE.ShaderMaterial({
      uniforms: { ...RU, uCol: { value: C("#3a302c") }, uWinGlow: { value: winGlow } },
      vertexShader: WORLD_VERT,
      fragmentShader:
        ROOM +
        /* glsl */ `
        uniform vec3 uCol;
        uniform vec3 uWinGlow;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 n = normalize(vN);
          vec3 col = lightProp(uCol, n, vWorld, 1.0);
          // edges facing the glass catch its glow
          vec2 wc = vec2(0.5 * (uWin.x + uWin.y), 0.5 * (uWin.z + uWin.w));
          vec2 toC = normalize(wc - vWorld.xy + vec2(1e-4));
          col += uCol * uWinGlow * 2.2 * max(dot(n.xy, toC), 0.0) * smoothstep(1.2, 0.0, vWorld.z - uWallZ);
          gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
        }`,
    });
    scene.add(new THREE.Mesh(fg, fm));

    // curtains: two long panels with folds, lit through from the window side
    const cg = [];
    for (const side of [-1, 1]) {
      const pw = 5.2;
      const p = new THREE.PlaneGeometry(pw, 22.4, 40, 1);
      const pos = p.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i),
          y = pos.getY(i);
        const k = (y + 11.2) / 22.4; // 0 bottom .. 1 top
        const fold = Math.sin(x * 2.6 + side) * 0.34 + Math.sin(x * 5.9 + 2) * 0.1;
        pos.setXYZ(i, x * (0.86 + 0.14 * k), y, fold * (0.75 + 0.25 * (1 - k)));
      }
      p.computeVertexNormals();
      p.translate(side < 0 ? WIN.x0 - 2.3 : WIN.x1 + 2.3, 11.6, WALL_Z + 1.1);
      p.deleteAttribute("uv");
      cg.push(p);
    }
    const rod = new THREE.CylinderGeometry(0.12, 0.12, ww + 13, 10);
    rod.rotateZ(Math.PI / 2);
    rod.translate(cx, 22.9, WALL_Z + 1.2);
    rod.deleteAttribute("uv");
    const curtainG = mergeGeometries(cg);
    cg.forEach((x) => x.dispose());
    const cm = new THREE.ShaderMaterial({
      uniforms: { ...RU, uCol: { value: C("#253a44") }, uWinGlow: { value: winGlow } },
      vertexShader: WORLD_VERT,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        /* glsl */ `
        uniform vec3 uCol;
        uniform vec3 uWinGlow;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          float weave = 0.9 + 0.1 * vnoise(vWorld.xy * vec2(6.0, 0.8));
          vec3 col = lightProp(uCol * weave, n, vWorld, 1.0);
          // the edge nearest the glass glows through
          float dx = min(abs(vWorld.x - uWin.x), abs(vWorld.x - uWin.y));
          float inside = smoothstep(uWin.z - 3.0, uWin.z, vWorld.y) * (1.0 - smoothstep(uWin.w, uWin.w + 3.0, vWorld.y));
          col += uCol * uWinGlow * 3.0 * exp(-dx * 0.55) * (0.35 + 0.65 * inside);
          gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    scene.add(new THREE.Mesh(curtainG, cm));
    const rodMat = new THREE.ShaderMaterial({
      uniforms: { ...RU, uCol: { value: C("#2a2420") } },
      vertexShader: WORLD_VERT,
      fragmentShader: ROOM + `uniform vec3 uCol; varying vec3 vWorld; varying vec3 vN; void main() { gl_FragColor = vec4(fogIt(lightProp(uCol, normalize(vN), vWorld, 1.0), vWorld), 1.0); }`,
    });
    scene.add(new THREE.Mesh(rod, rodMat));
  }
  await pause();

  /* ----------------------------------------------- moonbeam + dust */
  progress(0.28, "Letting the moon in");
  const floorHit = (x, y) => V3(x - MOON.x * (y / MOON.y), 0, WALL_Z - MOON.z * (y / MOON.y));
  const beamMin = V3(WIN.x0 - 0.5, 0, WALL_Z);
  const beamMax = V3(WIN.x1 + 0.5, WIN.y1 + 0.5, WALL_Z + 0.2);
  for (const [x, y] of [
    [WIN.x0, WIN.y0],
    [WIN.x1, WIN.y0],
    [WIN.x0, WIN.y1],
    [WIN.x1, WIN.y1],
  ]) {
    const f = floorHit(x, y);
    beamMin.min(f);
    beamMax.max(f);
  }
  let shaft = null;
  if (!LOW) {
    const steps = HIGH ? 14 : 8;
    const g = new THREE.BoxGeometry(beamMax.x - beamMin.x, beamMax.y - beamMin.y, beamMax.z - beamMin.z);
    g.translate((beamMin.x + beamMax.x) / 2, (beamMin.y + beamMax.y) / 2, (beamMin.z + beamMax.z) / 2);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...RU, uBoxMin: { value: beamMin }, uBoxMax: { value: beamMax }, uShaft: { value: HIGH ? 0.0095 : 0.0075 } },
      vertexShader: WORLD_VERT,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        /* glsl */ `
        uniform vec3 uBoxMin;
        uniform vec3 uBoxMax;
        uniform float uShaft;
        varying vec3 vWorld;
        void main() {
          vec3 ro = cameraPosition;
          vec3 rd = normalize(vWorld - ro);
          vec3 inv = 1.0 / rd;
          vec3 t0 = (uBoxMin - ro) * inv, t1 = (uBoxMax - ro) * inv;
          vec3 tn = min(t0, t1), tf = max(t0, t1);
          float a = max(max(tn.x, tn.y), max(tn.z, 0.0));
          float b = min(min(tf.x, tf.y), tf.z);
          if (b <= a) discard;
          float dt = (b - a) / float(${steps});
          // a dither that changes every frame: reads as faint grain in motion, never as a fixed pattern
          float j = hash12(gl_FragCoord.xy + fract(uTime * 13.7) * 97.0);
          float acc = 0.0;
          for (int i = 0; i < ${steps}; i++) {
            vec3 p = ro + rd * (a + (float(i) + j) * dt);
            float m = moonMask(p);
            float h = clamp(p.y / uWin.w, 0.0, 1.0);
            acc += m * (0.25 + 0.75 * h) * (0.7 + 0.6 * vnoise(p.xy * 0.18 + vec2(uTime * 0.015, p.z * 0.06)));
          }
          acc *= dt;
          gl_FragColor = vec4(uMoonCol * acc * uShaft, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide, // the back faces while the camera is inside the beam's box (see update)
    });
    shaft = new THREE.Mesh(g, m);
    shaft.renderOrder = 3;
    shaft.frustumCulled = false;
    scene.add(shaft);

    const n = HIGH ? 240 : 120;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = lerp(WIN.x0, WIN.x1, R()),
        y = lerp(WIN.y0, WIN.y1, R());
      const t = R() * (y / MOON.y) * 0.95;
      pos.set([x - MOON.x * t, y - MOON.y * t, WALL_Z - MOON.z * t], i * 3);
      seed.set([R(), R(), R(), R()], i * 4);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    dg.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    const dm = new THREE.ShaderMaterial({
      uniforms: { ...RU, uPx: px, uMotion: { value: reduced ? 0.3 : 1 } },
      vertexShader:
        ROOM +
        /* glsl */ `
        attribute vec4 aSeed;
        uniform float uPx;
        uniform float uMotion;
        varying float vA;
        void main() {
          float t = uTime * uMotion;
          vec3 p = position + vec3(sin(t * 0.11 + aSeed.x * 40.0) * 0.8, sin(t * 0.07 + aSeed.y * 30.0) * 0.7, cos(t * 0.09 + aSeed.z * 33.0) * 0.8);
          float m = moonMask(p);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float s = (0.035 + aSeed.w * 0.05) * uPx / max(-mv.z, 0.1);
          vA = m * (0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed.w) + aSeed.x * 20.0))) * clamp(s / 1.5, 0.0, 1.0);
          gl_PointSize = clamp(s, 1.0, 12.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uMoonCol;
        varying float vA;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d = dot(q, q);
          if (d > 1.0 || vA < 0.01) discard;
          gl_FragColor = vec4(uMoonCol * exp(-d * 4.0) * vA * 0.9, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const dust = new THREE.Points(dg, dm);
    dust.frustumCulled = false;
    dust.renderOrder = 4;
    scene.add(dust);
  }
  await pause();

  /* ---------------------------------------------------- sofa + box */
  progress(0.36, "Plumping the sofa");
  {
    const parts = [];
    const put = (g, x, y, z, tone, ry = 0, rz = 0) => {
      if (rz) g.rotateZ(rz);
      if (ry) g.rotateY(ry);
      g.translate(x, y, z);
      tagFloat(g, "aTone", tone);
      parts.push(g);
    };
    const S = SOFA;
    put(roundedBox(S.depth, 2.6, S.len, 0.5, 3, 2), S.x, 1.75, S.z, 0.0);
    put(roundedBox(6.4, 1.5, S.len / 2 - 0.2, 0.6, 3, 2), S.x - 0.75, 3.8, S.z - S.len / 4, 0.25);
    put(roundedBox(6.4, 1.5, S.len / 2 - 0.2, 0.6, 3, 2), S.x - 0.75, 3.8, S.z + S.len / 4, 0.3);
    put(roundedBox(2.4, 6.4, S.len, 0.8, 3, 2), S.x + 3.1, 5.4, S.z, 0.05);
    put(roundedBox(1.8, 4.4, S.len / 2 - 0.4, 0.8, 3, 2), S.x + 1.5, 6.4, S.z - S.len / 4, 0.2, 0, 0.12);
    put(roundedBox(1.8, 4.4, S.len / 2 - 0.4, 0.8, 3, 2), S.x + 1.5, 6.4, S.z + S.len / 4, 0.22, 0, 0.12);
    put(roundedBox(S.depth + 0.2, 5.6, 1.9, 0.75, 3, 2), S.x, 3.2, S.z - S.len / 2 - 0.4, 0.08);
    put(roundedBox(S.depth + 0.2, 5.6, 1.9, 0.75, 3, 2), S.x, 3.2, S.z + S.len / 2 + 0.4, 0.08);
    put(roundedBox(1.1, 3.0, 3.0, 0.9, 3, 2), S.x + 0.2, 5.6, S.z + S.len / 2 - 2.6, 1.0, 0.35, 0.18);
    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      const leg = new THREE.CylinderGeometry(0.22, 0.16, 0.6, 8);
      leg.deleteAttribute("uv");
      put(leg, S.x + dx * (S.depth / 2 - 0.7), 0.3, S.z + dz * (S.len / 2 + 0.2), -1);
    }
    const g = mergeGeometries(parts.map((p) => keepOnly(p, ["position", "normal", "aTone"])));
    parts.forEach((p) => p.dispose());
    const m = new THREE.ShaderMaterial({
      uniforms: { ...RU, uCol: { value: C("#3a4a4f") }, uCol2: { value: C("#a2553a") }, uLeg: { value: C("#1f1713") } },
      vertexShader: /* glsl */ `
        attribute float aTone;
        varying float vTone;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vTone = aTone;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        /* glsl */ `
        uniform vec3 uCol;
        uniform vec3 uCol2;
        uniform vec3 uLeg;
        varying float vTone;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 n = normalize(vN);
          vec3 base = vTone < -0.5 ? uLeg : vTone > 0.9 ? uCol2 : uCol * (0.85 + 0.35 * vTone);
          base *= 0.9 + 0.12 * vnoise(vWorld.yz * 3.0 + vWorld.x);
          vec3 col = lightProp(base, n, vWorld, 1.0);
          vec3 V = normalize(cameraPosition - vWorld);
          col += base * uSkyCol * 1.4 * pow(1.0 - max(dot(n, V), 0.0), 3.0) * roomFade(vWorld);
          gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
        }`,
    });
    scene.add(new THREE.Mesh(g, m));
  }
  const box = new THREE.Group();
  {
    const { w, d, h, t } = BOX;
    const parts = [];
    const put = (g, x, y, z, flap = 0, rx = 0, rz = 0) => {
      if (rx) g.rotateX(rx);
      if (rz) g.rotateZ(rz);
      g.translate(x, y, z);
      tagFloat(g, "aFlap", flap);
      parts.push(g);
    };
    put(roundedBox(w, t, d, 0.03, 1, 1), 0, t / 2, 0);
    put(roundedBox(w, h, t, 0.04, 1, 2), 0, h / 2, d / 2 - t / 2);
    put(roundedBox(w, h, t, 0.04, 1, 2), 0, h / 2, -d / 2 + t / 2);
    put(roundedBox(t, h, d - 2 * t, 0.04, 1, 2), w / 2 - t / 2, h / 2, 0);
    put(roundedBox(t, h, d - 2 * t, 0.04, 1, 2), -w / 2 + t / 2, h / 2, 0);
    // flaps, hinged on the top edges and open outward
    const lf = 2.6,
      sf = 2.3;
    for (const sz of [-1, 1]) {
      const f = roundedBox(w - 0.1, t, lf, 0.04, 1, 2);
      f.translate(0, 0, (sz * lf) / 2);
      put(f, 0, h, sz * (d / 2 - t / 2), 1, sz * (sz > 0 ? 0.62 : 0.95));
    }
    for (const sx of [-1, 1]) {
      const f = roundedBox(sf, t, d - 0.3, 0.04, 1, 2);
      f.translate((sx * sf) / 2, 0, 0);
      put(f, sx * (w / 2 - t / 2), h, 0, 1, 0, -sx * (sx > 0 ? 1.15 : 0.8));
    }
    const g = mergeGeometries(parts.map((p) => keepOnly(p, ["position", "normal", "aFlap"])));
    parts.forEach((p) => p.dispose());
    const m = new THREE.ShaderMaterial({
      uniforms: { ...RU, uCard: { value: C("#b98a55") }, uTape: { value: C("#d8c7a4") }, uHalf: { value: new THREE.Vector3(w / 2, h, d / 2) } },
      vertexShader: /* glsl */ `
        attribute float aFlap;
        varying float vFlap;
        varying vec3 vLocal;
        varying vec3 vLN;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vFlap = aFlap;
          vLocal = position;
          vLN = normal;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        ROOM +
        /* glsl */ `
        uniform vec3 uCard;
        uniform vec3 uTape;
        uniform vec3 uHalf;
        varying float vFlap;
        varying vec3 vLocal;
        varying vec3 vLN;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 n = normalize(vN);
          vec3 p = vLocal;
          vec3 base = uCard * (0.88 + 0.16 * vnoise(p.xz * 2.0 + p.y));
          // inside faces sit in the box's own shadow
          bool inside = vFlap < 0.5 && dot(vLN.xz, p.xz) < -0.01 && abs(p.x) < uHalf.x - 0.05 && abs(p.z) < uHalf.z - 0.05;
          float ao = 1.0;
          if (inside || (vFlap < 0.5 && vLN.y > 0.5 && p.y < 0.5)) ao = 0.25 + 0.6 * smoothstep(0.0, uHalf.y, p.y);
          // a strip of tape across the long flaps
          float tape = vFlap > 0.5 ? (1.0 - smoothstep(0.55, 0.62, abs(p.x))) : 0.0;
          tape = max(tape, (1.0 - smoothstep(0.55, 0.62, abs(p.x))) * smoothstep(uHalf.y - 1.2, uHalf.y - 1.15, p.y) * step(0.5, abs(vLN.z)) * (inside ? 0.0 : 1.0));
          base = mix(base, uTape, tape * 0.85);
          // a fold line where the flaps meet the walls
          vec3 col = lightProp(base, n, vWorld, ao);
          vec3 V = normalize(cameraPosition - vWorld);
          col += uTape * pow(max(dot(reflect(-V, n), uMoonDir), 0.0), 18.0) * tape * 0.2;
          gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
        }`,
    });
    box.add(new THREE.Mesh(g, m));
    box.position.set(BOX.x, 0, BOX.z);
    box.rotation.y = BOX.rot;
    scene.add(box);
  }
  const boxFwd = V3(Math.sin(BOX.rot), 0, Math.cos(BOX.rot)); // the box's local +z (its long flap side)
  await pause();

  /* ---------------------------------------------------------- yarn */
  const yarnMat = new THREE.ShaderMaterial({
    uniforms: { ...RU, uCol: { value: C("#4f7fa8") } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vLocal = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader:
      GLSL_NOISE +
      ROOM +
      /* glsl */ `
      uniform vec3 uCol;
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vN;
      float wrap(vec3 p, vec3 ax, float k) {
        float lat = asin(clamp(dot(p, ax), -1.0, 1.0));
        return abs(fract(lat * k) - 0.5) * 2.0;
      }
      void main() {
        vec3 n = normalize(vN);
        vec3 p = normalize(vLocal);
        float r1 = vnoise(p.xy * 2.0 + p.z * 1.3) ;
        vec3 ax = r1 < 0.33 ? normalize(vec3(0.3, 1.0, 0.2)) : r1 < 0.66 ? normalize(vec3(1.0, 0.2, -0.4)) : normalize(vec3(-0.3, 0.4, 1.0));
        float g = wrap(p, ax, 9.0);
        float groove = smoothstep(0.55, 1.0, g);
        vec3 base = uCol * (1.0 - 0.45 * groove) * (0.9 + 0.2 * vnoise(p.xy * 30.0));
        vec3 col = lightProp(base, n, vWorld, 1.0);
        vec3 V = normalize(cameraPosition - vWorld);
        col += base * uSkyCol * pow(1.0 - max(dot(n, V), 0.0), 2.5) * 1.5;
        gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
      }`,
  });
  const yarn = { pos: V3(8.2, YARN_R, 2.2), vel: V3(), q: new THREE.Quaternion(), moved: true, rest: V3(8.2, YARN_R, 2.2) };
  const yarnBall = new THREE.Mesh(new THREE.SphereGeometry(YARN_R, HIGH ? 32 : 20, HIGH ? 24 : 14), yarnMat);
  scene.add(yarnBall);
  const strand = new Loft({ rings: HIGH ? 40 : 24, segs: 5, part: 0, profile: () => [0.05, 0.05, 0.05], capA: 0, capB: 0 });
  const strandMesh = new THREE.Mesh(strand.geometry, yarnMat);
  strandMesh.frustumCulled = false;
  scene.add(strandMesh);
  const strandEnd = V3(4.6, 0.05, 5.4);
  const strandPts = [V3(), V3(), V3(), V3(), V3(), V3()];
  function updateStrand() {
    const b = yarn.pos;
    const away = V3(strandEnd.x - b.x, 0, strandEnd.z - b.z);
    const L = away.length() || 1;
    away.divideScalar(L);
    const side = V3(-away.z, 0, away.x);
    strandPts[0].set(b.x - away.x * 0.3, b.y - 0.1, b.z - away.z * 0.3);
    strandPts[1].set(b.x + away.x * 0.55, 0.12, b.z + away.z * 0.55);
    for (let k = 2; k < 5; k++) {
      const f = k / 5;
      const wob = Math.sin(f * 7 + 1.3) * 0.8;
      strandPts[k].set(b.x + away.x * (0.55 + (L - 0.55) * f) + side.x * wob, 0.05, b.z + away.z * (0.55 + (L - 0.55) * f) + side.z * wob);
    }
    strandPts[5].copy(strandEnd);
    strand.update(strandPts, "pt");
  }

  /* ------------------------------------------------------------ cat */
  progress(0.46, "Waking the cat");
  const HR = 1.0; // head radius
  const furU = {
    ...RU,
    uFur: { value: furCol.clone() },
    uFurDark: { value: furCol.clone().multiply(new THREE.Color(0.5, 0.36, 0.3)) },
    uPale: { value: C("#f0d9bd").lerp(furCol, 0.08) },
    uPink: { value: C("#f4a2ad") },
    uLine: { value: C("#2a1510") },
    uGlow: { value: 0 },
    uGlowCol: { value: furCol.clone().lerp(C("#fff1c9"), 0.5) },
    uCatch: { value: 0 },
  };
  const FUR_LIGHT = /* glsl */ `
    uniform vec3 uFur;
    uniform float uGlow;
    uniform vec3 uGlowCol;
    uniform float uCatch;
    vec3 shadeFur(vec3 base, vec3 n, vec3 wp) {
      vec3 V = normalize(cameraPosition - wp);
      float fade = 0.35 + 0.65 * roomFade(wp);
      float ndv = max(dot(n, V), 0.0);
      float ndl = dot(n, uMoonDir);
      float band = smoothstep(-0.12, 0.12, ndl) * 0.55 + smoothstep(0.3, 0.55, ndl) * 0.45;
      float beam = moonMask(wp);
      vec3 key = uMoonCol * band * (0.32 + 0.6 * beam);
      float ndf = dot(n, uFillDir);
      vec3 fill = uFillCol * (smoothstep(-0.35, 0.55, ndf) * 0.9 + 0.1) * fade;
      vec3 amb = mix(uAmbBot, uAmbTop, n.y * 0.5 + 0.5) * fade * 1.1;
      vec3 dl = dotLight(wp, n);
      vec3 col = base * (amb + key + fill + dl * 1.4);
      float rim = pow(1.0 - ndv, 3.5);
      float back = clamp(dot(normalize(n.xz + 1e-4), normalize(uMoonDir.xz)) * 0.6 + 0.5, 0.0, 1.0);
      col += (uMoonCol * (0.1 + 0.2 * beam) * back + dl * 0.25) * rim * (0.45 + 0.35 * base);
      col += uGlowCol * uGlow * (0.25 + rim) * 0.6;
      return col;
    }
  `;
  const FUR_VERT = /* glsl */ `
    attribute vec4 aFur;
    varying vec4 vFur;
    varying vec3 vN;
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vN = normalize(mat3(modelMatrix) * normal);
      vFur = aFur;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const furMat = new THREE.ShaderMaterial({
    uniforms: furU,
    vertexShader: FUR_VERT,
    fragmentShader:
      GLSL_NOISE +
      ROOM +
      FUR_LIGHT +
      /* glsl */ `
      uniform vec3 uFurDark;
      uniform vec3 uPale;
      uniform vec3 uPink;
      uniform vec3 uLine;
      varying vec4 vFur;
      varying vec3 vN;
      varying vec3 vWorld;
      // soft stripe: 1 on the stripe, 0 between (w: half width, 0..1)
      float stripeAt(float x, float w) {
        float d = abs(fract(x) - 0.5) * 2.0;
        return 1.0 - smoothstep(w, w + 0.22, d);
      }
      void main() {
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        float part = vFur.w;
        float st = 0.0, pale = 0.0, pink = 0.0, dark = 0.0;
        if (part < 0.5) {
          // body: x along (0 rump .. 1 neck), y = cos around (1 back .. -1 belly)
          float s = vFur.x, c = vFur.y;
          float wob = 0.2 * sin(c * 5.0 + s * 11.0) + 0.35 * (vnoise(vec2(s * 16.0, c * 2.2)) - 0.5);
          float sides = smoothstep(-0.5, 0.15, c);
          st = stripeAt(s * 8.0 + wob, 0.16 + 0.24 * smoothstep(0.2, 0.95, c)) * sides * smoothstep(0.04, 0.14, s) * (1.0 - smoothstep(0.78, 0.9, s));
          st = max(st, smoothstep(0.84, 0.96, c) * smoothstep(0.06, 0.16, s) * (1.0 - smoothstep(0.82, 0.95, s)) * 0.85);
          pale = smoothstep(-0.5, -0.82, c) * smoothstep(0.1, 0.32, s);
          pale = max(pale, smoothstep(0.6, 0.85, s) * smoothstep(0.05, -0.45, c));
        } else if (part < 2.5) {
          // legs: x from the body (0) to the paw (1); z > 0 is the outer side
          float s = vFur.x;
          float outer = smoothstep(-0.8, 0.2, vFur.z);
          st = stripeAt(s * 6.5 + 0.35 + 0.08 * vFur.y, 0.22) * outer * smoothstep(0.1, 0.22, s) * (1.0 - smoothstep(0.56, 0.68, s));
          pale = smoothstep(0.74, 0.84, s);
          pale = max(pale, smoothstep(-0.3, -0.85, vFur.z) * smoothstep(0.35, 0.6, s) * 0.6);
        } else if (part < 3.5) {
          // tail rings and a darker tip
          float s = vFur.x;
          st = stripeAt(s * 7.5 + 0.25, 0.3) * smoothstep(0.1, 0.2, s) * (0.8 + 0.2 * vFur.y);
          st = max(st, smoothstep(0.87, 0.96, s) * 0.85);
        } else if (part < 4.5) {
          // head: xyz is the direction on the undeformed sphere (x left, y up, z front)
          vec3 d = normalize(vFur.xyz);
          float ax = abs(d.x);
          float fore = smoothstep(0.26, 0.42, d.y) * smoothstep(0.15, 0.45, d.z);
          float m1 = 1.0 - smoothstep(0.035, 0.07, abs(d.x + 0.015 * sin(d.y * 24.0)));
          float m2 = 1.0 - smoothstep(0.03, 0.065, abs(ax - 0.15 - 0.22 * (d.y - 0.3)));
          st = max(m1 * smoothstep(0.3, 0.46, d.y), m2 * smoothstep(0.34, 0.5, d.y)) * fore;
          // stripes running back over the crown
          float crown = smoothstep(0.55, 0.8, d.y) * smoothstep(0.3, -0.2, d.z);
          st = max(st, stripeAt(d.x * 4.2 + 0.5, 0.2) * crown * 0.8);
          // cheek stripes sweeping back from the outer eye corners
          float cheek = smoothstep(0.62, 0.8, ax) * smoothstep(0.25, -0.02, d.y) * smoothstep(-0.55, -0.25, d.y) * smoothstep(-0.6, 0.2, d.z);
          st = max(st, stripeAt(d.y * 7.0 - d.z * 1.5 + 0.2, 0.22) * cheek);
          pale = smoothstep(0.55, 0.78, d.z) * smoothstep(-0.02, -0.28, d.y);
          pale = max(pale, smoothstep(-0.3, -0.62, d.y) * smoothstep(-0.25, 0.35, d.z));
          pale = max(pale, (1.0 - smoothstep(0.1, 0.2, length(vec2(ax - 0.4, d.y + 0.1)))) * 0.35 * smoothstep(0.5, 0.8, d.z));
        } else if (part < 5.5) {
          // ear, back: darker toward the tip
          st = smoothstep(0.55, 0.95, vFur.y) * 0.7;
        } else if (part < 6.5) {
          // ear, front: pink inside a fur rim, pale tufts at the base
          float u = abs(vFur.x), v = vFur.y;
          pink = (1.0 - smoothstep(0.5, 0.72, u + v * 0.35)) * (1.0 - smoothstep(0.62, 0.78, v));
          pale = (1.0 - pink) * (1.0 - smoothstep(0.1, 0.4, v)) * 0.8;
        } else if (part < 7.5) {
          pale = 1.0;
        } else if (part < 8.5) {
          pink = 1.0;
        } else {
          dark = 1.0;
        }
        vec3 base = mix(uFur, uFurDark, st * 0.9);
        base = mix(base, uPale, pale);
        base = mix(base, uPink, pink);
        base = mix(base, uLine, dark);
        vec3 col = shadeFur(base, n, vWorld);
        if (dark > 0.5) col = base * 0.6;
        gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
      }`,
  });

  const catRoot = new THREE.Group();
  catRoot.rotation.order = "YXZ";
  scene.add(catRoot);

  // body, legs and tail: lofted tubes, rebuilt every frame
  const bodyLoft = new Loft({
    rings: HIGH ? 36 : 26,
    segs: HIGH ? 28 : 18,
    part: 0,
    capA: 0.1,
    capB: 0,
    profile: profileFn([
      [0.0, 0.9, 0.7, 0.8],
      [0.08, 0.93, 0.76, 0.9],
      [0.2, 1.0, 0.84, 1.0],
      [0.34, 0.99, 0.8, 1.04],
      [0.5, 0.92, 0.72, 1.06],
      [0.66, 0.94, 0.76, 1.02],
      [0.8, 0.88, 0.78, 0.94],
      [0.9, 0.8, 0.74, 0.84],
      [1.0, 0.68, 0.64, 0.72],
    ]),
  });
  const legLofts = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const side = i % 2 === 0 ? 1 : -1;
    // [s, sideways, front, back]; the last stretch is the paw, wider than tall
    legLofts.push(
      new Loft({
        rings: HIGH ? 26 : 16,
        segs: HIGH ? 14 : 10,
        part: front ? 1 : 2,
        side,
        capA: 0.1,
        capB: 0.08,
        profile: front
          ? profileFn([
              [0.0, 0.35, 0.35, 0.35],
              [0.14, 0.37, 0.37, 0.37],
              [0.32, 0.32, 0.32, 0.32],
              [0.5, 0.27, 0.27, 0.27],
              [0.7, 0.23, 0.23, 0.23],
              [0.8, 0.23, 0.22, 0.21],
              [0.9, 0.26, 0.2, 0.16],
              [1.0, 0.24, 0.17, 0.14],
            ])
          : profileFn([
              [0.0, 0.55, 0.55, 0.55],
              [0.1, 0.65, 0.65, 0.65],
              [0.24, 0.61, 0.61, 0.61],
              [0.4, 0.41, 0.41, 0.41],
              [0.56, 0.26, 0.26, 0.26],
              [0.7, 0.22, 0.22, 0.22],
              [0.82, 0.22, 0.22, 0.21],
              [0.92, 0.26, 0.2, 0.16],
              [1.0, 0.24, 0.17, 0.14],
            ]),
      }),
    );
  }
  const tailLoft = new Loft({
    rings: HIGH ? 34 : 22,
    segs: HIGH ? 12 : 9,
    part: 3,
    capA: 0,
    capB: 0.05,
    profile: profileFn([
      [0.0, 0.27, 0.27, 0.27],
      [0.15, 0.26, 0.26, 0.26],
      [0.5, 0.235, 0.235, 0.235],
      [0.85, 0.215, 0.215, 0.215],
      [1.0, 0.2, 0.2, 0.2],
    ]),
  });
  for (const lf of [bodyLoft, ...legLofts, tailLoft]) {
    const mesh = new THREE.Mesh(lf.geometry, furMat);
    mesh.frustumCulled = false;
    catRoot.add(mesh);
  }

  // head: a sculpted sphere with muzzle pads, chin and cheek tufts, ears, eyes, nose, mouth and whiskers
  const head = new THREE.Group();
  catRoot.add(head);
  {
    const hg = headGeometry(HR, HIGH);
    const hm = new THREE.Mesh(hg, furMat);
    head.add(hm);
  }
  const ears = [];
  {
    const eg = earGeometry(0.74 * HR, 0.96 * HR, HIGH);
    for (const side of [1, -1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.5 * HR, 0.64 * HR, 0.1 * HR);
      pivot.rotation.order = "YXZ";
      const mesh = new THREE.Mesh(eg, furMat);
      pivot.add(mesh);
      head.add(pivot);
      ears.push({ pivot, side, base: new THREE.Euler(-0.12, side * 0.3, -side * 0.34, "YXZ") });
    }
  }
  const eyeU = {
    uIrisA: { value: C("#ffd35a") },
    uIrisB: { value: C("#8fd04a") },
    uLine: furU.uLine,
    uEyeFur: furU.uFur,
  };
  const eyes = [];
  {
    const eg = new THREE.SphereGeometry(1, HIGH ? 32 : 22, HIGH ? 24 : 16);
    eg.deleteAttribute("uv");
    for (const side of [1, -1]) {
      const m = new THREE.ShaderMaterial({
        uniforms: {
          ...RU,
          ...eyeU,
          uFur: furU.uFur,
          uGlow: furU.uGlow,
          uGlowCol: furU.uGlowCol,
          uCatch: furU.uCatch,
          uGaze: { value: V3(0, 0, 1) },
          uTop: { value: 0.8 },
          uBot: { value: -0.75 },
          uDil: { value: 0.6 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vP;
          varying vec3 vN;
          varying vec3 vWorld;
          void main() {
            vP = position;
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader:
          GLSL_NOISE +
          ROOM +
          FUR_LIGHT +
          /* glsl */ `
          uniform vec3 uIrisA;
          uniform vec3 uIrisB;
          uniform vec3 uLine;
          uniform vec3 uEyeFur;
          uniform vec3 uGaze;
          uniform float uTop;
          uniform float uBot;
          uniform float uDil;
          varying vec3 vP;
          varying vec3 vN;
          varying vec3 vWorld;
          void main() {
            vec3 p = normalize(vP);
            vec3 n = normalize(vN);
            float aa = fwidth(p.y) * 1.2 + 1e-3;
            float top = uTop - 0.24 * p.x * p.x;
            float bot = uBot + 0.14 * p.x * p.x;
            float lidT = smoothstep(top - aa, top + aa, p.y);
            float lidB = 1.0 - smoothstep(bot - aa, bot + aa, p.y);
            float lid = max(lidT, lidB);
            float liner = max(1.0 - smoothstep(0.0, 0.08 + aa, top - p.y), 1.0 - smoothstep(0.0, 0.06 + aa, p.y - bot));
            // iris and pupil follow the gaze
            vec3 g = normalize(uGaze);
            vec3 gx = normalize(cross(vec3(0.0, 1.0, 0.0), g));
            vec3 gy = cross(g, gx);
            vec2 q = vec2(dot(p, gx), dot(p, gy));
            float ir = length(q) / 0.9;
            vec3 iris = mix(uIrisA, uIrisB, smoothstep(0.1, 0.9, ir));
            float ang = atan(q.y, q.x);
            iris *= 0.78 + 0.34 * vnoise(vec2(ang * 6.0, ir * 4.0));
            iris *= 1.0 - 0.6 * smoothstep(0.78, 1.0, ir);
            float pw = mix(0.1, 0.5, uDil), ph = mix(0.66, 0.58, uDil);
            float pd = length(q / vec2(pw, ph));
            float paa = fwidth(pd) * 1.5 + 1e-3;
            float pupil = 1.0 - smoothstep(1.0 - paa, 1.0 + paa, pd);
            vec3 eyeC = mix(iris, vec3(0.012, 0.01, 0.014), pupil) * step(0.0, dot(p, g));
            vec3 V = normalize(cameraPosition - vWorld);
            vec3 lit = eyeC * (0.42 + 0.75 * (uAmbTop + uSkyCol + uFillCol * 0.8 + moonMask(vWorld) * uMoonCol * 0.45 + dotLight(vWorld, n)));
            // eyeshine: a cat's eyes glow a little in the dark
            lit += iris * (1.0 - pupil) * 0.1 * pow(max(dot(n, V), 0.0), 2.0);
            // catchlights stay put while the eye looks around
            float c1 = smoothstep(0.968, 0.982, dot(p, normalize(vec3(-0.36, 0.44, 0.82))));
            float c2 = smoothstep(0.993, 0.996, dot(p, normalize(vec3(0.3, -0.24, 0.92))));
            vec3 col = lit + vec3(1.0, 0.98, 0.95) * (c1 * 1.7 + c2 * 1.1);
            col = mix(col, uLine * 0.4, clamp(liner, 0.0, 1.0) * (1.0 - lid) * 0.9);
            vec3 lidCol = shadeFur(uEyeFur, n, vWorld);
            col = mix(col, lidCol, lid);
            gl_FragColor = vec4(fogIt(col, vWorld), 1.0);
          }`,
      });
      const mesh = new THREE.Mesh(eg, m);
      mesh.position.set(side * 0.38 * HR, 0.04 * HR, 0.66 * HR);
      mesh.scale.set(0.285 * HR, 0.31 * HR, 0.22 * HR);
      mesh.rotation.set(-0.05, side * 0.3, 0, "YXZ");
      head.add(mesh);
      eyes.push({ mesh, mat: m, side });
    }
  }
  {
    // nose, mouth, whiskers
    const ng = new THREE.SphereGeometry(1, 14, 10);
    const np = ng.attributes.position;
    for (let i = 0; i < np.count; i++) {
      const x = np.getX(i),
        y = np.getY(i),
        z = np.getZ(i);
      np.setXYZ(i, x * (y > 0 ? 1.15 : 0.6 + 0.55 * (1 + y)) * 0.12 * HR, y * 0.075 * HR, z * 0.085 * HR);
    }
    ng.deleteAttribute("uv");
    ng.computeVertexNormals();
    tagFur(ng, [0, 0, 1, 8]);
    ng.translate(0, -0.14 * HR, 0.965 * HR);
    const mouthCurve = new THREE.CatmullRomCurve3(
      [
        [-0.2, -0.37, 0.9],
        [-0.1, -0.42, 0.935],
        [0, -0.355, 0.955],
        [0.1, -0.42, 0.935],
        [0.2, -0.37, 0.9],
      ].map(([x, y, z]) => V3(x * HR, y * HR, z * HR)),
    );
    const mg = new THREE.TubeGeometry(mouthCurve, 20, 0.014 * HR, 5, false);
    const pg = new THREE.TubeGeometry(new THREE.LineCurve3(V3(0, -0.2 * HR, 0.97 * HR), V3(0, -0.355 * HR, 0.955 * HR)), 2, 0.012 * HR, 5, false);
    for (const g of [mg, pg]) {
      g.deleteAttribute("uv");
      tagFur(g, [0, 0, 1, 9]);
    }
    const g = mergeGeometries([ng, mg, pg].map((x) => keepOnly(x, ["position", "normal", "aFur"])));
    [ng, mg, pg].forEach((x) => x.dispose());
    head.add(new THREE.Mesh(g, furMat));

    const wp = [];
    for (const side of [1, -1])
      for (let j = 0; j < 3; j++) {
        const a = V3(side * 0.3 * HR, (-0.29 - j * 0.045) * HR, 0.84 * HR);
        const b = V3(side * 0.82 * HR, (-0.2 - j * 0.085) * HR, (0.72 - j * 0.04) * HR);
        const c = V3(side * 1.32 * HR, (-0.17 - j * 0.14) * HR, (0.52 - j * 0.08) * HR);
        wp.push(a.x, a.y, a.z, b.x, b.y, b.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
    const wm = new THREE.ShaderMaterial({
      uniforms: { ...RU },
      vertexShader: `varying vec3 vWorld; void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: ROOM + `varying vec3 vWorld; void main() { vec3 c = vec3(0.95, 0.92, 0.86) * (0.3 + 0.55 * moonMask(vWorld) + 0.3 * roomFade(vWorld)) + dotLight(vWorld, vec3(0.0, 1.0, 0.0)); gl_FragColor = vec4(fogIt(c * 0.75, vWorld), 0.5); }`,
      transparent: true,
      depthWrite: false,
    });
    const whiskers = new THREE.LineSegments(wg, wm);
    whiskers.renderOrder = 2;
    head.add(whiskers);
  }
  await pause();

  /* ------------------------------------------------ dots and effects */
  progress(0.66, "Charging the laser pointer");
  const MAX = maxCreatures;
  const RINGS = 10;
  const spotGeo = new THREE.PlaneGeometry(2, 2);
  spotGeo.rotateX(-Math.PI / 2);
  const spotC = new Float32Array((MAX + RINGS) * 4);
  const spotP = new Float32Array((MAX + RINGS) * 4);
  const aSpotC = new THREE.InstancedBufferAttribute(spotC, 4).setUsage(THREE.DynamicDrawUsage);
  const aSpotP = new THREE.InstancedBufferAttribute(spotP, 4).setUsage(THREE.DynamicDrawUsage);
  spotGeo.setAttribute("aSpotC", aSpotC);
  spotGeo.setAttribute("aSpotP", aSpotP);
  const spots = new THREE.InstancedMesh(
    spotGeo,
    new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: /* glsl */ `
        attribute vec4 aSpotC;
        attribute vec4 aSpotP;
        varying vec2 vQ;
        varying vec4 vC;
        varying vec4 vP;
        void main() {
          vQ = position.xz;
          vC = aSpotC;
          vP = aSpotP;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vQ;
        varying vec4 vC;
        varying vec4 vP;
        void main() {
          float r = length(vQ);
          if (r > 1.0) discard;
          vec3 c = vC.rgb;
          float k;
          if (vP.x > 0.5) {
            float t = vP.y;
            k = exp(-pow((r - 0.2 - t * 0.72) / (0.05 + 0.06 * t), 2.0)) * (1.0 - t) * 3.0;
          } else {
            float core = exp(-r * r * 110.0);
            k = exp(-r * r * 26.0) * 3.4 + exp(-r * r * 5.0) * 0.6 + exp(-r * r * 1.6) * 0.18 + core * 10.0;
            c = mix(c, vec3(1.0, 0.92, 0.9), clamp(core * 1.1, 0.0, 1.0));
            if (vP.z > 0.5) k += exp(-pow((r - 0.78) / 0.05, 2.0)) * 1.4 * (0.7 + 0.3 * vP.w);
          }
          gl_FragColor = vec4(c * k * vC.a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    MAX + RINGS,
  );
  spots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  spots.frustumCulled = false;
  spots.renderOrder = 5;
  const _m4 = new THREE.Matrix4();
  const _q0 = new THREE.Quaternion();
  const _s3 = V3();
  const hideSpot = (i) => {
    _m4.makeScale(0, 0, 0);
    spots.setMatrixAt(i, _m4);
    spotC[i * 4 + 3] = 0;
  };
  for (let i = 0; i < MAX + RINGS; i++) hideSpot(i);
  scene.add(spots);
  const trails = new Trails({ max: MAX, len: HIGH ? 12 : 8, minStep: 0.16, intensity: 2.2 });
  const halos = new Halos({ max: MAX, px, intensity: 2.4, flare: 0.7 });
  for (let i = 0; i < MAX; i++) halos.hide(i);
  trails.mesh.renderOrder = 6;
  halos.points.renderOrder = 7;
  scene.add(trails.mesh, halos.points);

  // sparkles (catches, level-ups)
  const SPK = HIGH ? 320 : LOW ? 120 : 200;
  const spk = { pos: new Float32Array(SPK * 3), vel: new Float32Array(SPK * 3), col: new Float32Array(SPK * 3), size: new Float32Array(SPK), life: new Float32Array(SPK), max: new Float32Array(SPK), next: 0 };
  const spkGeo = new THREE.BufferGeometry();
  const aSpkPos = new THREE.BufferAttribute(spk.pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aSpkCol = new THREE.BufferAttribute(spk.col, 3).setUsage(THREE.DynamicDrawUsage);
  const aSpkSize = new THREE.BufferAttribute(spk.size, 1).setUsage(THREE.DynamicDrawUsage);
  const aSpkLife = new THREE.BufferAttribute(new Float32Array(SPK), 1).setUsage(THREE.DynamicDrawUsage);
  spkGeo.setAttribute("position", aSpkPos);
  spkGeo.setAttribute("aCol", aSpkCol);
  spkGeo.setAttribute("aSize", aSpkSize);
  spkGeo.setAttribute("aLife", aSpkLife);
  const sparkles = new THREE.Points(
    spkGeo,
    new THREE.ShaderMaterial({
      uniforms: { uPx: px },
      vertexShader: /* glsl */ `
        attribute vec3 aCol;
        attribute float aSize;
        attribute float aLife;
        uniform float uPx;
        varying vec3 vCol;
        varying float vLife;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vCol = aCol;
          vLife = aLife;
          gl_PointSize = aLife > 0.0 ? clamp(aSize * uPx / max(-mv.z, 0.1), 1.0, 72.0) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vLife;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d = dot(q, q);
          if (d > 1.0 || vLife <= 0.0) discard;
          vec2 a = abs(q);
          float k = exp(-d * 9.0) * 1.5 + (exp(-a.x * 14.0) * exp(-a.y * 2.6) + exp(-a.y * 14.0) * exp(-a.x * 2.6)) * 0.8 * (1.0 - d);
          gl_FragColor = vec4(vCol * k * vLife, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sparkles.frustumCulled = false;
  sparkles.renderOrder = 8;
  scene.add(sparkles);
  const hot = C("#fff2e4");
  const gold = C("#ffd27a");
  function sparkle(p, n, { spread = 2.6, up = 3.2, size = 0.22, cols = [laser, hot, laser], life = 0.9, ring = 0 } = {}) {
    for (let k = 0; k < n; k++) {
      const i = spk.next++ % SPK;
      const a = R() * TAU;
      const sp = spread * (0.35 + R() * 0.65);
      if (ring > 0) {
        spk.pos.set([p.x + Math.cos(a) * ring, p.y + R() * 0.4, p.z + Math.sin(a) * ring], i * 3);
        spk.vel.set([Math.cos(a) * 0.4, up * (0.5 + R() * 0.8), Math.sin(a) * 0.4], i * 3);
      } else {
        spk.pos.set([p.x, p.y + 0.1, p.z], i * 3);
        spk.vel.set([Math.cos(a) * sp, up * (0.4 + R() * 0.8), Math.sin(a) * sp], i * 3);
      }
      const c = cols[k % cols.length];
      spk.col.set([c.r * 2.2, c.g * 2.2, c.b * 2.2], i * 3);
      spk.size[i] = size * (0.6 + R() * 0.8);
      spk.max[i] = life * (0.6 + R() * 0.7) * (reduced ? 1.4 : 1);
      spk.life[i] = spk.max[i];
    }
  }
  let ringNext = 0;
  const rings = Array.from({ length: RINGS }, () => ({ t: 2, x: 0, y: 0, z: 0, s: 1, c: laser }));
  function flashRing(p, s, c = laser) {
    const r = rings[ringNext++ % RINGS];
    r.t = 0;
    r.x = p.x;
    r.y = p.y;
    r.z = p.z;
    r.s = s;
    r.c = c;
  }
  await pause();

  /* ------------------------------------------------------- the rig */
  progress(0.76, "Teaching it to pounce");
  // A pose: spine (5 points, rump tip to neck), head centre, head pitch, paws (FL, FR, HL, HR: ground contact
  // points), hind metatarsal angle, tail (pitch at the base, curl per segment, wrap per segment, sway, pitch cap),
  // ears back, eye openness. Cat-local units: +z forward, +y up, +x the cat's left.
  const NP = 40;
  const pose = (o) => {
    const a = new Float32Array(NP);
    o.spine.forEach((p, i) => a.set(p, i * 3));
    a.set(o.head, 15);
    a[18] = o.pitch;
    o.paws.forEach((p, i) => a.set(p, 19 + i * 3));
    a[31] = o.meta;
    a.set(o.tail, 32); // pitch0, curl, wrap, sway, cap
    a[37] = o.ears;
    a[38] = o.lids;
    return a;
  };
  const POSES = {
    stand: pose({
      spine: [[0, 1.8, -2.0], [0, 1.92, -1.35], [0, 1.82, -0.1], [0, 1.92, 0.95], [0, 2.5, 1.62]],
      head: [0, 3.08, 2.05],
      pitch: 0.05,
      paws: [[0.44, 0, 1.12], [-0.44, 0, 1.12], [0.52, 0, -1.45], [-0.52, 0, -1.45]],
      meta: 0.3,
      tail: [0.62, 0.11, 0, 0.3, 2.1],
      ears: 0,
      lids: 0.93,
    }),
    sit: pose({
      spine: [[0, 0.86, -1.45], [0, 1.1, -1.05], [0, 1.8, -0.55], [0, 2.55, -0.05], [0, 3.1, 0.35]],
      head: [0, 3.72, 0.74],
      pitch: 0.0,
      paws: [[0.36, 0, 0.92], [-0.36, 0, 0.92], [0.66, 0, 0.36], [-0.66, 0, 0.36]],
      meta: 1.35,
      tail: [-1.15, 0.42, 0.38, 0.06, 0.02],
      ears: 0,
      lids: 0.88,
    }),
    crouch: pose({
      spine: [[0, 1.45, -2.05], [0, 1.55, -1.4], [0, 1.26, -0.2], [0, 1.14, 0.9], [0, 1.42, 1.55]],
      head: [0, 2.02, 2.08],
      pitch: -0.04,
      paws: [[0.48, 0, 1.62], [-0.48, 0, 1.62], [0.55, 0, -1.05], [-0.55, 0, -1.05]],
      meta: 0.95,
      tail: [-0.22, 0.02, 0, 0.1, 0.2],
      ears: 0,
      lids: 1,
    }),
    jump: pose({
      spine: [[0, 1.9, -2.5], [0, 1.98, -1.7], [0, 1.95, -0.1], [0, 2.0, 1.3], [0, 2.4, 2.0]],
      head: [0, 2.95, 2.55],
      pitch: -0.12,
      paws: [[0.34, 1.4, 2.9], [-0.34, 1.4, 2.9], [0.44, 1.3, -3.05], [-0.44, 1.3, -3.05]],
      meta: 1.45,
      tail: [0.18, 0.02, 0, 0.06, 0.5],
      ears: 0.15,
      lids: 1,
    }),
    land: pose({
      spine: [[0, 1.95, -2.0], [0, 1.95, -1.35], [0, 1.5, -0.1], [0, 1.25, 1.05], [0, 1.5, 1.7]],
      head: [0, 2.1, 2.3],
      pitch: -0.35,
      paws: [[0.2, 0, 1.95], [-0.2, 0, 2.03], [0.5, 0, -1.25], [-0.5, 0, -1.25]],
      meta: 0.6,
      tail: [0.5, 0.06, 0, 0.2, 1.0],
      ears: 0,
      lids: 1,
    }),
    stretch: pose({
      spine: [[0, 2.15, -2.0], [0, 2.2, -1.35], [0, 1.5, -0.1], [0, 0.98, 1.15], [0, 1.18, 1.85]],
      head: [0, 1.8, 2.55],
      pitch: 0.38,
      paws: [[0.4, 0, 2.45], [-0.4, 0, 2.45], [0.55, 0, -1.55], [-0.55, 0, -1.55]],
      meta: 0.3,
      tail: [0.95, 0.12, 0, 0.1, 2.0],
      ears: 0.25,
      lids: 0.15,
    }),
    run: pose({
      spine: [[0, 1.75, -2.2], [0, 1.85, -1.5], [0, 1.8, -0.1], [0, 1.8, 1.2], [0, 2.2, 1.9]],
      head: [0, 2.75, 2.45],
      pitch: -0.1,
      paws: [[0.42, 0, 1.2], [-0.42, 0, 1.2], [0.5, 0, -1.55], [-0.5, 0, -1.55]],
      meta: 0.45,
      tail: [0.15, 0.03, 0, 0.12, 0.4],
      ears: 0.75,
      lids: 1,
    }),
  };
  POSES.groom = POSES.sit.slice();
  POSES.groom.set([0, 3.55, 0.92], 15);
  POSES.groom[18] = -0.5;
  POSES.groom.set([0.2, 2.3, 1.25], 19);
  POSES.groom[38] = 0.25;
  POSES.proud = POSES.sit.slice();
  POSES.proud.set([1.35, 0.13, 0, 0.1, 2.3], 32);
  POSES.proud[18] = 0.2;
  POSES.proud[38] = 0.45;
  POSES.pat = POSES.stand.slice();
  POSES.pat.set([0.34, 0.8, 1.9], 19);
  const POSE_NAMES = Object.keys(POSES);
  const poseW = Object.fromEntries(POSE_NAMES.map((k) => [k, k === "sit" ? 1 : 0]));
  const poseWant = { ...poseW };
  let poseRate = 5;
  const P = new Float32Array(NP);

  const cat = {
    action: "sit",
    t: 0,
    dur: 5 + R() * 3,
    x: HOME.x,
    z: HOME.z,
    heading: -0.4,
    y: 0,
    speed: 0,
    yawRate: 0,
    cycle: 0,
    gaitW: 0,
    gallop: 0,
    scale: 1.4,
    scaleV: 0,
    squash: 1,
    squashV: 0,
    pitch: 0,
    roll: 0,
    target: null,
    jump: null,
    hop: 0,
    look: V3(0, 3, 20),
    lookNext: 0,
    yaw: 0,
    lpitch: 0,
    roll2: 0,
    lids: 0.75,
    blink: 0,
    blinkT: -1,
    nextBlink: 2,
    slow: 0,
    slowT: -1,
    nextSlow: 7,
    dil: 0.55,
    dilWant: 0.55,
    ears: 0,
    earTw: [0, 0],
    earT: [-1, -1],
    nextEar: 2.5,
    flick: 0,
    wrapSide: 1,
    sway: 0,
    wiggle: 0,
    groomT: 0,
    lastCatch: -99,
    caught: 0,
    missed: 0,
    boxIn: false,
    boxCool: 6,
    zoom: null,
    zoomCool: 0,
    celebrate: 0,
    glance: null,
    breath: 0,
  };
  const recentBuys = [];
  let now = 0;
  let growth = 0.5,
    growthTarget = 0.5,
    growthShown = 0.5;
  const catScaleFor = (g) => lerp(1, 1.8, clamp(g, 0, 1));

  /* --------------------------------------------------------- dots */
  const slots = new Array(MAX).fill(null);
  const byId = new Map();
  const order = [];
  const gone = new Map();
  let selectedId = null;
  const api = { onRemove: null };
  const speedK = reduced ? 0.45 : 1;
  const onRug = (x, z) => Math.abs(x - RUG.x) < RUG.w / 2 - 0.05 && Math.abs(z - RUG.z) < RUG.d / 2 - 0.05;
  const floorY = (x, z) => (onRug(x, z) ? RUG.h + 0.03 : 0.025);

  function clampPlay(p) {
    p.x = clamp(p.x, PLAY.x0, PLAY.x1);
    p.z = clamp(p.z, PLAY.z0, PLAY.z1);
    // keep off the box and the yarn ball
    const bx = p.x - BOX.x,
      bz = p.z - BOX.z;
    const bd = Math.hypot(bx, bz);
    if (bd < 5.6) {
      p.x = BOX.x + (bx / (bd || 1)) * 5.6;
      p.z = BOX.z + (bz / (bd || 1)) * 5.6;
    }
    const yx = p.x - yarn.pos.x,
      yz = p.z - yarn.pos.z;
    const yd = Math.hypot(yx, yz);
    if (yd < 1.4) {
      p.x = yarn.pos.x + (yx / (yd || 1)) * 1.4;
      p.z = yarn.pos.z + (yz / (yd || 1)) * 1.4;
    }
    return p;
  }

  function kill(d, why) {
    if (!d.alive) return;
    d.alive = false;
    slots[d.slot] = null;
    byId.delete(d.id);
    const i = order.indexOf(d);
    if (i >= 0) order.splice(i, 1);
    trails.hide(d.slot);
    halos.hide(d.slot);
    hideSpot(d.slot);
    if (why) gone.set(d.id, why);
    if (gone.size > 400) gone.delete(gone.keys().next().value);
    if (cat.target === d) cat.target = null;
    if (api.onRemove) api.onRemove(d);
  }

  function newDart(d) {
    const hunted = d === cat.target;
    const a = d.dot.clone();
    const zig = R() < 0.62;
    const ang = d.lastAng + (zig ? (R() < 0.5 ? 1 : -1) * (1.9 + R() * 1.0) : (R() - 0.5) * 2.4);
    let len = hunted ? 0.8 + R() * 2.4 : 1.6 + R() * 5.6;
    if (reduced) len *= 0.55;
    const b = V3(a.x + Math.cos(ang) * len, 0, a.z + Math.sin(ang) * len);
    if (hunted) {
      // tease the cat: stay in front of it, within pouncing range
      const s = cat.scale;
      const fx = Math.sin(cat.heading),
        fz = Math.cos(cat.heading);
      let dx = b.x - cat.x,
        dz = b.z - cat.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 2.6 * s) {
        b.x += fx * (2.6 * s - ahead);
        b.z += fz * (2.6 * s - ahead);
      }
      dx = b.x - cat.x;
      dz = b.z - cat.z;
      const dist = Math.hypot(dx, dz);
      const far = 8.5 * s;
      if (dist > far) {
        b.x = cat.x + (dx / dist) * far;
        b.z = cat.z + (dz / dist) * far;
      }
    }
    clampPlay(b);
    d.lastAng = Math.atan2(b.z - a.z, b.x - a.x);
    const speed = reduced ? 2.6 + R() * 2 : 15 + R() * 15;
    d.dart = { a, b, t: 0, T: Math.max(0.05, a.distanceTo(b) / speed) };
  }

  function skitter(d, dt) {
    if (d.dart) {
      d.dart.t += dt;
      const k = Math.min(1, d.dart.t / d.dart.T);
      const e = reduced ? easeInOut(k) : 1 - Math.pow(1 - k, 2.4);
      d.dot.lerpVectors(d.dart.a, d.dart.b, e);
      if (k >= 1) {
        d.dart = null;
        d.hold = reduced ? 0.8 + R() * 1.4 : R() < 0.2 ? 0.45 + R() * 0.8 : 0.05 + R() * 0.26;
      }
    } else if (d.hold > 0) {
      d.hold -= dt;
      tremble(d, dt, reduced ? 0.02 : 0.05);
    } else newDart(d);
  }
  function tremble(d, dt, amp) {
    d.jit += dt * (9 + d.seed * 6);
    d.dot.x += (Math.sin(d.jit * 1.7) * amp - d.jx) * 0.5;
    d.dot.z += (Math.cos(d.jit * 2.3) * amp - d.jz) * 0.5;
    d.jx = Math.sin(d.jit * 1.7) * amp * 0.5;
    d.jz = Math.cos(d.jit * 2.3) * amp * 0.5;
  }

  function stepDot(d, dt) {
    d.age += dt;
    d.t += dt;
    switch (d.mode) {
      case "skitter":
        skitter(d, dt);
        break;
      case "wait":
        // the cat is crouching for it: little twitches only
        if (d.dart) skitter(d, dt);
        else {
          tremble(d, dt, 0.07);
          if (!reduced && R() < dt * 0.9) {
            const a = d.dot.clone();
            const ang = R() * TAU;
            const b = clampPlay(V3(a.x + Math.cos(ang) * 0.35, 0, a.z + Math.sin(ang) * 0.35));
            d.dart = { a, b, t: 0, T: 0.06 };
          }
        }
        break;
      case "held":
        if (d.escapeAt != null && cat.jump && cat.jump.t / cat.jump.T >= d.escapeAt) {
          // the laser flicks away at the last moment
          d.escapeAt = null;
          d.escaped = true;
          const fx = Math.sin(cat.heading),
            fz = Math.cos(cat.heading);
          const side = R() < 0.5 ? 1 : -1;
          const a = d.dot.clone();
          const b = clampPlay(V3(a.x + fx * 1.4 + fz * side * 2.2, 0, a.z + fz * 1.4 - fx * side * 2.2));
          d.dart = { a, b, t: 0, T: 0.08 };
        }
        if (d.dart) {
          d.dart.t += dt;
          const k = Math.min(1, d.dart.t / d.dart.T);
          d.dot.lerpVectors(d.dart.a, d.dart.b, 1 - Math.pow(1 - k, 2));
          if (k >= 1) d.dart = null;
        } else tremble(d, dt, 0.03);
        break;
      case "lead":
        break; // placed by the zoomies
      case "flick": {
        // a sell: the pointer flickers, then the dot shoots off into the dark
        d.on = Math.min(1, d.t / 0.08) * (Math.sin(d.t * 47) > -0.2 || d.t < 0.12 ? 1 : 0.12);
        tremble(d, dt, 0.04);
        if (d.t > d.flickFor) {
          d.mode = "flee";
          d.t = 0;
          const away = Math.atan2(d.dot.z - RUG.z, d.dot.x - RUG.x) + (R() - 0.5) * 1.1;
          d.vel.set(Math.cos(away), 0, Math.sin(away)).multiplyScalar(reduced ? 6 : 14);
        }
        break;
      }
      case "flee": {
        d.vel.multiplyScalar(1 + dt * (reduced ? 1.2 : 2.6));
        d.dot.addScaledVector(d.vel, dt);
        const far = Math.hypot(d.dot.x - RUG.x, d.dot.z - RUG.z);
        d.on = clamp(1 - (far - 14) / 12, 0, 1) * clamp(1 - d.t / 2.2, 0, 1);
        if (d.on <= 0.01 || d.t > 2.6) kill(d, "Zipped off into the dark");
        break;
      }
      case "off":
        d.on = Math.max(0, d.on - dt / 0.35);
        if (d.on <= 0) kill(d, d.side === "sell" ? "Zipped off into the dark" : "Switched off");
        break;
    }
    if (!d.alive) return;
    if (d.mode !== "flick" && d.mode !== "flee" && d.mode !== "off") d.on = Math.min(1, d.on + dt / 0.15);
    d.dot.y = floorY(d.dot.x, d.dot.z);
    d.pos.lerp(d.dot, damp(d.mode === "flee" ? 20 : 11, dt));
  }

  api.spawn = (trade, { age = 0 } = {}) => {
    if (byId.has(trade.id)) return byId.get(trade.id);
    // old trades are already caught (buys) or long gone (sells)
    if (trade.side === "buy" ? age > 8 : age > 2) return null;
    let slot = slots.indexOf(null);
    if (slot < 0) {
      kill(order[0], order[0].side === "buy" ? "Switched off" : "Zipped off into the dark");
      slot = slots.indexOf(null);
    }
    const size = sizeForUsd(trade.usd);
    const d = {
      id: trade.id,
      trade,
      slot,
      side: trade.side,
      size,
      pos: V3(),
      dot: V3(),
      vel: V3(),
      mode: trade.side === "buy" ? "skitter" : "flick",
      t: 0,
      age: age > 0 ? Math.max(age, 0.5) : 0,
      on: 0,
      dart: null,
      hold: 0,
      lastAng: R() * TAU,
      jit: R() * 10,
      jx: 0,
      jz: 0,
      seed: R(),
      flickFor: 0.75 + R() * 0.4,
      alive: true,
      born: performance.now() - age * 1000,
    };
    // a buy enters where the pointer lands: somewhere on the floor, not right under the cat
    const p = V3();
    for (let k = 0; k < 8; k++) {
      p.set(lerp(PLAY.x0 + 1, PLAY.x1 - 1, R()), 0, lerp(PLAY.z0 + 1, PLAY.z1 - 1, R()));
      clampPlay(p);
      if (Math.hypot(p.x - cat.x, p.z - cat.z) > 3.5 * cat.scale) break;
    }
    d.dot.copy(p);
    d.dot.y = floorY(p.x, p.z);
    d.pos.copy(d.dot);
    slots[slot] = d;
    byId.set(d.id, d);
    order.push(d);
    trails.reset(slot, d.dot, trade.side === "sell" ? downCol : laser, 0.07 * size);
    if (d.side === "buy") {
      recentBuys.push(now);
      if (cat.zoom) joinZoomies(d);
    } else onSell(d);
    return d;
  };

  /* ------------------------------------------------------- behaviour */
  const isIdle = (a) => ["sit", "look", "groom", "wander", "home", "stretch", "proud", "glance", "flick", "walkbox", "boxsit", "celebrate"].includes(a);
  const inAir = () => !!cat.jump;

  function want(name, rate = 5, other = null, w2 = 0) {
    for (const k of POSE_NAMES) poseWant[k] = 0;
    poseWant[name] = 1 - w2;
    if (other) poseWant[other] += w2;
    poseRate = rate;
  }
  function setAction(name, dur = 0) {
    cat.action = name;
    cat.t = 0;
    cat.dur = dur;
  }
  function lookAt(x, y, z) {
    cat.look.set(x, y, z);
  }

  function steerTo(tx, tz, vmax, dt, turnRate = 5.5) {
    const dx = tx - cat.x,
      dz = tz - cat.z;
    const dist = Math.hypot(dx, dz);
    const err = angleDiff(Math.atan2(dx, dz), cat.heading);
    const turn = clamp(err, -turnRate * dt, turnRate * dt);
    cat.heading += turn;
    cat.yawRate = turn / Math.max(dt, 1e-4);
    const slow = clamp(dist / (1.4 * cat.scale), 0, 1);
    const align = Math.pow(clamp(Math.cos(err), 0, 1), 2);
    const v = vmax * slow * (0.15 + 0.85 * align);
    cat.speed += (v - cat.speed) * damp(6, dt);
    cat.x += Math.sin(cat.heading) * cat.speed * dt;
    cat.z += Math.cos(cat.heading) * cat.speed * dt;
    keepInRoom();
    return dist;
  }
  function faceTo(tx, tz, dt, turnRate = 4) {
    const err = angleDiff(Math.atan2(tx - cat.x, tz - cat.z), cat.heading);
    const turn = clamp(err, -turnRate * dt, turnRate * dt);
    cat.heading += turn;
    cat.yawRate = turn / Math.max(dt, 1e-4);
    cat.speed += (0 - cat.speed) * damp(8, dt);
    cat.x += Math.sin(cat.heading) * cat.speed * dt;
    cat.z += Math.cos(cat.heading) * cat.speed * dt;
    return Math.abs(err);
  }
  function keepInRoom() {
    const s = cat.scale;
    cat.x = clamp(cat.x, -17, SOFA_FRONT - 2.4 * s);
    cat.z = clamp(cat.z, WALL_Z + 2.6 * s, 11);
    if (!cat.boxIn && !cat.jump) {
      const dx = cat.x - BOX.x,
        dz = cat.z - BOX.z;
      const d = Math.hypot(dx, dz);
      const rr = 4.6 + 1.1 * s;
      if (d < rr) {
        cat.x = BOX.x + (dx / (d || 1)) * rr;
        cat.z = BOX.z + (dz / (d || 1)) * rr;
      }
    }
    // bump the yarn ball
    const yx = yarn.pos.x - cat.x,
      yz = yarn.pos.z - cat.z;
    const yd = Math.hypot(yx, yz);
    const reach = YARN_R + 1.15 * s;
    if (yd < reach && !cat.jump) {
      const nx = yx / (yd || 1),
        nz = yz / (yd || 1);
      const push = Math.max(Math.abs(cat.speed), 2.2) * 0.9;
      const vn = yarn.vel.x * nx + yarn.vel.z * nz;
      if (vn < push) {
        yarn.vel.x += nx * (push - vn);
        yarn.vel.z += nz * (push - vn);
      }
      cat.x -= nx * (reach - yd) * 0.3;
      cat.z -= nz * (reach - yd) * 0.3;
    }
  }

  function startJump(x1, z1, T, H, kind) {
    cat.jump = { x0: cat.x, z0: cat.z, x1, z1, T, H, t: 0, kind };
  }
  function stepJump(dt) {
    const j = cat.jump;
    j.t += dt;
    const u = Math.min(1, j.t / j.T);
    const e = u; // horizontal speed stays even in a ballistic jump
    cat.x = lerp(j.x0, j.x1, e);
    cat.z = lerp(j.z0, j.z1, e);
    cat.y = 4 * j.H * u * (1 - u);
    const vy = 4 * j.H * (1 - 2 * u);
    const vh = Math.hypot(j.x1 - j.x0, j.z1 - j.z0) + 1e-3;
    cat.pitch += (-Math.atan2(vy, vh) * 0.55 - cat.pitch) * damp(14, dt);
    if (u >= 1) {
      cat.jump = null;
      cat.y = 0;
      return true;
    }
    return false;
  }

  function pawPoint() {
    const r = 2.0 * cat.scale;
    return [cat.x + Math.sin(cat.heading) * r, cat.z + Math.cos(cat.heading) * r];
  }

  function nextTarget() {
    let best = null,
      bestScore = Infinity;
    for (const d of order) {
      if (!d.alive || d.side !== "buy" || d.mode === "off" || d.mode === "lead" || d.age < 0.3) continue;
      const dist = Math.hypot(d.dot.x - cat.x, d.dot.z - cat.z);
      const score = dist - d.age * 1.4;
      if (score < bestScore) {
        bestScore = score;
        best = d;
      }
    }
    return best;
  }

  function startHunt(d) {
    cat.target = d;
    d.mode = "skitter";
    const chain = now - cat.lastCatch < 1.6;
    if (cat.boxIn) {
      // straight out of the box toward the dot
      const dx = d.dot.x - BOX.x,
        dz = d.dot.z - BOX.z;
      const L = Math.hypot(dx, dz) || 1;
      const out = 5.2 + 1.4 * cat.scale;
      cat.heading = Math.atan2(dx, dz);
      startJump(BOX.x + (dx / L) * out, BOX.z + (dz / L) * out, 0.62, BOX.h + 1.6 * cat.scale, "hopout");
      setAction("hopout");
      return;
    }
    setAction("notice", chain ? 0.16 : 0.42 + R() * 0.2);
  }

  function launch(d, chain) {
    const dx = d.dot.x - cat.x,
      dz = d.dot.z - cat.z;
    const dist = Math.hypot(dx, dz) || 1;
    const reach = 2.0 * cat.scale;
    const lx = d.dot.x - (dx / dist) * reach,
      lz = d.dot.z - (dz / dist) * reach;
    const L = Math.hypot(lx - cat.x, lz - cat.z);
    const T = clamp(0.3 + (L / cat.scale) * 0.045, 0.36, 0.7) * (chain ? 0.9 : 1) * Math.sqrt(cat.scale);
    const H = (0.8 + L * 0.17) * (reduced ? 0.4 : 1);
    cat.heading = Math.atan2(dx, dz);
    startJump(lx, lz, T, H, "pounce");
    d.mode = "held";
    d.dart = null;
    if (!reduced && !chain && !d.escaped && R() < 0.16) d.escapeAt = 0.5 + R() * 0.2;
    setAction("pounce");
  }

  function catchDot(d) {
    const p = d.dot.clone();
    const n = reduced ? 10 : 18 + Math.round(d.size * 8);
    sparkle(p, n, { spread: 2.2 + d.size * 0.8, up: reduced ? 1.6 : 3.4, size: 0.18 + d.size * 0.05 });
    flashRing(p, 1.3 + d.size * 0.7);
    kill(d, "Caught by the cat");
    cat.caught++;
    cat.lastCatch = now;
    furU.uCatch.value = 1;
  }

  function onSell(d) {
    if (cat.target || cat.zoom || inAir()) {
      cat.earT[R() < 0.5 ? 0 : 1] = 0; // an ear flick is all a sell gets
      return;
    }
    if (isIdle(cat.action) && cat.action !== "boxsit" && cat.action !== "walkbox") {
      cat.glance = d;
      setAction("glance", 1.0);
    } else if (cat.action === "boxsit") cat.glance = d;
  }

  function joinZoomies(d) {
    const z = cat.zoom;
    let far = 2.5;
    for (const o of order) if (o.mode === "lead" && o.gap > far) far = o.gap;
    d.mode = "lead";
    d.gap = far + 3.2;
    d.dart = null;
    z.dots.push(d);
  }
  const loopPoint = (th, out) => {
    const w = 1 + 0.06 * Math.sin(3 * th + 0.7);
    out.x = LOOP.x + LOOP.rx * w * Math.cos(th);
    out.z = LOOP.z + LOOP.rz * w * Math.sin(th);
    return out;
  };
  function startZoomies() {
    const th = Math.atan2((cat.z - LOOP.z) / LOOP.rz, (cat.x - LOOP.x) / LOOP.rx);
    const tx = -LOOP.rx * Math.sin(th),
      tz = LOOP.rz * Math.cos(th);
    const fx = Math.sin(cat.heading),
      fz = Math.cos(cat.heading);
    const dir = tx * fx + tz * fz >= 0 ? 1 : -1;
    cat.zoom = { th, dir, speed: Math.max(cat.speed, 0), run: 0, t: 0, dots: [] };
    if (cat.target && cat.target.mode === "held") cat.target.mode = "skitter";
    cat.target = null;
    const buys = order.filter((d) => d.side === "buy" && d.alive && d.mode !== "off").sort((a, b) => b.age - a.age);
    buys.forEach((d, i) => {
      d.mode = "lead";
      d.gap = 3.6 + i * 3.1;
      d.dart = null;
      cat.zoom.dots.push(d);
    });
    cat.zoomCool = 16;
    setAction("zoomies");
  }
  const _lp = V3();
  function stepZoomies(dt) {
    const z = cat.zoom;
    z.t += dt;
    const s = cat.scale;
    const vmax = 13.5 * Math.sqrt(s);
    const ending = z.dots.every((d) => !d.alive) && z.run > 0.55;
    const vWant = ending || z.t > 9 ? 0 : vmax;
    z.speed += clamp(vWant - z.speed, -26 * dt, 22 * dt);
    const avgR = (LOOP.rx + LOOP.rz) / 2;
    const dth = (z.speed * dt) / avgR;
    z.th += z.dir * dth;
    z.run += dth / TAU;
    loopPoint(z.th, _lp);
    // join the track smoothly, then run on it
    const k = Math.min(1, damp(10, dt) * (0.3 + Math.min(1, z.t * 1.6)));
    const nx = lerp(cat.x, _lp.x, k);
    const nz = lerp(cat.z, _lp.z, k);
    const mvx = nx - cat.x,
      mvz = nz - cat.z;
    cat.x = nx;
    cat.z = nz;
    if (Math.hypot(mvx, mvz) > 1e-4) {
      const want = Math.atan2(mvx, mvz);
      const err = angleDiff(want, cat.heading);
      const turn = clamp(err, -9 * dt, 9 * dt);
      cat.heading += turn;
      cat.yawRate = turn / Math.max(dt, 1e-4);
    }
    cat.speed = Math.hypot(mvx, mvz) / Math.max(dt, 1e-4);
    for (const d of z.dots) {
      if (!d.alive) continue;
      d.gap -= dt * 2.7;
      const th = z.th + (z.dir * d.gap) / avgR;
      loopPoint(th, d.dot);
      d.dot.x += Math.sin(now * 23 + d.seed * 9) * 0.06;
      d.dot.z += Math.cos(now * 19 + d.seed * 7) * 0.06;
      if (d.gap < 1.9 * s) {
        catchDot(d);
        cat.hop = 0.001;
      }
    }
    if (vWant === 0 && z.speed < 0.6) {
      // any dot still leading goes back to skittering, to be hunted the usual way
      for (const d of z.dots) if (d.alive && d.mode === "lead") d.mode = "skitter";
      cat.zoom = null;
      cat.speed = 0;
      setAction("skid", 0.4);
    }
  }

  function pickIdle() {
    const opts = [
      ["look", 1.0],
      ["sit", 1.3],
      ["groom", 0.8],
      ["wander", 1.0],
      ["home", Math.hypot(cat.x - HOME.x, cat.z - HOME.z) > 4 ? 0.8 : 0],
      ["walkbox", cat.boxCool <= 0 ? 0.9 : 0],
      ["stretch", 0.28],
    ];
    let sum = 0;
    for (const [, w] of opts) sum += w;
    let r = R() * sum;
    let pick = "look";
    for (const [k, w] of opts) {
      if ((r -= w) <= 0) {
        pick = k;
        break;
      }
    }
    const slowK = reduced ? 1.5 : 1;
    if (pick === "look") setAction("look", (3 + R() * 3) * slowK);
    else if (pick === "sit") {
      cat.wrapSide = R() < 0.5 ? 1 : -1;
      setAction("sit", (5 + R() * 5) * slowK);
    } else if (pick === "groom") {
      cat.wrapSide = R() < 0.5 ? 1 : -1;
      setAction("groom", (4.5 + R() * 3) * slowK);
    } else if (pick === "wander") {
      const p = clampPlay(V3(lerp(PLAY.x0 + 2, PLAY.x1 - 2, R()), 0, lerp(PLAY.z0 + 3, PLAY.z1 - 2, R())));
      cat.walkTo = p;
      setAction("wander", 12);
    } else if (pick === "home") {
      cat.walkTo = HOME.clone();
      setAction("home", 14);
    } else if (pick === "walkbox") {
      cat.boxCool = 40;
      setAction("walkbox", 16);
    } else setAction("stretch", 2.6);
  }

  function idleLook(dt, fidget = 1) {
    cat.lookNext -= dt;
    if (cat.pointerAt > now - 2.5 && cat.pointer) {
      lookAt(cat.pointer.x, 0.3, cat.pointer.z);
      return;
    }
    if (cat.lookNext <= 0) {
      const r = R();
      if (r < 0.22) lookAt(camPos.x, camPos.y, camPos.z); // at the viewer
      else if (r < 0.4) lookAt(lerp(WIN.x0, WIN.x1, R()), lerp(WIN.y0, WIN.y1, R()), WALL_Z);
      else if (r < 0.5) lookAt(yarn.pos.x, yarn.pos.y, yarn.pos.z);
      else lookAt(cat.x + (R() - 0.5) * 16, R() * 3, cat.z + (R() - 0.5) * 16);
      cat.lookNext = (1.4 + R() * 2.8) / fidget;
    }
  }

  const boxEntry = (out) => {
    // the side of the box that faces the middle of the room
    const toRoom = V3(RUG.x - BOX.x, 0, RUG.z - BOX.z).normalize();
    const side = boxFwd.dot(toRoom) >= 0 ? boxFwd.clone() : boxFwd.clone().negate();
    const perp = V3(side.z, 0, -side.x);
    const useSide = Math.abs(perp.dot(toRoom)) > Math.abs(side.dot(toRoom)) ? perp.multiplyScalar(Math.sign(perp.dot(toRoom))) : side;
    const dist = (useSide === side ? BOX.d : BOX.w) / 2 + 2.2 + 1.5 * cat.scale;
    return out.set(BOX.x + useSide.x * dist, 0, BOX.z + useSide.z * dist);
  };

  function stepCat(dt) {
    cat.t += dt;
    cat.boxCool -= dt;
    cat.zoomCool -= dt;
    const s = cat.scale;
    const a = cat.action;

    // buys interrupt whatever the cat is idly doing
    if (!cat.target && !cat.zoom && !inAir() && (isIdle(a) || a === "skid")) {
      const d = nextTarget();
      if (d) startHunt(d);
    }
    // a burst of buys: zoomies
    while (recentBuys.length && recentBuys[0] < now - 6) recentBuys.shift();
    if (!reduced && !cat.zoom && !inAir() && cat.zoomCool <= 0 && recentBuys.length >= 4 && !cat.boxIn && ["notice", "approach", "crouch", "land"].includes(cat.action)) {
      const live = order.filter((d) => d.side === "buy" && d.alive && d.mode !== "off").length;
      if (live >= 3) startZoomies();
    }

    let gaitWant = 0;
    let gallopWant = 0;
    cat.wiggle += (0 - cat.wiggle) * damp(6, dt);
    cat.dilWant = 0.55;
    let earsWant = 0;
    let lidWant = null;
    const d = cat.target;
    switch (cat.force ? "force" : cat.action) {
      case "force": {
        // debugging: hold one pose (set cat.force to a pose name through the debug handle)
        want(cat.force, 8);
        if (cat.force === "crouch") cat.wiggle += (1 - cat.wiggle) * damp(10, dt);
        if (cat.forceGait) {
          gaitWant = 1;
          gallopWant = cat.forceGait > 1 ? 1 : 0;
          cat.speed = cat.forceGait > 1 ? 12 : 2.4;
        }
        break;
      }
      case "sit": {
        want("sit", 3.2);
        idleLook(dt);
        faceTo(cat.x + Math.sin(cat.heading), cat.z + Math.cos(cat.heading), dt);
        if (cat.t > cat.dur) pickIdle();
        break;
      }
      case "look": {
        want("stand", 3.5);
        idleLook(dt, 1.4);
        cat.speed *= 1 - damp(6, dt);
        if (cat.t > cat.dur) pickIdle();
        break;
      }
      case "groom": {
        want(cat.t < 0.6 ? "sit" : "groom", 3);
        lookAt(cat.x + Math.sin(cat.heading) * 3, 1, cat.z + Math.cos(cat.heading) * 3);
        cat.groomT += dt;
        lidWant = 0.3;
        if (cat.t > cat.dur) {
          cat.groomT = 0;
          setAction("sit", 2 + R() * 3);
        }
        break;
      }
      case "wander":
      case "home": {
        want("stand", 5);
        const dist = steerTo(cat.walkTo.x, cat.walkTo.z, 2.4 * Math.sqrt(s), dt, 3.2);
        gaitWant = clamp(cat.speed / 0.6, 0, 1);
        lookAt(cat.walkTo.x, 1, cat.walkTo.z);
        if (dist < 0.6 * s || cat.t > cat.dur) {
          if (cat.action === "home") {
            cat.wrapSide = R() < 0.5 ? 1 : -1;
            setAction("sit", 7 + R() * 6);
          } else pickIdle();
        }
        break;
      }
      case "walkbox": {
        want("stand", 5);
        const e = boxEntry(V3());
        const near = Math.hypot(e.x - cat.x, e.z - cat.z) < 0.7 * s;
        if (!near) steerTo(e.x, e.z, 2.6 * Math.sqrt(s), dt, 3.2);
        gaitWant = clamp(Math.max(cat.speed, Math.abs(cat.yawRate)) / 0.6, 0, 1);
        lookAt(BOX.x, 2, BOX.z);
        if (near) {
          if (faceTo(BOX.x, BOX.z, dt, 3) < 0.12) {
            cat.heading = Math.atan2(BOX.x - cat.x, BOX.z - cat.z);
            startJump(BOX.x, BOX.z, 0.62, BOX.h + 1.4 * s, "hopin");
            setAction("hopin");
          }
        } else if (cat.t > cat.dur) pickIdle();
        break;
      }
      case "hopin": {
        want(cat.jump && cat.jump.t / cat.jump.T < 0.75 ? "jump" : "sit", 9);
        if (!cat.jump || stepJump(dt)) {
          cat.boxIn = true;
          cat.wrapSide = R() < 0.5 ? 1 : -1;
          setAction("boxsit", 8 + R() * 8);
        }
        break;
      }
      case "boxsit": {
        want("sit", 4);
        const e = boxEntry(V3());
        faceTo(e.x + (e.x - BOX.x), e.z + (e.z - BOX.z), dt, 1.5);
        if (cat.glance && cat.glance.alive) lookAt(cat.glance.dot.x, 0, cat.glance.dot.z);
        else idleLook(dt, 0.8);
        if (cat.t > cat.dur) {
          const out = boxEntry(V3());
          cat.heading = Math.atan2(out.x - cat.x, out.z - cat.z);
          startJump(out.x, out.z, 0.6, BOX.h + 1.4 * s, "hopout");
          setAction("hopout");
        }
        break;
      }
      case "hopout": {
        want(cat.jump && cat.jump.t / cat.jump.T < 0.8 ? "jump" : "land", 9);
        if (!cat.jump || stepJump(dt)) {
          cat.boxIn = false;
          cat.squashV -= 2.2;
          if (cat.target && cat.target.alive) setAction("notice", 0.12);
          else setAction("look", 1.5 + R() * 2);
        }
        break;
      }
      case "stretch":
      case "celebrate": {
        want(cat.t < cat.dur - 0.7 ? "stretch" : "stand", 2.8);
        lidWant = 0.15;
        lookAt(cat.x + Math.sin(cat.heading) * 6, 2, cat.z + Math.cos(cat.heading) * 6);
        if (cat.t > cat.dur) {
          if (cat.action === "celebrate") setAction("proud", 2.2);
          else pickIdle();
        }
        break;
      }
      case "proud": {
        want("proud", 4);
        lidWant = 0.4;
        lookAt(camPos.x, camPos.y, camPos.z);
        if (cat.t > cat.dur) pickIdle();
        break;
      }
      case "glance": {
        const g = cat.glance;
        want(poseW.sit > 0.5 ? "sit" : "stand", 4);
        if (g && g.alive) lookAt(g.dot.x, 0, g.dot.z);
        earsWant = 0.35;
        if (cat.t > cat.dur || !g || !g.alive || g.mode === "flee") {
          cat.glance = null;
          cat.wrapSide = R() < 0.5 ? 1 : -1;
          if (R() < 0.45) setAction("groom", 3.5 + R() * 2.5);
          else {
            cat.flick = 1;
            setAction("flick", 2.2);
          }
        }
        break;
      }
      case "flick": {
        want("sit", 3.5);
        earsWant = 0.45;
        lidWant = 0.5;
        lookAt(lerp(WIN.x0, WIN.x1, 0.5), 10, WALL_Z);
        if (cat.t > cat.dur) pickIdle();
        break;
      }
      case "notice": {
        want("stand", 8);
        if (!d || !d.alive) {
          setAction("look", 1.5);
          break;
        }
        lookAt(d.dot.x, 0, d.dot.z);
        cat.dilWant = 0.95;
        faceTo(d.dot.x, d.dot.z, dt, 6);
        if (cat.t > cat.dur) {
          const dist = Math.hypot(d.dot.x - cat.x, d.dot.z - cat.z);
          if (reduced) setAction("stalk", 10);
          else if (dist < 9.5 * s) setAction("crouch", now - cat.lastCatch < 1.6 ? 0.28 : 0.7 + R() * 0.35);
          else setAction("approach", 6);
        }
        break;
      }
      case "approach": {
        if (!d || !d.alive) {
          setAction("look", 1.5);
          break;
        }
        const dx = d.dot.x - cat.x,
          dz = d.dot.z - cat.z;
        const dist = Math.hypot(dx, dz) || 1;
        const ideal = 5.5 * s;
        const tx = d.dot.x - (dx / dist) * ideal,
          tz = d.dot.z - (dz / dist) * ideal;
        const run = dist > 10 * s;
        want(run ? "run" : "stand", 7);
        if (dist > ideal) steerTo(tx, tz, (run ? 9.5 : 5.2) * Math.sqrt(s), dt, 6);
        else faceTo(d.dot.x, d.dot.z, dt, 6);
        gaitWant = clamp(cat.speed / 0.6, 0, 1);
        gallopWant = clamp((cat.speed - 5) / 3, 0, 1);
        lookAt(d.dot.x, 0, d.dot.z);
        cat.dilWant = 0.95;
        const err = Math.abs(angleDiff(Math.atan2(dx, dz), cat.heading));
        if ((dist < 8.5 * s && err < 0.45) || cat.t > cat.dur) setAction("crouch", now - cat.lastCatch < 1.6 ? 0.3 : 0.55 + R() * 0.3);
        break;
      }
      case "crouch": {
        if (!d || !d.alive) {
          setAction("look", 1.2);
          break;
        }
        want("crouch", 7);
        d.mode = "wait";
        lookAt(d.dot.x, 0, d.dot.z);
        cat.dilWant = 1;
        faceTo(d.dot.x, d.dot.z, dt, 3);
        const k = cat.t / cat.dur;
        if (k > 0.3) cat.wiggle += (1 - cat.wiggle) * damp(10, dt);
        if (cat.t > cat.dur) launch(d, now - cat.lastCatch < 1.6);
        break;
      }
      case "pounce": {
        const u = cat.jump ? cat.jump.t / cat.jump.T : 1;
        want(u < 0.72 ? "jump" : "land", u < 0.1 ? 16 : 11);
        cat.dilWant = 1;
        if (d && d.alive) lookAt(d.dot.x, 0, d.dot.z);
        if (!cat.jump || stepJump(dt)) {
          cat.squashV -= 3.2;
          const [px_, pz_] = pawPoint();
          if (d && d.alive && Math.hypot(d.dot.x - px_, d.dot.z - pz_) < 1.25 * s + d.size * 0.3) catchDot(d);
          else if (d && d.alive) {
            cat.missed++;
            d.mode = "skitter";
          }
          cat.target = null;
          setAction("land", now - cat.lastCatch < 0.2 ? 0.34 : 0.55);
        }
        break;
      }
      case "land": {
        want(cat.t < cat.dur * 0.5 ? "land" : "stand", 7);
        if (cat.t > cat.dur) {
          const n = nextTarget();
          if (n) startHunt(n);
          else setAction(cat.caught && now - cat.lastCatch < 1 ? "proud" : "look", 1.4 + R() * 1.2);
        }
        break;
      }
      case "zoomies": {
        want("run", 9);
        gaitWant = 1;
        gallopWant = 1;
        earsWant = 0.8;
        cat.dilWant = 1;
        const lead = cat.zoom.dots.find((x) => x.alive);
        if (lead) lookAt(lead.dot.x, 0, lead.dot.z);
        stepZoomies(dt);
        break;
      }
      case "skid": {
        want("land", 6);
        cat.speed *= 1 - damp(5, dt);
        cat.x += Math.sin(cat.heading) * cat.speed * dt;
        cat.z += Math.cos(cat.heading) * cat.speed * dt;
        if (cat.t > cat.dur) {
          cat.wrapSide = R() < 0.5 ? 1 : -1;
          setAction("groom", 4 + R() * 2);
        }
        break;
      }
      case "stalk": {
        // reduced motion: walk up to the dot and pat it
        if (!d || !d.alive) {
          setAction("look", 1.5);
          break;
        }
        want("stand", 5);
        const dx = d.dot.x - cat.x,
          dz = d.dot.z - cat.z;
        const dist = Math.hypot(dx, dz) || 1;
        const ideal = 2.3 * s;
        steerTo(d.dot.x - (dx / dist) * ideal, d.dot.z - (dz / dist) * ideal, 2.2 * Math.sqrt(s), dt, 3);
        gaitWant = clamp(cat.speed / 0.5, 0, 1);
        lookAt(d.dot.x, 0, d.dot.z);
        cat.dilWant = 0.85;
        if (dist < ideal + 0.5 * s || cat.t > cat.dur) {
          d.mode = "wait";
          setAction("pat", 1.1);
        }
        break;
      }
      case "pat": {
        if (!d || !d.alive) {
          setAction("look", 1.5);
          break;
        }
        faceTo(d.dot.x, d.dot.z, dt, 2.5);
        lookAt(d.dot.x, 0, d.dot.z);
        want(cat.t < 0.55 ? "pat" : "stand", 6);
        if (cat.t > 0.5 && d.mode !== "held") {
          // the paw comes down on the dot: it lands where the paw is
          const [px_, pz_] = pawPoint();
          d.dot.x = lerp(d.dot.x, px_ + Math.cos(cat.heading) * 0.3 * s, 0.8);
          d.dot.z = lerp(d.dot.z, pz_ - Math.sin(cat.heading) * 0.3 * s, 0.8);
          d.mode = "held";
          catchDot(d);
          cat.target = null;
        }
        if (cat.t > cat.dur) setAction("proud", 1.8);
        break;
      }
      default:
        setAction("look", 2);
    }
    cat.ears += (earsWant - cat.ears) * damp(6, dt);
    cat.lidWant = lidWant;

    // gait and pose weights
    cat.gaitW += (gaitWant - cat.gaitW) * damp(6, dt);
    cat.gallop += (gallopWant - cat.gallop) * damp(4, dt);
    const k = damp(poseRate, dt);
    for (const n of POSE_NAMES) poseW[n] += (poseWant[n] - poseW[n]) * k;

    // squash & stretch spring, growth spring
    cat.squashV += (1 - cat.squash) * 180 * dt - cat.squashV * 14 * dt;
    cat.squash = clamp(cat.squash + cat.squashV * dt, 0.7, 1.25);
    const sT = catScaleFor(growth);
    cat.scaleV += (sT - cat.scale) * 60 * dt - cat.scaleV * 9 * dt;
    cat.scale += cat.scaleV * dt;
    if (!cat.jump && cat.action !== "zoomies") cat.pitch += (0 - cat.pitch) * damp(8, dt);
    const rollWant = cat.action === "zoomies" ? clamp(-cat.yawRate * cat.speed * 0.012, -0.35, 0.35) : 0;
    cat.roll += (rollWant - cat.roll) * damp(6, dt);
    if (cat.hop > 0) {
      cat.hop += dt;
      const h = cat.hop / 0.3;
      cat.y = h < 1 ? Math.sin(Math.PI * h) * 0.7 * s : 0;
      if (h >= 1) cat.hop = 0;
    } else if (!cat.jump) cat.y += (0 - cat.y) * damp(12, dt);
  }

  /* ---------------------------------------------------- the rig: solve */
  const spineP = [V3(), V3(), V3(), V3(), V3()];
  const legCtrl = Array.from({ length: 4 }, () => [V3(), V3(), V3(), V3(), V3(), V3()]);
  const tailN = 12;
  const tailCtrl = Array.from({ length: tailN + 2 }, () => V3());
  const _a = V3(),
    _b = V3(),
    _c = V3(),
    _j = V3(),
    _e = V3(),
    _w = V3(),
    _hint = V3(),
    _fr = { c: V3(), T: V3(), S: V3(), U: V3() };
  const frontLen = [0.66, 0.56],
    hindLen = [0.6, 0.58];
  const META = 0.62;
  const PAW_R = 0.17;

  function solveRig(dt, t) {
    // blend the poses
    P.fill(0);
    let ws = 0;
    for (const n of POSE_NAMES) {
      const w = poseW[n];
      if (w < 1e-4) continue;
      const src = POSES[n];
      for (let k = 0; k < NP; k++) P[k] += src[k] * w;
      ws += w;
    }
    for (let k = 0; k < NP; k++) P[k] /= ws || 1;

    // gait: paws step, the body bobs
    const s = cat.scale;
    const v = Math.max(Math.abs(cat.speed), Math.abs(cat.yawRate) * 1.6 * s) / s;
    const gal = cat.gallop;
    const freq = lerp(0.8 + v * 0.35, 2.3 + v * 0.07, gal);
    cat.cycle += dt * freq * clamp(cat.gaitW * 4, 0, 1);
    const duty = lerp(0.62, 0.4, gal);
    const stride = clamp((v * duty) / Math.max(freq, 0.1), 0, lerp(1.6, 3.2, gal));
    const offs = [lerp(0.25, 0.08, gal), lerp(0.75, 0.0, gal), lerp(0.0, 0.58, gal), lerp(0.5, 0.5, gal)];
    const gw = cat.gaitW;
    if (gw > 0.001) {
      for (let i = 0; i < 4; i++) {
        const ph = (((cat.cycle + offs[i]) % 1) + 1) % 1;
        let dz, dy;
        if (ph < duty) {
          dz = stride * (0.5 - ph / duty);
          dy = 0;
        } else {
          const w = (ph - duty) / (1 - duty);
          dz = stride * (-0.5 + (w * w * (3 - 2 * w)));
          dy = Math.sin(Math.PI * w) * lerp(0.32, 0.55, gal) * clamp(v / 1.2, 0.3, 1);
        }
        P[21 + i * 3] += dz * gw;
        P[20 + i * 3] += dy * gw;
      }
      const bob = Math.cos(cat.cycle * TAU * 2) * 0.05 * gw * (1 - gal);
      const flex = Math.sin(cat.cycle * TAU) * 0.22 * gal * gw;
      for (let i = 0; i < 5; i++) {
        P[i * 3 + 1] += bob + (i < 2 ? -flex * 0.25 : flex * 0.12);
        P[i * 3 + 2] *= 1 + flex * 0.3;
      }
      P[16] += bob * 0.6;
      P[17] *= 1 + flex * 0.3;
    }

    // hunting wiggle: the rear sways and lifts before the leap (the hind paws stay planted)
    const wig = cat.wiggle;
    if (wig > 0.001) {
      const sw = Math.sin(t * 17) * 0.22 * wig;
      P[0] += sw;
      P[3] += sw * 0.8;
      P[1] += 0.14 * wig;
      P[4] += 0.12 * wig;
    }
    // grooming: lick the paw, then wash the face
    const gW = poseW.groom;
    let headRoll = 0,
      headYaw = 0;
    if (gW > 0.01) {
      const gt = cat.groomT % 3.4;
      if (gt < 2.0) {
        P[18] += Math.sin(gt * 20) * 0.1 * gW;
        P[20] += Math.sin(gt * 20 + 1) * 0.05 * gW;
      } else {
        const w = (gt - 2.0) / 1.4;
        const arc = Math.sin(Math.PI * w);
        P[19] += -0.1 * arc * gW;
        P[20] += (0.35 * arc + 0.2 * w) * gW;
        P[21] += -0.25 * arc * gW;
        headRoll = -0.35 * arc * gW;
        headYaw = 0.35 * arc * gW;
      }
    }

    // body loft
    for (let i = 0; i < 5; i++) spineP[i].set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    cat.breath += dt * (cat.action === "zoomies" || cat.action === "skid" ? 3.2 : 1.6);
    const br = Math.sin(cat.breath) * 0.02;
    const sitW = poseW.sit + poseW.groom + poseW.proud;
    const rad = bodyLoft.rad,
      base = bodyLoft.base;
    for (let i = 0; i < bodyLoft.rings; i++) {
      const si = bodyLoft.s[i];
      const chest = sstep(0.3, 0.55, si) * (1 - sstep(0.75, 0.92, si));
      // sitting, the rump spreads into a pear
      const pear = sitW * sstep(0.02, 0.14, si) * (1 - sstep(0.3, 0.55, si));
      const k = 1 + br * chest;
      rad[i * 3] = base[i * 3] * k * (1 + 0.2 * pear);
      rad[i * 3 + 1] = base[i * 3 + 1] * k;
      rad[i * 3 + 2] = base[i * 3 + 2] * (1 + br * 1.3 * chest) * (1 + 0.12 * pear);
    }
    bodyLoft.update(spineP, "x");

    // legs
    const floorLocal = -cat.y / (cat.scale * cat.squash);
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? 1 : -1;
      bodyLoft.frameAt(front ? 0.78 : 0.2, _fr);
      const J = _j.copy(_fr.c).addScaledVector(_fr.S, side * (front ? 0.4 : 0.5)).addScaledVector(_fr.U, front ? -0.42 : -0.24);
      legCtrl[i][0].copy(J).addScaledVector(_fr.U, 0.45).addScaledVector(_fr.S, -side * 0.12);
      const paw = _a.set(P[19 + i * 3], P[20 + i * 3], P[21 + i * 3]);
      paw.y = Math.max(paw.y, floorLocal);
      const lifted = clamp((paw.y - floorLocal) / 0.6, 0, 1);
      const pc = _b.set(paw.x, paw.y + PAW_R, paw.z);
      const ctrl = legCtrl[i];
      ctrl[1].copy(J);
      if (front) {
        _w.set(pc.x, pc.y + 0.25, pc.z - 0.03);
        _hint.set(0, 0.2, -1);
        const reached = ik2(J, _w, frontLen[0], frontLen[1], _hint, ctrl[2], ctrl[3]);
        pc.add(_c.subVectors(reached, _w));
      } else {
        const m = P[31];
        _w.set(pc.x, pc.y + Math.cos(m) * META, pc.z - Math.sin(m) * META);
        _hint.set(0, 0.3, 1);
        const reached = ik2(J, _w, hindLen[0], hindLen[1], _hint, ctrl[2], ctrl[3]);
        pc.add(_c.subVectors(reached, _w));
      }
      ctrl[4].copy(pc);
      // toes forward; a lifted paw curls its toes down
      ctrl[5].set(pc.x + side * 0.02, pc.y - 0.02 - lifted * 0.14, pc.z + 0.22 - lifted * 0.06);
      legLofts[i].update(ctrl, "x");
    }

    // tail: a chain of short segments with a travelling sway wave
    bodyLoft.frameAt(0.07, _fr);
    const tb = _c.copy(_fr.c).addScaledVector(_fr.U, 0.5);
    tailCtrl[0].copy(tb).addScaledVector(_fr.T, 0.35).addScaledVector(_fr.U, -0.2);
    tailCtrl[1].copy(tb);
    cat.sway += dt * (reduced ? 1.1 : 1.9) * (1 + cat.wiggle * 2.5);
    cat.flick = Math.max(0, cat.flick - dt * 0.55);
    const seg = 0.38;
    const [p0, curl, wrap, swayA, cap] = [P[32], P[33], P[34], P[35], P[36]];
    const twitch = cat.wiggle * 0.5 + (cat.action === "crouch" ? 0.2 : 0);
    for (let i = 0; i < tailN; i++) {
      const k = i / (tailN - 1);
      const pitch = Math.min(p0 + curl * i, cap);
      const sway = swayA * Math.sin(cat.sway - i * 0.5) * (0.25 + 0.75 * k);
      const tw = twitch * Math.sin(t * 13 - i * 0.9) * k * k * 0.9;
      const fl = cat.flick > 0 ? Math.sin(cat.flick * 18 - i * 0.6) * 0.9 * cat.flick * k : 0;
      const yaw = cat.wrapSide * wrap * Math.max(0, i - 2) + sway + tw + fl;
      const cp = Math.cos(pitch);
      const q = tailCtrl[i + 2].copy(tailCtrl[i + 1]);
      q.x += Math.sin(yaw) * cp * seg;
      q.y += Math.sin(pitch) * seg;
      q.z += -Math.cos(yaw) * cp * seg;
      q.y = Math.max(q.y, floorLocal + 0.22);
    }
    tailLoft.update(tailCtrl, "pt");

    // head: follows the neck, turns toward what the cat looks at
    head.position.set(P[15], P[16], P[17]);
    // where to look, in cat space
    catRoot.updateMatrixWorld(true);
    _e.copy(cat.look);
    catRoot.worldToLocal(_e);
    _e.sub(head.position);
    const wantYaw = clamp(Math.atan2(_e.x, _e.z), -1.25, 1.25);
    const wantPitch = clamp(Math.atan2(_e.y, Math.hypot(_e.x, _e.z)) - P[18], -0.7, 0.6);
    const hr = damp(cat.target || cat.zoom ? 12 : 5, dt);
    cat.yaw += (wantYaw * 0.8 + headYaw - cat.yaw) * hr;
    cat.lpitch += (wantPitch * 0.75 - cat.lpitch) * hr;
    cat.roll2 += (headRoll + clamp(-cat.yaw * 0.12, -0.2, 0.2) - cat.roll2) * damp(5, dt);
    head.rotation.set(-(P[18] + cat.lpitch), cat.yaw, cat.roll2, "YXZ");
    // the eyes do the rest
    const gy = clamp(wantYaw - cat.yaw, -0.45, 0.45);
    const gp = clamp(wantPitch - cat.lpitch, -0.35, 0.35);
    for (const e of eyes) {
      const g = e.mat.uniforms.uGaze.value;
      g.set(Math.sin(gy - e.mesh.rotation.y) * Math.cos(gp), Math.sin(gp + 0.05), Math.cos(gy - e.mesh.rotation.y) * Math.cos(gp));
    }

    // eyes: pupils, blinks, slow blinks
    cat.dil += (cat.dilWant - cat.dil) * damp(3, dt);
    if (cat.blinkT < 0 && now > cat.nextBlink) cat.blinkT = 0;
    if (cat.blinkT >= 0) {
      cat.blinkT += dt;
      const kb = cat.blinkT / 0.2;
      cat.blink = kb < 0.45 ? kb / 0.45 : Math.max(0, 1 - (kb - 0.45) / 0.55);
      if (kb >= 1) {
        cat.blink = 0;
        cat.blinkT = -1;
        cat.nextBlink = now + 2.5 + R() * 4;
      }
    }
    const calm = isIdle(cat.action) && !cat.target;
    if (cat.slowT < 0 && calm && now > cat.nextSlow) cat.slowT = 0;
    if (cat.slowT >= 0) {
      cat.slowT += dt;
      const ks = cat.slowT;
      cat.slow = ks < 0.55 ? sstep(0, 0.55, ks) : ks < 1.0 ? 1 : 1 - sstep(1.0, 1.7, ks);
      if (ks > 1.7) {
        cat.slow = 0;
        cat.slowT = -1;
        cat.nextSlow = now + 8 + R() * 8;
      }
    }
    const open = cat.lidWant != null ? cat.lidWant : P[38];
    cat.lids += (open - cat.lids) * damp(6, dt);
    const shut = Math.max(cat.blink, cat.slow * 0.88);
    const top = lerp(-0.62 + cat.lids * 1.55, -0.12, shut);
    const bot = lerp(-0.92 + (1 - cat.lids) * 0.3, -0.2, shut);
    for (const e of eyes) {
      e.mat.uniforms.uTop.value = top;
      e.mat.uniforms.uBot.value = bot;
      e.mat.uniforms.uDil.value = cat.dil;
    }

    // ears: perk, flatten, twitch
    if (now > cat.nextEar) {
      cat.earT[R() < 0.5 ? 0 : 1] = 0;
      cat.nextEar = now + 2 + R() * 5;
    }
    const earsBack = Math.max(P[37], cat.ears);
    const perk = cat.target ? 1 : 0;
    for (let i = 0; i < 2; i++) {
      const e = ears[i];
      let tw = 0;
      if (cat.earT[i] >= 0) {
        cat.earT[i] += dt;
        const kt = cat.earT[i] / 0.28;
        tw = kt < 0.3 ? kt / 0.3 : Math.max(0, 1 - (kt - 0.3) / 0.7);
        if (kt >= 1) cat.earT[i] = -1;
      }
      e.pivot.rotation.set(
        e.base.x - earsBack * 0.55 + perk * 0.18 - tw * 0.3,
        e.base.y + e.side * (earsBack * 0.5 + tw * 0.6) - e.side * perk * 0.18,
        e.base.z - e.side * earsBack * 0.35,
        "YXZ",
      );
    }
  }

  /* --------------------------------------------------------- growth */
  api.setGrowth = (g, immediate) => {
    growthTarget = clamp(g, 0, 1);
    if (immediate) {
      growth = growthTarget;
      growthShown = growth;
      cat.scale = catScaleFor(growth);
      cat.scaleV = 0;
    }
  };
  function celebrate(level) {
    const s = cat.scale;
    const p = V3(cat.x, 0.1, cat.z);
    const big = level >= 4;
    sparkle(p, reduced ? 16 : big ? 90 : 46, { ring: 2.2 * s, up: reduced ? 1.2 : big ? 4.5 : 3.2, size: 0.26, cols: [gold, hot, furCol], life: big ? 1.8 : 1.3 });
    flashRing(p, 3.2 * s, gold);
    cat.celebrate = big ? 2.5 : 1.4;
    if (isIdle(cat.action) && !cat.boxIn) setAction("celebrate", 2.4);
  }

  /* ------------------------------------------------------------ view */
  api.view = (aspect = 16 / 9) => {
    const s = catScaleFor(growthTarget);
    const narrow = clamp(1.25 / Math.max(aspect, 0.3), 1, 1.9);
    const target = V3(1.2, 2.0 + 0.9 * (s - 1), -8.8);
    const dist = (26 + 7 * (s - 1)) * narrow;
    const az = THREE.MathUtils.degToRad(-20);
    const el = THREE.MathUtils.degToRad(narrow > 1.2 ? 24 : 19);
    return {
      pos: V3(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z + Math.cos(az) * Math.cos(el) * dist),
      target,
      fov: 42,
      limits: { minDistance: 5, maxDistance: 62, minPolar: 0.2, maxPolar: 1.47, flyRadius: 70, flyMinY: 0.7, flyMaxY: 34, flySpeed: 9 },
      autoRotateSpeed: 0.3,
      constrain: (p) => {
        // stay in the room, in front of the curtains and the sill
        if (p.z < WALL_Z + 3.4) p.z = WALL_Z + 3.4;
        if (p.y < 0.7) p.y = 0.7;
        // not inside the sofa
        if (p.x > SOFA_FRONT - 0.8 && p.z > SOFA.z - SOFA.len / 2 - 2.5 && p.z < SOFA.z + SOFA.len / 2 + 2.5 && p.y < 9.5) p.y = 9.5;
        // nor inside the box
        const bx = p.x - BOX.x,
          bz = p.z - BOX.z;
        if (Math.hypot(bx, bz) < 5 && p.y < BOX.h + 1.2) p.y = BOX.h + 1.2;
      },
    };
  };
  api.followDistance = 7;
  api.look = { bloom: { strength: 0.7, radius: 0.5, threshold: 1.15 }, exposure: 0.95, clear: bg.getHex() };
  api.scene = scene;

  /* ------------------------------------------------------------ API */
  api.get = (id) => byId.get(id) || null;
  api.list = () => order;
  api.newest = () => {
    for (let i = order.length - 1; i >= 0; i--) if (order[i].alive && order[i].mode !== "off") return order[i];
    return null;
  };
  api.select = (id) => {
    selectedId = id;
  };
  api.release = (filter) => {
    for (const d of order.slice()) {
      if (!filter(d)) continue;
      if (d.mode === "lead" && cat.zoom) cat.zoom.dots = cat.zoom.dots.filter((x) => x !== d);
      if (cat.target === d) cat.target = null;
      d.mode = "off";
    }
  };
  api.describe = (d) => {
    if (d.side === "sell") return d.mode === "flee" ? "Zipping off into the dark" : "Flickering out";
    if (d.mode === "off") return "Switching off";
    if (d.mode === "lead") return "Leading the zoomies";
    if (cat.target === d) {
      if (cat.action === "crouch") return "The cat is crouching for it";
      if (cat.action === "pounce") return "Mid-pounce";
      if (cat.action === "stalk" || cat.action === "pat") return "The cat is stalking it";
      return "The cat has spotted it";
    }
    return "Skittering across the floor";
  };
  api.goneText = (t) => gone.get(t.id) || (t.side === "sell" ? "Zipped off into the dark" : "Caught by the cat");
  const _ray = new THREE.Raycaster();
  const _plane = new THREE.Plane(V3(0, 1, 0), 0);
  const _nv = new THREE.Vector2();
  api.pointer = (nx, ny, camera) => {
    if (!camera) return;
    _nv.set(nx, ny);
    _ray.setFromCamera(_nv, camera);
    const hit = _ray.ray.intersectPlane(_plane, V3());
    if (hit && Math.abs(hit.x) < 40 && hit.z > WALL_Z && hit.z < 30) {
      cat.pointer = hit;
      cat.pointerAt = now;
    }
  };
  /** State for tests and debugging (the world's debug handle exposes the scene API). */
  api.debug = () => ({
    action: cat.action,
    t: +cat.t.toFixed(2),
    targetMode: cat.target ? cat.target.mode : null,
    caught: cat.caught,
    missed: cat.missed,
    dots: order.length,
    hunting: cat.target ? cat.target.id : null,
    zoomies: !!cat.zoom,
    scale: +cat.scale.toFixed(3),
    inBox: cat.boxIn,
    pos: [+cat.x.toFixed(2), +cat.y.toFixed(2), +cat.z.toFixed(2)],
  });
  api.cat = cat;

  /* --------------------------------------------------------- frame */
  const camPos = V3(0, 8, 20);
  const _col = new THREE.Color();
  const _dp = V3();
  const lightList = [];
  api.update = (dt, t, camera) => {
    now = t;
    U.uTime.value = t;
    camPos.copy(camera.position);
    if (shaft) {
      const c = camPos;
      const inside = c.x > beamMin.x && c.x < beamMax.x && c.y > beamMin.y && c.y < beamMax.y && c.z > beamMin.z && c.z < beamMax.z;
      shaft.material.side = inside ? THREE.BackSide : THREE.FrontSide;
    }

    // growth: eases in; crossing a quarter step makes a little celebration
    if (Math.abs(growthTarget - growth) > 1e-4) growth += (growthTarget - growth) * damp(0.8, dt);
    const lvl = (g) => Math.floor(g * 4 + 1e-3);
    if (lvl(growth) > lvl(growthShown)) celebrate(lvl(growth));
    growthShown = growth;

    // dots
    for (let i = 0; i < order.length; i++) {
      const d = order[i];
      stepDot(d, dt);
      if (!d.alive) i--;
    }
    stepCat(dt);
    cat.celebrate = Math.max(0, cat.celebrate - dt);
    furU.uGlow.value = Math.min(1, cat.celebrate) * 0.8;
    furU.uCatch.value = Math.max(0, furU.uCatch.value - dt * 2);

    // yarn ball: rolls when bumped
    if (yarn.vel.lengthSq() > 1e-4) {
      yarn.pos.addScaledVector(yarn.vel, dt);
      const sp = yarn.vel.length();
      const ax = V3(yarn.vel.z, 0, -yarn.vel.x).normalize();
      yarn.q.premultiply(new THREE.Quaternion().setFromAxisAngle(ax, (sp * dt) / YARN_R));
      yarn.vel.multiplyScalar(Math.exp(-dt * 1.4));
      if (yarn.pos.x < PLAY.x0 - 2 || yarn.pos.x > PLAY.x1 + 3) yarn.vel.x *= -0.6;
      if (yarn.pos.z < PLAY.z0 || yarn.pos.z > PLAY.z1 + 3) yarn.vel.z *= -0.6;
      yarn.pos.x = clamp(yarn.pos.x, PLAY.x0 - 2, PLAY.x1 + 3);
      yarn.pos.z = clamp(yarn.pos.z, PLAY.z0, PLAY.z1 + 3);
      if (sp < 0.02) yarn.vel.set(0, 0, 0);
      yarn.moved = true;
    }
    if (yarn.moved) {
      yarnBall.position.copy(yarn.pos);
      yarnBall.quaternion.copy(yarn.q);
      updateStrand();
      yarn.moved = false;
    }

    // cat transform and rig
    const s = cat.scale;
    catRoot.position.set(cat.x, cat.y, cat.z);
    catRoot.rotation.set(cat.pitch, cat.heading, cat.roll, "YXZ");
    const sq = cat.squash;
    catRoot.scale.set(s / Math.sqrt(sq), s * sq, s / Math.sqrt(sq));
    solveRig(dt, t);

    // shadows under the cat
    const air = clamp(cat.y / (3 * s), 0, 0.85);
    const sitW = poseW.sit + poseW.groom + poseW.proud;
    const fwdx = Math.sin(cat.heading),
      fwdz = Math.cos(cat.heading);
    const cx = cat.x + fwdx * lerp(0, -0.3, sitW) * s,
      cz = cat.z + fwdz * lerp(0, -0.3, sitW) * s;
    U.uCatSh.value.set(cx, cz, lerp(2.2, 1.7, sitW) * s * (1 + air * 0.4), cat.boxIn ? 0 : 0.62 * (1 - air));
    U.uCatShD.value.set(fwdx, fwdz, lerp(1.55, 1.1, sitW), cat.boxIn ? 0 : 0.8);
    const hc = (lerp(2.1, 2.6, sitW) * s + cat.y) / MOON.y;
    const mdx = -MOON.x,
      mdz = -MOON.z;
    const ml = Math.hypot(mdx, mdz);
    U.uCatMoon.value.set(cx + (mdx / ml) * hc * ml * 0.8, cz + (mdz / ml) * hc * ml * 0.8, (1.2 + hc * ml * 0.55) * 1.0, lerp(1.25, 1.1, sitW) * s);

    // dots: floor spots, glints, streaks, and the brightest few as lights
    lightList.length = 0;
    for (const d of order) {
      const sel = d.id === selectedId;
      const col = d.side === "sell" ? downCol : laser;
      const shimmer = 0.9 + 0.1 * Math.sin(t * 31 + d.seed * 20);
      const bright = (d.side === "sell" ? 0.75 : 0.85 + 0.3 * d.size) * d.on * shimmer;
      const r = (0.24 + 0.13 * d.size) * (sel ? 1.25 : 1);
      _s3.set(r, 1, r);
      _m4.compose(_dp.set(d.dot.x, d.dot.y, d.dot.z), _q0, _s3);
      spots.setMatrixAt(d.slot, _m4);
      spotC.set([col.r, col.g, col.b, bright], d.slot * 4);
      spotP.set([0, 0, sel ? 1 : 0, Math.sin(t * 6) * 0.5 + 0.5], d.slot * 4);
      _col.copy(col).multiplyScalar(bright);
      halos.set(d.slot, _dp.set(d.dot.x, d.dot.y + 0.1, d.dot.z), _col, (0.36 + 0.2 * d.size) * (sel ? 1.6 : 1));
      trails.push(d.slot, _dp.set(d.dot.x, d.dot.y + 0.04, d.dot.z));
      trails.setColor(d.slot, _col, 0.075 * d.size * d.on);
      if (d.on > 0.05) lightList.push(d);
    }
    // the hunted dot and the ones nearest the cat light the room first
    if (lightList.length > MAXD) lightList.sort((a, b) => (a === cat.target ? -1 : b === cat.target ? 1 : Math.hypot(a.dot.x - cat.x, a.dot.z - cat.z) - Math.hypot(b.dot.x - cat.x, b.dot.z - cat.z)));
    const nl = Math.min(MAXD, lightList.length);
    for (let i = 0; i < nl; i++) {
      const d = lightList[i];
      const col = d.side === "sell" ? downCol : laser;
      const k = (d.side === "sell" ? 1.6 : 2.4 + 0.9 * d.size) * d.on;
      U.uDotA.value[i].set(d.dot.x, d.dot.y + 0.5 + 0.2 * d.size, d.dot.z, 1.25 + 0.7 * d.size);
      U.uDotB.value[i].set(col.r * k, col.g * k, col.b * k, 0);
    }
    U.uDotN.value = nl;

    // catch rings
    for (let i = 0; i < RINGS; i++) {
      const rg = rings[i];
      const slot = MAX + i;
      if (rg.t >= 1) {
        if (spotC[slot * 4 + 3] !== 0) hideSpot(slot);
        continue;
      }
      rg.t += dt / (reduced ? 0.9 : 0.55);
      _s3.set(rg.s, 1, rg.s);
      _m4.compose(_dp.set(rg.x, rg.y + 0.01, rg.z), _q0, _s3);
      spots.setMatrixAt(slot, _m4);
      spotC.set([rg.c.r, rg.c.g, rg.c.b, 1], slot * 4);
      spotP.set([1, Math.min(rg.t, 1), 0, 0], slot * 4);
    }
    spots.instanceMatrix.needsUpdate = true;
    aSpotC.needsUpdate = true;
    aSpotP.needsUpdate = true;
    trails.flush();
    halos.flush();

    // sparkles
    const life = aSpkLife.array;
    for (let i = 0; i < SPK; i++) {
      if (spk.life[i] <= 0) {
        life[i] = 0;
        continue;
      }
      spk.life[i] -= dt;
      const o = i * 3;
      spk.vel[o + 1] -= 6.5 * dt;
      spk.vel[o] *= 1 - dt * 1.2;
      spk.vel[o + 2] *= 1 - dt * 1.2;
      spk.pos[o] += spk.vel[o] * dt;
      spk.pos[o + 1] = Math.max(0.05, spk.pos[o + 1] + spk.vel[o + 1] * dt);
      spk.pos[o + 2] += spk.vel[o + 2] * dt;
      const k = spk.life[i] / spk.max[i];
      life[i] = k > 0 ? Math.min(1, k * 2.2) * (0.75 + 0.25 * Math.sin(t * 40 + i)) : 0;
    }
    aSpkPos.needsUpdate = true;
    aSpkLife.needsUpdate = true;
    aSpkCol.needsUpdate = true;
    aSpkSize.needsUpdate = true;
  };

  api.dispose = () => {
    trails.dispose();
    halos.dispose();
    disposeTree(scene);
    for (const g of scratch) g.dispose();
    order.length = 0;
    byId.clear();
    gone.clear();
  };

  // first pose: sitting in the moonlight, looking toward the room
  updateStrand();
  yarnBall.position.copy(yarn.pos);
  catRoot.position.set(cat.x, 0, cat.z);
  catRoot.rotation.set(0, cat.heading, 0, "YXZ");
  catRoot.scale.setScalar(cat.scale);
  solveRig(1 / 60, 0);
  progress(0.9, "Almost there");
  return api;
}

/* ================================================================ helpers */

const cr1 = (p0, p1, p2, p3, t) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/** A radius profile along a loft: keys [s, rx, ryTop, ryBottom], smooth in between. */
function profileFn(keys) {
  return (s) => {
    let i = 0;
    while (i < keys.length - 2 && s > keys[i + 1][0]) i++;
    const k0 = keys[Math.max(i - 1, 0)],
      k1 = keys[i],
      k2 = keys[i + 1],
      k3 = keys[Math.min(i + 2, keys.length - 1)];
    const t = clamp((s - k1[0]) / (k2[0] - k1[0]), 0, 1);
    return [1, 2, 3].map((c) => Math.max(0.005, cr1(k0[c], k1[c], k2[c], k3[c], t)));
  };
}

/**
 * Two-bone IK in the plane that holds `hint`: from the root `a` toward `target`, bones l1 and l2. Writes the joint to
 * `joint` and the reached end point to `end` (the target, or as far as the bones reach toward it). Returns `end`.
 */
const _ik = V3(),
  _ip = V3();
function ik2(a, target, l1, l2, hint, joint, end) {
  _ik.subVectors(target, a);
  let L = _ik.length();
  const maxL = (l1 + l2) * 0.9995,
    minL = Math.abs(l1 - l2) + 1e-3;
  if (L < 1e-5) _ik.set(0, -1, 0), (L = 1e-5);
  const dir = _ik.divideScalar(L);
  L = clamp(L, minL, maxL);
  const x = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(l1 * l1 - x * x, 0));
  _ip.copy(hint).addScaledVector(dir, -hint.dot(dir));
  if (_ip.lengthSq() < 1e-8) _ip.set(0, 0, 1).addScaledVector(dir, -dir.z);
  _ip.normalize();
  joint.copy(a).addScaledVector(dir, x).addScaledVector(_ip, h);
  end.copy(a).addScaledVector(dir, L);
  return end;
}

/**
 * A closed tube built from rings along a Catmull-Rom spline through a few control points, rebuilt in place (no
 * allocations) whenever the control points move. Ring i sits at arc-length fraction s[i] (denser at the ends) with an
 * elliptical section: rx sideways, ryTop above and ryBottom below the spine, rounded off into a cap at either end.
 * Each vertex carries aFur = (s, cos(angle), sin(angle)·side, part) for the fur shader.
 */
class Loft {
  constructor({ rings, segs, part, side = 1, profile, capA = 0, capB = 0 }) {
    this.rings = rings;
    this.segs = segs;
    const nv = rings * segs + 2;
    this.pa = rings * segs;
    this.pb = this.pa + 1;
    this.P = new Float32Array(nv * 3);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.P, 3).setUsage(THREE.DynamicDrawUsage);
    this.aNor = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.aPos);
    g.setAttribute("normal", this.aNor);
    this.s = new Float32Array(rings);
    for (let i = 0; i < rings; i++) this.s[i] = 0.5 - 0.5 * Math.cos(Math.PI * ((i + 0.5) / rings));
    this.base = new Float32Array(rings * 3);
    for (let i = 0; i < rings; i++) {
      const s = this.s[i];
      let cap = 1;
      if (capA > 0 && s < capA) cap *= Math.sqrt(Math.max(0, 1 - (1 - s / capA) ** 2));
      if (capB > 0 && s > 1 - capB) cap *= Math.sqrt(Math.max(0, 1 - (1 - (1 - s) / capB) ** 2));
      const r = profile(s);
      this.base.set([r[0] * cap, r[1] * cap, r[2] * cap], i * 3);
    }
    this.rad = this.base.slice();
    this.cos = new Float32Array(segs);
    this.sin = new Float32Array(segs);
    const fur = new Float32Array(nv * 4);
    for (let j = 0; j < segs; j++) {
      this.cos[j] = Math.cos((j / segs) * TAU);
      this.sin[j] = Math.sin((j / segs) * TAU);
    }
    for (let i = 0; i < rings; i++)
      for (let j = 0; j < segs; j++) fur.set([this.s[i], this.cos[j], this.sin[j] * side, part], (i * segs + j) * 4);
    fur.set([0, 0, 0, part], this.pa * 4);
    fur.set([1, 0, 0, part], this.pb * 4);
    g.setAttribute("aFur", new THREE.BufferAttribute(fur, 4));
    const idx = [];
    for (let i = 0; i < rings - 1; i++)
      for (let j = 0; j < segs; j++) {
        const a = i * segs + j,
          b = i * segs + ((j + 1) % segs),
          c = a + segs,
          d = b + segs;
        idx.push(a, c, b, b, c, d);
      }
    const last = (rings - 1) * segs;
    for (let j = 0; j < segs; j++) {
      idx.push(this.pa, j, (j + 1) % segs);
      idx.push(this.pb, last + ((j + 1) % segs), last + j);
    }
    g.setIndex(idx);
    this.geometry = g;
    this.C = new Float32Array(rings * 3); // ring centres
    this.F = new Float32Array(rings * 9); // ring frames: T, S, U
    this.dense = null;
    this.cum = null;
  }

  /** Rebuild along the spline through `ctrl` (Vector3s). ref "x": sideways axis from +x; "pt": parallel transport. */
  update(ctrl, ref = "x") {
    const n = ctrl.length;
    const K = n > 8 ? 4 : n > 5 ? 8 : 12;
    const nd = (n - 1) * K + 1;
    if (!this.dense || this.dense.length !== nd * 3) {
      this.dense = new Float32Array(nd * 3);
      this.cum = new Float32Array(nd);
    }
    const D = this.dense,
      L = this.cum;
    let o = 0;
    for (let k = 0; k < n - 1; k++) {
      const p1 = ctrl[k],
        p2 = ctrl[k + 1];
      const p0 = k > 0 ? ctrl[k - 1] : null;
      const p3 = k + 2 < n ? ctrl[k + 2] : null;
      for (let m = 0; m < K; m++) {
        const t = m / K;
        D[o++] = cr1(p0 ? p0.x : 2 * p1.x - p2.x, p1.x, p2.x, p3 ? p3.x : 2 * p2.x - p1.x, t);
        D[o++] = cr1(p0 ? p0.y : 2 * p1.y - p2.y, p1.y, p2.y, p3 ? p3.y : 2 * p2.y - p1.y, t);
        D[o++] = cr1(p0 ? p0.z : 2 * p1.z - p2.z, p1.z, p2.z, p3 ? p3.z : 2 * p2.z - p1.z, t);
      }
    }
    D[o++] = ctrl[n - 1].x;
    D[o++] = ctrl[n - 1].y;
    D[o++] = ctrl[n - 1].z;
    L[0] = 0;
    for (let i = 1; i < nd; i++) {
      const dx = D[i * 3] - D[i * 3 - 3],
        dy = D[i * 3 + 1] - D[i * 3 - 2],
        dz = D[i * 3 + 2] - D[i * 3 - 1];
      L[i] = L[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const total = L[nd - 1] || 1e-4;
    const { rings, segs, C, F, P, rad } = this;
    let q = 0;
    for (let i = 0; i < rings; i++) {
      const want = this.s[i] * total;
      while (q < nd - 2 && L[q + 1] < want) q++;
      const f = clamp((want - L[q]) / Math.max(L[q + 1] - L[q], 1e-6), 0, 1);
      C[i * 3] = D[q * 3] + (D[q * 3 + 3] - D[q * 3]) * f;
      C[i * 3 + 1] = D[q * 3 + 1] + (D[q * 3 + 4] - D[q * 3 + 1]) * f;
      C[i * 3 + 2] = D[q * 3 + 2] + (D[q * 3 + 5] - D[q * 3 + 2]) * f;
    }
    let sx = 1,
      sy = 0,
      sz = 0;
    for (let i = 0; i < rings; i++) {
      const i0 = Math.max(i - 1, 0),
        i1 = Math.min(i + 1, rings - 1);
      let tx = C[i1 * 3] - C[i0 * 3],
        ty = C[i1 * 3 + 1] - C[i0 * 3 + 1],
        tz = C[i1 * 3 + 2] - C[i0 * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      if (ref === "x" || i === 0) {
        sx = 1;
        sy = 0;
        sz = 0;
      }
      // remove the tangent part of the previous sideways axis (parallel transport) or of +x
      const dd = sx * tx + sy * ty + sz * tz;
      let ax = sx - tx * dd,
        ay = sy - ty * dd,
        az = sz - tz * dd;
      let al = Math.hypot(ax, ay, az);
      if (al < 1e-4) {
        ax = 0;
        ay = 0;
        az = 1;
        const d2 = tz;
        ax -= tx * d2;
        ay -= ty * d2;
        az -= tz * d2;
        al = Math.hypot(ax, ay, az) || 1;
      }
      sx = ax / al;
      sy = ay / al;
      sz = az / al;
      // up = T × S
      const ux = ty * sz - tz * sy,
        uy = tz * sx - tx * sz,
        uz = tx * sy - ty * sx;
      F.set([tx, ty, tz, sx, sy, sz, ux, uy, uz], i * 9);
      const cx = C[i * 3],
        cy = C[i * 3 + 1],
        cz = C[i * 3 + 2];
      const rx = rad[i * 3],
        rt = rad[i * 3 + 1],
        rb = rad[i * 3 + 2];
      for (let j = 0; j < segs; j++) {
        const cs = this.cos[j],
          sn = this.sin[j];
        const ry = cs > 0 ? rt : rb;
        const v = (i * segs + j) * 3;
        P[v] = cx + sx * sn * rx + ux * cs * ry;
        P[v + 1] = cy + sy * sn * rx + uy * cs * ry;
        P[v + 2] = cz + sz * sn * rx + uz * cs * ry;
      }
    }
    P.set([D[0], D[1], D[2]], this.pa * 3);
    P.set([D[(nd - 1) * 3], D[(nd - 1) * 3 + 1], D[(nd - 1) * 3 + 2]], this.pb * 3);
    this.aPos.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  /** Centre and frame (T, S, U) at arc fraction s, from the last update. */
  frameAt(s, out) {
    let i = 0;
    while (i < this.rings - 2 && this.s[i + 1] < s) i++;
    const f = clamp((s - this.s[i]) / Math.max(this.s[i + 1] - this.s[i], 1e-6), 0, 1);
    const C = this.C,
      F = this.F;
    out.c.set(lerp(C[i * 3], C[i * 3 + 3], f), lerp(C[i * 3 + 1], C[i * 3 + 4], f), lerp(C[i * 3 + 2], C[i * 3 + 5], f));
    const b = i * 9,
      b2 = b + 9;
    out.T.set(lerp(F[b], F[b2], f), lerp(F[b + 1], F[b2 + 1], f), lerp(F[b + 2], F[b2 + 2], f)).normalize();
    out.S.set(lerp(F[b + 3], F[b2 + 3], f), lerp(F[b + 4], F[b2 + 4], f), lerp(F[b + 5], F[b2 + 5], f)).normalize();
    out.U.set(lerp(F[b + 6], F[b2 + 6], f), lerp(F[b + 7], F[b2 + 7], f), lerp(F[b + 8], F[b2 + 8], f)).normalize();
    return out;
  }
}

/** A box with rounded edges: each face is a grid with `k` rows in every rounded band, pulled onto the rounding. */
function roundedBox(w, h, d, r, k = 3, mid = 1) {
  const H = [w / 2, h / 2, d / 2];
  r = Math.min(r, H[0] * 0.95, H[1] * 0.95, H[2] * 0.95);
  const stops = (half) => {
    const inner = half - r;
    const s = [];
    for (let j = 0; j <= k; j++) s.push(-half + (r * j) / k);
    for (let j = 1; j < mid; j++) s.push(-inner + (2 * inner * j) / mid);
    for (let j = 0; j <= k; j++) s.push(inner + (r * j) / k);
    return s;
  };
  const S = H.map(stops);
  const P = [],
    N = [],
    I = [];
  const inner = H.map((x) => x - r);
  const v = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const b = (axis + 1) % 3,
        c = (axis + 2) % 3;
      const sb = S[b],
        sc = S[c];
      const start = P.length / 3;
      for (let i = 0; i < sb.length; i++)
        for (let j = 0; j < sc.length; j++) {
          v[axis] = sign * H[axis];
          v[b] = sb[i];
          v[c] = sc[j];
          const q = [clamp(v[0], -inner[0], inner[0]), clamp(v[1], -inner[1], inner[1]), clamp(v[2], -inner[2], inner[2])];
          let nx = v[0] - q[0],
            ny = v[1] - q[1],
            nz = v[2] - q[2];
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;
          P.push(q[0] + nx * r, q[1] + ny * r, q[2] + nz * r);
          N.push(nx, ny, nz);
        }
      const nc = sc.length;
      for (let i = 0; i < sb.length - 1; i++)
        for (let j = 0; j < nc - 1; j++) {
          const a = start + i * nc + j;
          // b × c = axis for these index orders, so flip the winding on the negative faces
          if (sign > 0) I.push(a, a + nc, a + 1, a + 1, a + nc, a + nc + 1);
          else I.push(a, a + 1, a + nc, a + 1, a + nc + 1, a + nc);
        }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N, 3));
  g.setIndex(I);
  return g;
}

/** Add a constant float attribute. */
function tagFloat(g, name, value) {
  g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(value), 1));
  return g;
}
/** Add the fur shader's aFur attribute with one constant value. */
function tagFur(g, value) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) a.set(value, i * 4);
  g.setAttribute("aFur", new THREE.BufferAttribute(a, 4));
  return g;
}
function keepOnly(g, names) {
  for (const n of Object.keys(g.attributes)) if (!names.includes(n)) g.deleteAttribute(n);
  return g;
}

/** The cat's head: a sphere pushed into a wide-cheeked cat shape, with muzzle pads, chin and cheek tufts. */
function headGeometry(HR, high) {
  const parts = [];
  const sph = new THREE.SphereGeometry(1, high ? 44 : 30, high ? 34 : 22);
  sph.deleteAttribute("uv");
  const p = sph.attributes.position;
  const fur = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    fur.set([x, y, z, 4], i * 4);
    const cheek = Math.exp(-((y + 0.2) ** 2) / 0.14) * sstep(-0.7, 0.2, z);
    const sx = 1.08 + 0.2 * cheek;
    const sy = y > 0 ? 0.9 - 0.05 * sstep(0.3, 1, y) : 0.9;
    const sz = z > 0 ? 0.9 - 0.06 * sstep(0.5, 1, z) * sstep(-0.1, 0.4, y) : 0.95;
    p.setXYZ(i, x * sx * HR, y * sy * HR, z * sz * HR);
  }
  sph.computeVertexNormals();
  sph.setAttribute("aFur", new THREE.BufferAttribute(fur, 4));
  parts.push(sph);
  const blob = (cx, cy, cz, rx, ry, rz, value, ws = 18, hs = 12) => {
    const g = new THREE.SphereGeometry(1, ws, hs);
    g.deleteAttribute("uv");
    g.scale(rx * HR, ry * HR, rz * HR);
    g.translate(cx * HR, cy * HR, cz * HR);
    tagFur(g, value);
    parts.push(g);
  };
  blob(0.17, -0.3, 0.76, 0.24, 0.19, 0.21, [0, 0, 1, 7]);
  blob(-0.17, -0.3, 0.76, 0.24, 0.19, 0.21, [0, 0, 1, 7]);
  blob(0, -0.44, 0.68, 0.17, 0.12, 0.15, [0, 0, 1, 7]);
  const out = mergeGeometries(parts.map((g) => keepOnly(g, ["position", "normal", "aFur"])));
  parts.forEach((g) => g.dispose());
  return out;
}

/**
 * An ear: a rounded triangle, convex at the back (fur, part 5) and cupped at the front (pink, part 6).
 * Base at y = 0, tip at y = h, facing +z.
 */
function earGeometry(w, h, high) {
  const nu = high ? 10 : 7,
    nv = high ? 10 : 7;
  const P = [],
    F = [],
    I = [];
  for (const front of [0, 1]) {
    const start = P.length / 3;
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv) * 0.97;
      for (let i = 0; i <= nu; i++) {
        const u = (i / nu) * 2 - 1;
        const half = (w / 2) * Math.pow(1 - v, 0.9) * (1 + 0.25 * v);
        const x = u * half;
        const y = v * h;
        const bulge = (1 - u * u) * (1 - 0.6 * v);
        const z = front ? -0.1 * w * bulge * Math.pow(1 - v, 0.5) + 0.02 * w * (1 - u * u) : -0.28 * w * bulge;
        P.push(x, y, z);
        F.push(u, v, 0, front ? 6 : 5);
      }
    }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = start + j * (nu + 1) + i,
          b = a + 1,
          c = a + nu + 1,
          d = c + 1;
        if (front) I.push(a, b, c, b, d, c);
        else I.push(a, c, b, b, c, d);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("aFur", new THREE.Float32BufferAttribute(F, 4));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}
