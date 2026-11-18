// Grove: a dusk valley with a giant glowing blossom tree, honeycomb hives and a meadow of glowing flowers.
// Trades are bees: buys fly out of the hives (gold) and forage, sells (red) leave the valley.
import { THREE, GLSL_NOISE, mergeGeometries, tagGeometry, keepAttributes, Trails, Halos, clamp, lerp, damp, disposeTree } from "./common.js";
import { rng, sizeForUsd } from "./format.js";

export const GROVE_DEFAULTS = { accent: "#ffb547", accent2: "#ff7eb0", up: "#ffc75a", down: "#ff4747", bg: "#0b0710" };

const TAU = Math.PI * 2;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const C = (hex) => new THREE.Color(hex);
const pause = () => new Promise((r) => setTimeout(r, 0));
const smooth01 = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/* ----------------------------------------------------------- JS noise */

function makeNoise(seed) {
  const hash = (x, y) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = (x, y) => {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    const fx = x - ix,
      fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx),
      uy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy),
      b = hash(ix + 1, iy),
      c = hash(ix, iy + 1),
      d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (x, y, oct = 5) => {
    let s = 0,
      a = 0.5,
      f = 1,
      n = 0;
    for (let i = 0; i < oct; i++) {
      s += a * noise(x * f + i * 17.3, y * f - i * 9.1);
      n += a;
      f *= 2.03;
      a *= 0.5;
    }
    return s / n;
  };
  const noise3 = (x, y, z) => (noise(x + z * 1.71, y - z * 1.33) + noise(y + 5.2 - z * 0.7, x - 1.3 + z)) * 0.5;
  return { noise, fbm, noise3 };
}

/* ---------------------------------------------------------------- GLSL */

const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uHorizonWarm;
uniform vec3 uHorizonCool;
uniform vec3 uSunColor;
uniform vec3 uGroundTint;
uniform vec3 uFogCool;
uniform vec3 uFogWarm;
uniform float uFogDensity;
float sunSide(vec3 d) {
  vec2 hz = d.xz / max(length(d.xz), 1e-4);
  return dot(hz, normalize(uSunDir.xz)) * 0.5 + 0.5;
}
vec3 skyColor(vec3 d) {
  float h = d.y;
  float warm = pow(sunSide(d), 5.0);
  vec3 horizon = mix(uHorizonCool, uHorizonWarm, warm);
  // the warm band hugs the horizon and swells toward the sun
  float band = mix(0.07, 0.24, warm);
  vec3 col = mix(horizon, uSkyMid, smoothstep(-0.01, band, h));
  col = mix(col, uSkyTop, smoothstep(band * 0.7, 0.8, h));
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 6.0) * 0.34 + pow(sd, 36.0) * 0.7 + pow(sd, 300.0) * 1.1) * exp(-max(h, 0.0) * 5.0);
  col = mix(col, uGroundTint, smoothstep(0.0, -0.1, h));
  return col;
}
vec3 fogColor(vec3 dir) {
  return mix(uFogCool, uFogWarm, pow(sunSide(dir), 4.0));
}
vec3 fogIt(vec3 col, vec3 wp) {
  vec3 V = wp - cameraPosition;
  float d = length(V);
  float f = 1.0 - exp(-d * uFogDensity);
  return mix(col, fogColor(V / max(d, 1e-4)), f);
}
`;

const LIGHT_GLSL = /* glsl */ `
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uAmbHigh;
uniform vec3 uAmbLow;
uniform vec3 uGlowColor;
uniform vec3 uTreeCenter;
uniform float uTreeGlow;
uniform float uTreeGlowR;
vec3 treeLight(vec3 n, vec3 wp) {
  vec3 toT = uTreeCenter - wp;
  float d = length(toT);
  float k = exp(-(d * d) / (uTreeGlowR * uTreeGlowR)) * uTreeGlow;
  return uGlowColor * k * (0.35 + 0.65 * max(dot(n, toT / max(d, 1e-3)), 0.0));
}
vec3 lightIt(vec3 base, vec3 n, vec3 wp) {
  float key = max(dot(n, uKeyDir), 0.0);
  vec3 amb = mix(uAmbLow, uAmbHigh, n.y * 0.5 + 0.5);
  return base * (amb + uKeyColor * key + treeLight(n, wp));
}
`;

const INST = /* glsl */ `
#ifdef USE_INSTANCING
  mat4 instM = instanceMatrix;
#else
  mat4 instM = mat4(1.0);
#endif
`;

/* =================================================================== */

export async function createGrove(ctx) {
  const { palette, quality, reduced, px, progress = () => {}, maxCreatures = 250 } = ctx;
  const Q = quality === "high" ? 1 : quality === "medium" ? 0.55 : 0.4;
  const R = rng(20260927);
  const N = makeNoise(1337);
  const scene = new THREE.Scene();
  const disposables = [];

  const accent = palette.accent.clone();
  const accent2 = palette.accent2.clone();
  const downCol = palette.down.clone();
  const warmWhite = C("#fff1d2");
  const veinColor = warmWhite.clone().lerp(accent, 0.28);

  // --------------------------------------------------------- shared uniforms
  const sunDir = V3(0.42, 0.012, -1).normalize();
  const U = {
    uTime: { value: 0 },
    uPx: px,
    uGrowth: { value: 0.5 },
    // sky
    uSunDir: { value: sunDir },
    uSkyTop: { value: C("#110c25") },
    uSkyMid: { value: C("#33203f") },
    uHorizonWarm: { value: C("#e46a2e") },
    uHorizonCool: { value: C("#3d1f3b") },
    uSunColor: { value: C("#ff7a3c") },
    uGroundTint: { value: C("#0e080d") },
    uFogCool: { value: C("#1e1323") },
    uFogWarm: { value: C("#4a2321") },
    uFogDensity: { value: 0.0055 },
    // light
    uKeyDir: { value: V3(0.25, 0.72, 0.65).normalize() },
    uKeyColor: { value: C("#ffd9bd").multiplyScalar(0.92) },
    uAmbHigh: { value: C("#4b3b78").multiplyScalar(0.34) },
    uAmbLow: { value: C("#24121a").multiplyScalar(0.4) },
    uGlowColor: { value: accent.clone().lerp(warmWhite, 0.25).multiplyScalar(1.1) },
    uTreeCenter: { value: V3(0, 8, 0) },
    uTreeGlow: { value: 1 },
    uTreeGlowR: { value: 14 },
  };
  if (palette.bg) U.uSkyTop.value.lerp(palette.bg, 0.35);

  const skyUniforms = {
    uSunDir: U.uSunDir,
    uSkyTop: U.uSkyTop,
    uSkyMid: U.uSkyMid,
    uHorizonWarm: U.uHorizonWarm,
    uHorizonCool: U.uHorizonCool,
    uSunColor: U.uSunColor,
    uGroundTint: U.uGroundTint,
    uFogCool: U.uFogCool,
    uFogWarm: U.uFogWarm,
    uFogDensity: U.uFogDensity,
  };
  const lightUniforms = {
    uKeyDir: U.uKeyDir,
    uKeyColor: U.uKeyColor,
    uAmbHigh: U.uAmbHigh,
    uAmbLow: U.uAmbLow,
    uGlowColor: U.uGlowColor,
    uTreeCenter: U.uTreeCenter,
    uTreeGlow: U.uTreeGlow,
    uTreeGlowR: U.uTreeGlowR,
  };

  const groundY = (x, z) => {
    const r = Math.hypot(x, z);
    const near = (N.fbm(x * 0.045, z * 0.045, 4) - 0.5) * 1.3 * smooth01((r - 7) / 16);
    const far = Math.pow(smooth01((r - 120) / 420), 1.3) * (N.fbm(x * 0.0045 + 9, z * 0.0045 - 3, 4) * 75 - 10);
    return near + far;
  };

  /* ------------------------------------------------------------- sky */
  progress(0.05, "Painting the sky");
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);
  {
    const geo = new THREE.SphereGeometry(1500, 64, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...skyUniforms, uTime: U.uTime },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        /* glsl */ `
        uniform float uTime;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d);
          // faint high cirrus streaks lit by the sunset
          float h = d.y;
          vec2 p = d.xz / max(h + 0.25, 0.08);
          float cl = fbm2(p * vec2(1.2, 3.4) + vec2(0.0, 0.0)) ;
          float band = smoothstep(0.55, 0.85, cl) * smoothstep(0.02, 0.14, h) * (1.0 - smoothstep(0.35, 0.7, h));
          float sd = max(dot(d, uSunDir), 0.0);
          col += (uHorizonWarm * 0.3 + uSunColor * pow(sd, 6.0) * 0.5) * band * 0.3;
          col *= 1.0 + (hash12(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.035;
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    skyGroup.add(sky);

    // stars
    const n = Math.round(1400 * (Q > 0.5 ? 1 : 0.6));
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const y = 0.06 + Math.pow(R(), 0.8) * 0.94;
      const a = R() * TAU;
      const r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(a) * r * 1400, y * 1400, Math.sin(a) * r * 1400], i * 3);
      seed[i * 2] = R();
      seed[i * 2 + 1] = Math.pow(R(), 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 2));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uSunDir: U.uSunDir, uDpr: { value: Math.min(2, window.devicePixelRatio || 1) } },
      vertexShader: /* glsl */ `
        attribute vec2 aSeed;
        uniform float uTime;
        uniform float uDpr;
        uniform vec3 uSunDir;
        varying float vA;
        void main() {
          vec3 d = normalize(position);
          float tw = 0.65 + 0.35 * sin(uTime * (0.8 + aSeed.x * 2.5) + aSeed.x * 60.0);
          float fade = smoothstep(0.06, 0.4, d.y) * (1.0 - smoothstep(0.75, 0.98, dot(d, uSunDir)));
          vA = tw * fade * (0.25 + 0.75 * aSeed.y);
          gl_PointSize = (1.2 + aSeed.y * 2.0) * uDpr;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float k = exp(-dot(q, q) * 3.5);
          gl_FragColor = vec4(vec3(1.0, 0.93, 0.85) * vA * k * 1.6, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(g, m);
    stars.renderOrder = -99;
    stars.frustumCulled = false;
    skyGroup.add(stars);
  }
  await pause();

  /* ------------------------------------------------------- mountains */
  progress(0.12, "Raising the mountains");
  {
    const layers = [
      { r: 250, h0: 8, h1: 46, col: "#1b152d", haze: 0.04, seg: 170, valley: 0.6, jag: 5 },
      { r: 330, h0: 16, h1: 74, col: "#241a38", haze: 0.16, seg: 160, valley: 0.42, jag: 7 },
      { r: 450, h0: 26, h1: 112, col: "#302245", haze: 0.3, seg: 140, valley: 0.25, jag: 10 },
      { r: 620, h0: 40, h1: 170, col: "#3f2b55", haze: 0.46, seg: 120, valley: 0.1, jag: 12 },
    ];
    const sunA = Math.atan2(sunDir.z, sunDir.x);
    const P = [],
      RID = [],
      HZ = [],
      COL = [],
      IDX = [];
    let base = 0;
    layers.forEach((L, li) => {
      const col = C(L.col);
      const rows = [-0.35, 0.42, 0.74, 1.0];
      const heights = [];
      for (let j = 0; j <= L.seg; j++) {
        const th = (j / L.seg) * TAU;
        const n = N.fbm(Math.cos(th) * 2.4 + li * 7.1, Math.sin(th) * 2.4 - li * 3.3, 5);
        const ridged = 1 - Math.abs(2 * n - 1);
        let h = L.h0 + (L.h1 - L.h0) * Math.pow(ridged, 1.6) * (0.55 + 0.45 * n);
        let dth = Math.atan2(Math.sin(th - sunA), Math.cos(th - sunA));
        h *= 1 - L.valley * Math.exp(-((dth / 0.32) ** 2));
        heights.push(h);
      }
      heights[L.seg] = heights[0];
      for (let j = 0; j <= L.seg; j++) {
        const th = (j / L.seg) * TAU;
        const jitterSeed = j === L.seg ? 0 : j;
        for (let k = 0; k < rows.length; k++) {
          const fr = rows[k];
          const hj = heights[j];
          let y = fr < 0 ? -30 : hj * fr;
          let rr = L.r;
          if (k > 0 && k < rows.length - 1) {
            const q = N.noise(jitterSeed * 1.7 + k * 13.1, li * 5.3);
            rr += (q - 0.5) * L.jag * 2.2;
            y += (N.noise(jitterSeed * 2.3 + k * 7.7, li * 3.1 + 40) - 0.5) * hj * 0.16;
          }
          if (k === rows.length - 1) y += (N.noise(jitterSeed * 3.1, li * 9.1 + 70) - 0.5) * L.jag * 0.9;
          P.push(Math.cos(th) * rr, y, Math.sin(th) * rr);
          RID.push(Math.max(fr, 0));
          HZ.push(L.haze);
          COL.push(col.r, col.g, col.b);
        }
      }
      const nr = rows.length;
      for (let j = 0; j < L.seg; j++)
        for (let k = 0; k < nr - 1; k++) {
          const a = base + j * nr + k,
            b = base + (j + 1) * nr + k;
          IDX.push(a, b, a + 1, b, b + 1, a + 1);
        }
      base += (L.seg + 1) * nr;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute("aRidge", new THREE.Float32BufferAttribute(RID, 1));
    g.setAttribute("aHaze", new THREE.Float32BufferAttribute(HZ, 1));
    g.setAttribute("aCol", new THREE.Float32BufferAttribute(COL, 3));
    g.setIndex(IDX);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...skyUniforms, uRim: { value: C("#ff5030").multiplyScalar(1.25) } },
      vertexShader: /* glsl */ `
        attribute float aRidge;
        attribute float aHaze;
        attribute vec3 aCol;
        varying float vRidge;
        varying float vHaze;
        varying vec3 vCol;
        varying vec3 vWorld;
        void main() {
          vRidge = aRidge; vHaze = aHaze; vCol = aCol;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        SKY_GLSL +
        /* glsl */ `
        uniform vec3 uRim;
        varying float vRidge;
        varying float vHaze;
        varying vec3 vCol;
        varying vec3 vWorld;
        void main() {
          vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          vec3 V = vWorld - cameraPosition;
          if (dot(n, V) > 0.0) n = -n;
          vec3 v = normalize(V);
          float sun = max(dot(n, normalize(vec3(uSunDir.x, 0.35, uSunDir.z))), 0.0);
          float up = n.y * 0.5 + 0.5;
          vec3 col = vCol * (0.55 + 0.55 * up) + vCol * uSunColor * sun * 0.7;
          float toward = pow(max(dot(normalize(v.xz), normalize(uSunDir.xz)), 0.0), 2.0);
          float rim = smoothstep(0.978, 1.0, vRidge) * (0.12 + 0.95 * toward);
          col += uRim * rim;
          vec3 sky = skyColor(normalize(vec3(v.x, max(v.y, 0.0) * 0.6 + 0.01, v.z)));
          float haze = clamp(vHaze + (1.0 - vRidge) * 0.16, 0.0, 0.9);
          col = mix(col, sky, haze);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mtn = new THREE.Mesh(g, m);
    mtn.renderOrder = -50;
    scene.add(mtn);
  }
  await pause();

  /* ---------------------------------------------------------- ground */
  progress(0.2, "Rolling out the meadow");
  {
    const K = 64,
      S = 128,
      RMAX = 1100;
    const P = [0, groundY(0, 0), 0];
    const IDX = [];
    for (let k = 1; k <= K; k++) {
      const r = RMAX * Math.pow(k / K, 2.3);
      for (let s = 0; s < S; s++) {
        const a = (s / S) * TAU;
        const x = Math.cos(a) * r,
          z = Math.sin(a) * r;
        P.push(x, groundY(x, z), z);
      }
    }
    for (let s = 0; s < S; s++) IDX.push(0, 1 + ((s + 1) % S), 1 + s);
    for (let k = 1; k < K; k++)
      for (let s = 0; s < S; s++) {
        const a = 1 + (k - 1) * S + s,
          b = 1 + (k - 1) * S + ((s + 1) % S);
        const c = a + S,
          d = b + S;
        IDX.push(a, b, c, b, d, c);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(IDX);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        ...lightUniforms,
        uTime: U.uTime,
        uSoilA: { value: C("#1c1016") },
        uSoilB: { value: C("#2e1a1b") },
        uMoss: { value: C("#1f2418") },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform vec3 uSoilA;
        uniform vec3 uSoilB;
        uniform vec3 uMoss;
        varying vec3 vWorld;
        void main() {
          vec2 p = vWorld.xz;
          float r = length(p);
          vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
          if (n.y < 0.0) n = -n;
          float n1 = fbm2(p * 0.03);
          float n2 = vnoise(p * 0.42);
          float n3 = vnoise(p * 2.3);
          vec3 soil = mix(uSoilA, uSoilB, smoothstep(0.32, 0.72, n1));
          soil = mix(soil, uMoss, smoothstep(0.5, 0.78, fbm2(p * 0.055 + 13.0)) * 0.7);
          soil *= 0.72 + 0.4 * n2 + 0.18 * n3;
          vec3 col = lightIt(soil, n, vWorld);
          // warm pool of light under the tree
          float gr = uTreeGlowR * 1.05;
          col += uGlowColor * soil * 6.0 * exp(-(r * r) / (gr * gr)) * uTreeGlow;
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const ground = new THREE.Mesh(g, m);
    ground.renderOrder = -40;
    scene.add(ground);
  }
  await pause();

  /* ----------------------------------------------------------- grass */
  progress(0.26, "Growing the grass");
  {
    const blades = 7;
    const P = [],
      H = [];
    for (let b = 0; b < blades; b++) {
      const a = (b / blades) * TAU + R() * 0.8;
      const h = 0.35 + R() * 0.55;
      const w = 0.035 + R() * 0.03;
      const lean = 0.08 + R() * 0.25;
      const ox = (R() - 0.5) * 0.35,
        oz = (R() - 0.5) * 0.35;
      const dx = Math.cos(a),
        dz = Math.sin(a);
      const px_ = -dz * w,
        pz_ = dx * w;
      P.push(ox - px_, 0, oz - pz_, ox + px_, 0, oz + pz_, ox + dx * lean, h, oz + dz * lean);
      H.push(0, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute("aH", new THREE.Float32BufferAttribute(H, 1));
    g.computeVertexNormals();
    const count = Math.round(9000 * Q);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        ...lightUniforms,
        uTime: U.uTime,
        uBase: { value: C("#120a0d") },
        uTipA: { value: C("#3b2a22") },
        uTipB: { value: C("#2d2a1c") },
        uMotion: { value: reduced ? 0.3 : 1 },
      },
      vertexShader:
        GLSL_NOISE +
        /* glsl */ `
        attribute float aH;
        uniform float uTime;
        uniform float uMotion;
        varying float vH;
        varying float vRand;
        varying vec3 vWorld;
        void main() {
          ${INST}
          vec3 o = instM[3].xyz;
          float ph = hash12(o.xz);
          vec4 wp = modelMatrix * instM * vec4(position, 1.0);
          float t = uTime * uMotion;
          float sway = sin(t * 1.4 + o.x * 0.3 + o.z * 0.17) * 0.6 + sin(t * 2.9 + ph * 6.28) * 0.3;
          wp.x += sway * 0.1 * aH;
          wp.z += sway * 0.05 * aH;
          vH = aH; vRand = ph; vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform vec3 uBase;
        uniform vec3 uTipA;
        uniform vec3 uTipB;
        varying float vH;
        varying float vRand;
        varying vec3 vWorld;
        void main() {
          vec3 tip = mix(uTipA, uTipB, vRand);
          vec3 c = mix(uBase, tip, vH);
          vec3 col = lightIt(c, vec3(0.0, 1.0, 0.0), vWorld) * 1.2;
          vec3 V = normalize(vWorld - cameraPosition);
          col += uSunColor * c * pow(max(dot(V, uSunDir), 0.0), 5.0) * vH * 3.0;
          float r = length(vWorld.xz);
          col += uGlowColor * c * 5.0 * exp(-(r * r) / (uTreeGlowR * uTreeGlowR * 1.1)) * uTreeGlow * vH;
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const inst = new THREE.InstancedMesh(g, m, count);
    const mm = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = V3();
    let i = 0;
    let guard = 0;
    while (i < count && guard++ < count * 6) {
      const r = 3.2 + 95 * Math.pow(R(), 1.35);
      const a = R() * TAU;
      const x = Math.cos(a) * r,
        z = Math.sin(a) * r;
      const patch = N.fbm(x * 0.06 + 3, z * 0.06 - 7, 3);
      if (R() > 0.25 + patch * 0.9) continue;
      q.setFromAxisAngle(V3(0, 1, 0), R() * TAU);
      const sc = 0.7 + R() * 0.9 + patch * 0.5;
      s.set(sc, sc * (0.8 + R() * 0.5), sc);
      mm.compose(V3(x, groundY(x, z) - 0.02, z), q, s);
      inst.setMatrixAt(i++, mm);
    }
    inst.count = i;
    inst.frustumCulled = false;
    scene.add(inst);
  }
  await pause();

  /* --------------------------------------------------------- flowers */
  progress(0.34, "Opening the flowers");
  const flowerHeads = []; // world positions of flower heads (bee targets)
  {
    const g = flowerGeometry();
    const count = Math.round(520 * Q);
    const palette6 = [C("#ff5a4c"), C("#ff7fae"), C("#c77dff"), C("#ffa06a"), C("#8de5c3"), C("#b59cff"), C("#ff6f8f"), accent2.clone()];
    const colors = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        ...lightUniforms,
        uTime: U.uTime,
        uMotion: { value: reduced ? 0.3 : 1 },
        uStem: { value: C("#1e3326") },
        uLeaf: { value: C("#27432f") },
        uCenter: { value: C("#ffd98a") },
        uPetalGlow: { value: 1 },
      },
      vertexShader:
        /* glsl */ `
        attribute float aPart;
        attribute float aTip;
        attribute vec3 aColor;
        attribute float aPhase;
        uniform float uTime;
        uniform float uMotion;
        varying float vPart;
        varying float vTip;
        varying vec3 vColor;
        varying float vPhase;
        varying vec3 vN;
        varying vec3 vWorld;
        void main() {
          ${INST}
          vec3 p = position;
          float bend = clamp(p.y, 0.0, 1.3);
          bend *= bend;
          float t = uTime * uMotion;
          vec2 sway = vec2(sin(t * 1.25 + aPhase), cos(t * 1.05 + aPhase * 1.7)) * 0.075;
          p.xz += sway * bend;
          if (aPart > 1.5 && aPart < 2.5) p.y += sin(t * 0.8 + aPhase) * 0.012 * aTip;
          vec4 wp = modelMatrix * instM * vec4(p, 1.0);
          vN = normalize(mat3(modelMatrix * instM) * normal);
          vPart = aPart; vTip = aTip; vColor = aColor; vPhase = aPhase; vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform float uTime;
        uniform vec3 uStem;
        uniform vec3 uLeaf;
        uniform vec3 uCenter;
        uniform float uPetalGlow;
        varying float vPart;
        varying float vTip;
        varying vec3 vColor;
        varying float vPhase;
        varying vec3 vN;
        varying vec3 vWorld;
        void main() {
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          float pulse = 0.82 + 0.18 * sin(uTime * 0.7 + vPhase * 3.0);
          vec3 col;
          if (vPart < 0.5) {
            col = lightIt(uStem, n, vWorld);
          } else if (vPart < 1.5) {
            col = lightIt(uLeaf * (0.7 + 0.5 * vTip), n, vWorld);
          } else if (vPart < 2.5) {
            float edge = smoothstep(0.25, 1.0, vTip);
            vec3 base = vColor * mix(0.35, 1.0, edge);
            col = lightIt(base, n, vWorld) + vColor * (0.1 + 0.95 * edge * edge) * uPetalGlow * pulse;
          } else {
            col = uCenter * (2.2 + 1.2 * pulse);
          }
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const inst = new THREE.InstancedMesh(g, m, count);
    const mm = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let i = 0,
      guard = 0;
    while (i < count && guard++ < count * 8) {
      const big = i < 10;
      const r = big ? 6.5 + R() * 12 : 5.5 + 82 * Math.pow(R(), 1.55);
      const a = R() * TAU;
      const x = Math.cos(a) * r,
        z = Math.sin(a) * r;
      const cl = N.fbm(x * 0.05 + 11, z * 0.05 - 5, 3);
      if (!big && R() > 0.18 + cl * 1.1) continue;
      const sc = big ? 2.1 + R() * 1.1 : 0.75 + R() * 0.75 + (r < 20 ? 0.25 : 0);
      e.set((R() - 0.5) * 0.25, R() * TAU, (R() - 0.5) * 0.25);
      q.setFromEuler(e);
      const y = groundY(x, z) - 0.03;
      mm.compose(V3(x, y, z), q, V3(sc, sc * (0.85 + R() * 0.4), sc));
      inst.setMatrixAt(i, mm);
      const col = palette6[Math.floor(R() * palette6.length)].clone();
      col.offsetHSL((R() - 0.5) * 0.04, 0, (R() - 0.5) * 0.08);
      colors.set([col.r, col.g, col.b], i * 3);
      phases[i] = R() * TAU;
      if (r < 48) flowerHeads.push(V3(x, y + sc * 1.02, z));
      i++;
    }
    inst.count = i;
    g.setAttribute("aColor", new THREE.InstancedBufferAttribute(colors, 3));
    g.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    inst.frustumCulled = false;
    scene.add(inst);
  }
  await pause();

  /* --------------------------------------------- fireflies + specks */
  progress(0.4, "Waking the fireflies");
  const floaters = [];
  function makeFloaters({ count, place, colA, colB, size, intensity, speed, radius, blink }) {
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const p = place(i);
      pos.set([p.x, p.y, p.z], i * 3);
      seed.set([R(), speed * (0.5 + R()), radius * (0.4 + R() * 0.8), R()], i * 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime,
        uPx: px,
        uSize: { value: size },
        uColA: { value: colA },
        uColB: { value: colB },
        uIntensity: { value: intensity },
        uBlink: { value: blink },
        uMotion: { value: reduced ? 0.3 : 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime;
        uniform float uPx;
        uniform float uSize;
        uniform float uBlink;
        uniform float uMotion;
        varying float vA;
        varying float vMix;
        void main() {
          float t = uTime * uMotion * aSeed.y + aSeed.x * 6.2831;
          vec3 p = position + vec3(sin(t) * aSeed.z, sin(t * 0.73 + 1.3) * aSeed.z * 0.45, cos(t * 0.91) * aSeed.z);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float b = sin(uTime * (0.5 + aSeed.w * 1.2) + aSeed.x * 40.0) * 0.5 + 0.5;
          vA = mix(1.0, smoothstep(0.2, 0.95, b), uBlink);
          vMix = aSeed.w;
          float s = uSize * (0.6 + 0.8 * fract(aSeed.x * 13.7)) * uPx / max(-mv.z, 0.1);
          vA *= clamp(s / 1.5, 0.0, 1.0);
          gl_PointSize = clamp(s, 1.5, 64.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColA;
        uniform vec3 uColB;
        uniform float uIntensity;
        varying float vA;
        varying float vMix;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d = dot(q, q);
          if (d > 1.0) discard;
          float k = exp(-d * 9.0) + exp(-d * 2.5) * 0.18;
          gl_FragColor = vec4(mix(uColA, uColB, vMix) * k * vA * uIntensity, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    floaters.push(pts);
    return pts;
  }
  scene.add(
    makeFloaters({
      count: Math.round(520 * Q),
      place: () => {
        const r = 4 + 75 * Math.pow(R(), 1.3),
          a = R() * TAU;
        const x = Math.cos(a) * r,
          z = Math.sin(a) * r;
        return V3(x, groundY(x, z) + 0.5 + Math.pow(R(), 2) * 7, z);
      },
      colA: C("#ffd76a").multiplyScalar(1),
      colB: C("#d4ff8a"),
      size: 0.13,
      intensity: 3.2,
      speed: 0.35,
      radius: 1.4,
      blink: 1,
    }),
  );
  scene.add(
    makeFloaters({
      count: Math.round(2600 * Q),
      place: () => {
        const r = 2.5 + 90 * Math.pow(R(), 1.5),
          a = R() * TAU;
        const x = Math.cos(a) * r,
          z = Math.sin(a) * r;
        return V3(x, groundY(x, z) + 0.04 + R() * 0.25, z);
      },
      colA: C("#ffb36a"),
      colB: C("#ff7fb0"),
      size: 0.055,
      intensity: 1.6,
      speed: 0.05,
      radius: 0.05,
      blink: 0.8,
    }),
  );
  await pause();

  /* ------------------------------------------------------------ tree */
  progress(0.48, "Growing the world tree");
  const tree = new THREE.Group();
  scene.add(tree);
  const tubes = [];
  const TR = (curve, rFn, radial, segs, level, lines) => {
    const t = { curve, rFn, radial, segs, level, lines, len: curve.getLength() };
    tubes.push(t);
    return t;
  };
  // trunk
  const trunk = new THREE.CatmullRomCurve3([V3(0, -0.8, 0), V3(0.35, 3.1, 0.2), V3(-0.3, 6.5, -0.25), V3(0.25, 9.6, 0.12), V3(0.05, 12.4, -0.05)]);
  TR(trunk, (t) => lerp(2.7, 1.45, t) * (1 + 0.55 * Math.exp(-t * 8)), 30, 60, 0, 14);
  // roots
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + (R() - 0.5) * 0.45;
    const len = 4.5 + R() * 4;
    const c = Math.cos(a),
      s = Math.sin(a);
    const lift = 0.3 + R() * 0.4;
    const pts = [V3(c * 0.7, 2.2, s * 0.7), V3(c * 2.1, 1.0 + lift, s * 2.1), V3(c * (2.3 + len * 0.45), 0.35 + lift * 0.4, s * (2.3 + len * 0.45)), V3(c * (2.4 + len), -0.45, s * (2.4 + len))];
    TR(new THREE.CatmullRomCurve3(pts), (t) => lerp(1.05, 0.08, Math.pow(t, 0.75)), 12, 22, 0, 3);
  }
  // limbs: [azimuth deg, height along trunk, pitch deg, length, droop, isLow]
  const limbDefs = [
    [18, 0.6, 6, 12.5, 1.2, true],
    [165, 0.57, 9, 13, 1.0, true],
    [262, 0.64, 14, 10, 0.8, true],
    [95, 0.74, 34, 10, 0.4, false],
    [212, 0.77, 40, 10.5, 0.3, false],
    [325, 0.8, 32, 11, 0.4, false],
    [140, 0.88, 52, 9, 0.2, false],
    [45, 0.92, 48, 9, 0.2, false],
    [0, 0.99, 82, 7.5, 0, false],
  ];
  const limbs = [];
  const clumps = []; // {c: Vector3, r}
  const up = V3(0, 1, 0);
  const tmp = V3();
  function branchCurve(start, dir, len, droop, wiggle) {
    const side = V3().crossVectors(dir, up);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const pts = [start.clone()];
    const n = 4;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const p = start.clone().addScaledVector(dir, len * f);
      p.y -= droop * Math.sin(f * Math.PI * 0.9) * len * 0.12;
      p.y += (f * f) * len * 0.08;
      p.addScaledVector(side, (R() - 0.5) * wiggle * len * 0.12 * f);
      p.y += (R() - 0.5) * wiggle * len * 0.05 * f;
      pts.push(p);
    }
    return new THREE.CatmullRomCurve3(pts);
  }
  for (const [az, h, pitchDeg, len, droop, low] of limbDefs) {
    const a = THREE.MathUtils.degToRad(az + (R() - 0.5) * 10);
    const pitch = THREE.MathUtils.degToRad(pitchDeg + (R() - 0.5) * 6);
    const start = trunk.getPointAt(h);
    const dir = V3(Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch)).normalize();
    const curve = branchCurve(start, dir, len, droop, 1);
    const r0 = low ? 1.15 : 1.0;
    const limb = TR(curve, (t) => lerp(r0, 0.22, Math.pow(t, 0.85)) * (1 + 0.35 * Math.exp(-t * 14)), 14, 30, 1, 4);
    limb.low = low;
    limbs.push(limb);
    // sub-branches
    const nSub = low ? 3 : 2 + (R() < 0.6 ? 1 : 0);
    for (let k = 0; k < nSub; k++) {
      const t = low ? 0.45 + k * 0.2 + R() * 0.08 : 0.42 + k * 0.22 + R() * 0.1;
      const p = curve.getPointAt(Math.min(t, 0.97));
      const tan = curve.getTangentAt(Math.min(t, 0.97));
      const rnd = V3(R() - 0.5, R() * 0.9 + 0.2, R() - 0.5).normalize();
      const d2 = tan.clone().lerp(rnd, 0.55).normalize();
      if (low) d2.y = Math.abs(d2.y) * 0.9 + 0.25;
      d2.normalize();
      const l2 = len * (0.42 + R() * 0.22);
      const c2 = branchCurve(p, d2, l2, 0.2, 1.2);
      const rr = lerp(r0, 0.22, t) * 0.7;
      TR(c2, (tt) => lerp(rr, 0.08, tt), 9, 16, 2, 3);
      // twigs
      const nTw = 2;
      for (let w = 0; w < nTw; w++) {
        const tw = 0.5 + w * 0.3 + R() * 0.1;
        const p3 = c2.getPointAt(Math.min(tw, 0.98));
        const d3 = c2.getTangentAt(Math.min(tw, 0.98)).lerp(V3(R() - 0.5, R() * 0.8, R() - 0.5).normalize(), 0.6).normalize();
        const l3 = 1.6 + R() * 1.6;
        const c3 = branchCurve(p3, d3, l3, 0, 1.5);
        TR(c3, (tt) => lerp(0.12, 0.035, tt), 6, 8, 3, 2);
        if (R() < 0.55) clumps.push({ c: c3.getPointAt(1), r: 2.2 + R() * 1.0 });
      }
      clumps.push({ c: c2.getPointAt(1), r: 2.6 + R() * 1.2 });
    }
    clumps.push({ c: curve.getPointAt(1).clone().add(V3(0, 0.6, 0)), r: low ? 3.0 + R() * 0.6 : 3.2 + R() * 1.0 });
  }
  // fill the crown dome with extra clumps so the canopy reads as one mass
  const crownC = V3(0, 17.2, 0);
  const crownR = V3(12.5, 5.8, 12.5);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU + R() * 0.3;
    const el = 0.15 + R() * 0.95;
    const d = V3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const p = V3(d.x * crownR.x * (0.7 + R() * 0.25), d.y * crownR.y, d.z * crownR.z * (0.7 + R() * 0.25)).add(crownC);
    clumps.push({ c: p, r: 3.2 + R() * 1.4 });
  }
  clumps.push({ c: V3(0, 20.5, 0), r: 4.6 });
  clumps.push({ c: V3(2.5, 19.5, 3), r: 4.2 });
  clumps.push({ c: V3(-3, 19, -2.5), r: 4.2 });

  // bark mesh
  {
    const P = [],
      NR = [],
      BK = [],
      LV = [],
      SD = [],
      IDX = [];
    let base = 0;
    for (const tb of tubes) {
      const { curve, rFn, radial, segs, level, lines, len } = tb;
      const frames = curve.computeFrenetFrames(segs, false);
      const r0 = rFn(0);
      const along = lines / (TAU * r0);
      const seed = R();
      const off = R() * 20;
      const pt = V3();
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        curve.getPointAt(t, pt);
        const Nn = frames.normals[i],
          B = frames.binormals[i];
        const r = rFn(t);
        for (let j = 0; j <= radial; j++) {
          const u = j / radial;
          const ang = u * TAU;
          const cx = Math.cos(ang),
            sx = Math.sin(ang);
          const nx = Nn.x * cx + B.x * sx,
            ny = Nn.y * cx + B.y * sx,
            nz = Nn.z * cx + B.z * sx;
          const bump = level === 0 ? 1 + (N.noise3(pt.x * 0.9 + cx, pt.y * 0.6, pt.z * 0.9 + sx) - 0.5) * 0.28 : 1 + (N.noise(u * 5 + seed * 9, t * len * 0.4) - 0.5) * 0.12;
          P.push(pt.x + nx * r * bump, pt.y + ny * r * bump, pt.z + nz * r * bump);
          NR.push(nx, ny, nz);
          BK.push(u * lines, (t * len + off) * along);
          LV.push(level);
          SD.push(seed);
        }
      }
      for (let i = 0; i < segs; i++)
        for (let j = 0; j < radial; j++) {
          const a = base + i * (radial + 1) + j;
          const b = a + radial + 1;
          IDX.push(a, b, a + 1, b, b + 1, a + 1);
        }
      base += (segs + 1) * (radial + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(NR, 3));
    g.setAttribute("aBark", new THREE.Float32BufferAttribute(BK, 2));
    g.setAttribute("aLevel", new THREE.Float32BufferAttribute(LV, 1));
    g.setAttribute("aSeed", new THREE.Float32BufferAttribute(SD, 1));
    g.setIndex(IDX);
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        ...lightUniforms,
        uTime: U.uTime,
        uBark: { value: C("#231820") },
        uVein: { value: veinColor },
        uVeinGain: { value: 4 },
        uMotion: { value: reduced ? 0.3 : 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aBark;
        attribute float aLevel;
        attribute float aSeed;
        varying vec2 vBark;
        varying float vLevel;
        varying float vSeed;
        varying vec3 vN;
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vBark = aBark; vLevel = aLevel; vSeed = aSeed; vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform float uTime;
        uniform vec3 uBark;
        uniform vec3 uVein;
        uniform float uVeinGain;
        uniform float uMotion;
        varying vec2 vBark;
        varying float vLevel;
        varying float vSeed;
        varying vec3 vN;
        varying vec3 vWorld;
        float lineDist(float x) { return abs(fract(x + 0.5) - 0.5); }
        float lineMask(float x, float hw) {
          float d = lineDist(x);
          float aa = max(fwidth(x), 1e-4) * 0.85;
          return 1.0 - smoothstep(hw - aa, hw + aa, d);
        }
        void main() {
          vec2 b = vBark;
          float lv = clamp(vLevel, 0.0, 3.0);
          float k = mix(0.5, 0.12, clamp(lv, 0.0, 1.0));
          float w1 = (vnoise(b * vec2(0.9, 0.33) + vSeed * 13.0) - 0.5) * 0.75;
          float w2 = (vnoise(b * vec2(0.7, 0.27) + vSeed * 7.0 + 20.0) - 0.5) * 0.75;
          float A = b.x + b.y * k + w1;
          float B = b.x - b.y * k * 1.15 + w2 + 0.5;
          float hw = mix(0.027, 0.055, lv / 3.0);
          float la = lineMask(A, hw) * smoothstep(0.28, 0.5, vnoise(vec2(floor(A + 0.5) * 3.1, b.y * 0.33) + vSeed * 5.0));
          float lb = lineMask(B, hw * 0.8) * smoothstep(0.42, 0.62, vnoise(vec2(floor(B + 0.5) * 2.3, b.y * 0.3) + vSeed * 9.0));
          lb *= lv < 0.5 ? 1.0 : 0.5;
          float vein = max(la, lb);
          float soft = max(exp(-pow(lineDist(A) / (hw * 3.5), 2.0)) * step(0.001, la + 0.2), exp(-pow(lineDist(B) / (hw * 3.0), 2.0)) * (lv < 0.5 ? 0.8 : 0.3)) * 0.5;
          float pulse = pow(0.5 + 0.5 * sin(b.y * 0.85 - uTime * uMotion * 1.6 + floor(A + 0.5) * 2.1), 6.0);
          float ridges = vnoise(vec2(b.x * 3.4, b.y * 0.9) + vSeed) * 0.6 + vnoise(vec2(b.x * 9.0, b.y * 2.7)) * 0.4;
          vec3 n = normalize(vN);
          vec3 bark = uBark * (0.45 + 0.75 * ridges);
          vec3 col = lightIt(bark, n, vWorld) * 0.85;
          vec3 V = normalize(cameraPosition - vWorld);
          col += uSunColor * bark * pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.9;
          float gain = uVeinGain * (lv > 2.5 ? 0.6 : 1.0);
          col += uVein * vein * gain * (0.8 + 1.3 * pulse);
          col += uVein * soft * gain * 0.028 * (0.6 + pulse);
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    tree.add(new THREE.Mesh(g, m));
    U.barkMat = m;
  }
  await pause();

  /* ---------------------------------------------------------- foliage */
  progress(0.58, "Blooming the canopy");
  function foliageMaterial(blossom) {
    return new THREE.ShaderMaterial({
      uniforms: { ...skyUniforms, ...lightUniforms, uTime: U.uTime, uMotion: { value: reduced ? 0.3 : 1 }, uGain: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aTip;
        attribute vec3 aColor;
        attribute float aPhase;
        uniform float uTime;
        uniform float uMotion;
        varying vec3 vColor;
        varying float vTip;
        varying vec3 vN;
        varying vec3 vWorld;
        void main() {
          ${INST}
          vec3 p = position;
          float t = uTime * uMotion;
          float fl = sin(t * 2.1 + aPhase) * 0.6 + sin(t * 3.7 + aPhase * 2.0) * 0.3;
          p.z += fl * 0.07 * aTip;
          vec4 wp = modelMatrix * instM * vec4(p, 1.0);
          vN = normalize(mat3(modelMatrix * instM) * normal);
          vColor = aColor; vTip = aTip; vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform float uGain;
        varying vec3 vColor;
        varying float vTip;
        varying vec3 vN;
        varying vec3 vWorld;
        void main() {
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          vec3 V = normalize(vWorld - cameraPosition);
          float trans = pow(max(dot(V, uSunDir), 0.0), 4.0);
          vec3 col;
          ${
            blossom
              ? `float glow = smoothstep(0.3, 1.0, vTip);
          col = lightIt(vColor, n, vWorld) * 0.75 + vColor * (0.08 + 0.45 * glow) * uGain;
          col = mix(uGlowColor * 1.8 * uGain, col, smoothstep(0.0, 0.4, vTip));`
              : `col = lightIt(vColor, n, vWorld) * (0.8 + 0.35 * vTip);
          col += vColor * uSunColor * trans * 0.9 + vColor * 0.05;`
          }
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
  }
  const blobShape = (dir, seed) => 1 + (N.noise3(dir.x * 1.6 + seed, dir.y * 1.6, dir.z * 1.6 - seed) - 0.5) * 0.55;
  {
    // blob masses
    const geos = [];
    const base = weldVertices(new THREE.IcosahedronGeometry(1, 4));
    const posA = base.attributes.position;
    for (let ci = 0; ci < clumps.length; ci++) {
      const cl = clumps[ci];
      cl.seed = R() * 50;
      const g = new THREE.BufferGeometry();
      g.setIndex(base.index.clone());
      const arr = new Float32Array(posA.count * 3);
      const d = V3();
      for (let i = 0; i < posA.count; i++) {
        d.fromBufferAttribute(posA, i).normalize();
        const s = blobShape(d, cl.seed) * cl.r * 0.9;
        let y = d.y * s;
        if (y < 0) y *= 0.72;
        arr[i * 3] = cl.c.x + d.x * s;
        arr[i * 3 + 1] = cl.c.y + y;
        arr[i * 3 + 2] = cl.c.z + d.z * s;
      }
      g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      geos.push(g);
    }
    base.dispose();
    const g = mergeGeometries(geos);
    geos.forEach((x) => x.dispose());
    g.computeVertexNormals();
    const m = new THREE.ShaderMaterial({
      uniforms: { ...skyUniforms, ...lightUniforms, uFol: { value: C("#c26a2e") }, uFol2: { value: C("#e08f3e") } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform vec3 uFol;
        uniform vec3 uFol2;
        varying vec3 vWorld;
        varying vec3 vN;
        void main() {
          vec3 n = normalize(vN);
          float h = vnoise3(vWorld * 0.9) * 0.7 + vnoise3(vWorld * 3.1) * 0.3;
          vec3 base = mix(uFol, uFol2, h) * 0.95;
          vec3 col = lightIt(base, n, vWorld);
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    tree.add(new THREE.Mesh(g, m));
  }
  {
    // leaves + blossoms scattered over the blobs
    const leafGeo = leafGeometry();
    const blossomGeo = blossomGeometry();
    const leafPal = [C("#b39a44"), C("#cfa64c"), C("#8f7c36"), C("#e0903e"), C("#ecb45c"), C("#b9623a"), C("#e98aa6"), C("#f2c577"), C("#a3883a"), accent2.clone().lerp(C("#f2c577"), 0.5)];
    const blossomPal = [C("#ffb3cc"), C("#ffd9e6"), C("#ff94b8"), C("#ffc9a3"), accent2.clone().lerp(C("#ffd9e6"), 0.35)];
    const leafK = 60 * Q,
      blossomK = 7.5 * Q;
    let nLeaves = 0,
      nBlossoms = 0;
    for (const cl of clumps) {
      cl.nl = Math.round(leafK * cl.r * cl.r);
      cl.nb = Math.round(blossomK * cl.r * cl.r);
      nLeaves += cl.nl;
      nBlossoms += cl.nb;
    }
    const leafCol = new Float32Array(nLeaves * 3),
      leafPh = new Float32Array(nLeaves);
    const blCol = new Float32Array(nBlossoms * 3),
      blPh = new Float32Array(nBlossoms);
    const leafMat = foliageMaterial(false);
    const blMat = foliageMaterial(true);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, nLeaves);
    const blossoms = new THREE.InstancedMesh(blossomGeo, blMat, nBlossoms);
    const mm = new THREE.Matrix4();
    const d = V3(),
      nn = V3(),
      tt = V3(),
      bb = V3(),
      p = V3();
    let li = 0,
      bi = 0;
    const place = (cl, outward, jitter) => {
      // random direction, mostly on the upper/outer side of the blob
      for (let tries = 0; tries < 6; tries++) {
        d.set(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1);
        if (d.lengthSq() > 1 || d.lengthSq() < 0.01) continue;
        d.normalize();
        if (d.y < -0.3 && R() < 0.55) continue;
        break;
      }
      const rf = outward + (R() - 0.3) * jitter;
      const s = blobShape(d, cl.seed) * cl.r * 0.9 * rf;
      let y = d.y * s;
      if (y < 0) y *= 0.72;
      p.set(cl.c.x + d.x * s, cl.c.y + y, cl.c.z + d.z * s);
      nn.copy(d).add(V3(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(1.1)).normalize();
      tt.set(R() - 0.5, R() - 0.5, R() - 0.5).cross(nn).normalize();
      bb.crossVectors(nn, tt);
      // cheap ambient occlusion: undersides and leaves tucked inside the blob are darker
      return (0.52 + 0.55 * (d.y * 0.5 + 0.5)) * (0.7 + 0.3 * clamp((rf - 0.9) / 0.25, 0, 1));
    };
    for (const cl of clumps) {
      for (let k = 0; k < cl.nl; k++) {
        const ao = place(cl, 1.0, 0.22);
        const sc = 0.85 + R() * 0.7;
        mm.makeBasis(bb.clone().multiplyScalar(sc), tt.clone().multiplyScalar(sc), nn.clone().multiplyScalar(sc));
        mm.setPosition(p);
        leaves.setMatrixAt(li, mm);
        const c = leafPal[Math.floor(R() * leafPal.length)].clone().multiplyScalar((0.75 + R() * 0.45) * ao);
        leafCol.set([c.r, c.g, c.b], li * 3);
        leafPh[li] = R() * TAU;
        li++;
      }
      for (let k = 0; k < cl.nb; k++) {
        place(cl, 1.06, 0.12);
        const sc = 0.8 + R() * 0.7;
        mm.makeBasis(bb.clone().multiplyScalar(sc), tt.clone().multiplyScalar(sc), nn.clone().multiplyScalar(sc));
        mm.setPosition(p);
        blossoms.setMatrixAt(bi, mm);
        const c = blossomPal[Math.floor(R() * blossomPal.length)];
        blCol.set([c.r, c.g, c.b], bi * 3);
        blPh[bi] = R() * TAU;
        bi++;
      }
    }
    leafGeo.setAttribute("aColor", new THREE.InstancedBufferAttribute(leafCol, 3));
    leafGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(leafPh, 1));
    blossomGeo.setAttribute("aColor", new THREE.InstancedBufferAttribute(blCol, 3));
    blossomGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(blPh, 1));
    leaves.frustumCulled = false;
    blossoms.frustumCulled = false;
    tree.add(leaves, blossoms);
    U.blossomMat = blMat;
  }
  await pause();

  /* ------------------------------------------------------------ hives */
  progress(0.68, "Filling the hives");
  const hives = [];
  {
    const g = hiveGeometry();
    const m = new THREE.ShaderMaterial({
      uniforms: {
        ...skyUniforms,
        ...lightUniforms,
        uTime: U.uTime,
        uHoney: { value: accent.clone().lerp(C("#ff9d2e"), 0.35) },
        uWax: { value: C("#5a2a10") },
        uShell: { value: C("#d96f2a") },
        uStalk: { value: C("#231820") },
        uHoneyGain: { value: 1 },
        uMotion: { value: reduced ? 0.3 : 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aPart;
        varying vec2 vUv;
        varying float vPart;
        varying vec3 vN;
        varying vec3 vWorld;
        varying vec3 vLocal;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vUv = uv; vPart = aPart; vWorld = wp.xyz; vLocal = position;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader:
        GLSL_NOISE +
        SKY_GLSL +
        LIGHT_GLSL +
        /* glsl */ `
        uniform float uTime;
        uniform float uMotion;
        uniform vec3 uHoney;
        uniform vec3 uWax;
        uniform vec3 uShell;
        uniform vec3 uStalk;
        uniform float uHoneyGain;
        varying vec2 vUv;
        varying float vPart;
        varying vec3 vN;
        varying vec3 vWorld;
        varying vec3 vLocal;
        vec4 hexCell(vec2 p) {
          const vec2 s = vec2(1.0, 1.7320508);
          vec4 hC = floor(vec4(p, p - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
          vec4 h = vec4(p - hC.xy * s, p - (hC.zw + 0.5) * s);
          return dot(h.xy, h.xy) < dot(h.zw, h.zw) ? vec4(h.xy, hC.xy) : vec4(h.zw, hC.zw + 0.5);
        }
        float hexDist(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }
        void main() {
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          vec3 col;
          if (vPart < 0.5) {
            vec4 hx = hexCell(vec2(vUv.x * 30.0, vUv.y * 17.0));
            float d = hexDist(hx.xy);
            float id = hash12(hx.zw + 3.7);
            float filled = step(0.16, id);
            float flick = 0.72 + 0.28 * sin(uTime * uMotion * (0.6 + id * 1.4) + id * 50.0);
            float wall = smoothstep(0.33, 0.43, d);
            float depth = 1.0 - 0.6 * smoothstep(0.0, 0.42, d);
            float pole = smoothstep(0.02, 0.12, vUv.y) * smoothstep(0.99, 0.9, vUv.y);
            vec3 cell = uHoney * filled * flick * depth * (0.8 + 2.2 * id) * uHoneyGain * pole;
            vec3 wax = lightIt(uWax, n, vWorld) + uHoney * 0.08;
            col = mix(cell + uHoney * 0.05, wax, wall);
          } else if (vPart < 1.5) {
            col = lightIt(uShell, n, vWorld) * 1.1 + uShell * 0.22;
          } else {
            col = lightIt(uStalk, n, vWorld);
          }
          col = fogIt(col, vWorld);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    U.hiveMat = m;
    // hang hives under the low limbs (and one higher limb)
    const spots = [
      [0, 0.42],
      [1, 0.4],
      [0, 0.72],
      [2, 0.5],
      [1, 0.7],
      [3, 0.36],
      [5, 0.4],
    ];
    for (let hi = 0; hi < spots.length; hi++) {
      const [li, t] = spots[hi];
      const limb = limbs[li];
      const p = limb.curve.getPointAt(t);
      const r = limb.rFn(t);
      const hive = new THREE.Mesh(g, m);
      const sc = 0.95 + R() * 0.3;
      hive.scale.setScalar(sc);
      hive.position.set(p.x, p.y - r * 0.6, p.z);
      // entrance faces away from the trunk
      const out = V3(p.x, 0, p.z).normalize();
      hive.rotation.y = Math.atan2(out.x, out.z);
      hive.userData.entrance = V3(0, -1.85, 0.98); // local, on the belly facing +z
      hive.userData.normal = V3(0, -0.15, 1).normalize();
      tree.add(hive);
      hives.push(hive);
    }
  }
  await pause();

  /* --------------------------------------------------- bulbs + motes */
  progress(0.76, "Stringing the lights");
  let bulbs;
  {
    const pts = [];
    // strands along the low limbs (sagging)
    for (const li of [0, 1, 2]) {
      const limb = limbs[li];
      const n = 12;
      const sag = 0.9 + R() * 0.5;
      for (let k = 0; k < n; k++) {
        const t = 0.12 + (k / (n - 1)) * 0.78;
        const p = limb.curve.getPointAt(t).clone();
        const seg = (k % 4) / 3;
        p.y -= limb.rFn(t) + 0.15 + sag * 4 * seg * (1 - seg);
        pts.push(p);
      }
    }
    // around the canopy edges
    for (const cl of clumps) {
      const n = Math.round(R() * 2.2);
      for (let k = 0; k < n; k++) {
        const a = R() * TAU;
        const el = -0.95 + R() * 0.75;
        const d = V3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
        pts.push(cl.c.clone().addScaledVector(d, cl.r * (1.0 + R() * 0.25)));
      }
    }
    for (let i = pts.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1));
      [pts[i], pts[j]] = [pts[j], pts[i]];
    }
    const g = new THREE.IcosahedronGeometry(0.1, 1);
    const ph = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i++) ph[i] = R() * 100;
    g.setAttribute("aPhase", new THREE.InstancedBufferAttribute(ph, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uColor: { value: warmWhite.clone().lerp(accent, 0.3) }, uGain: { value: 1 }, uMotion: { value: reduced ? 0.3 : 1 } },
      vertexShader:
        /* glsl */ `
        attribute float aPhase;
        varying float vPhase;
        void main() {
          ${INST}
          vPhase = aPhase;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instM * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uGain;
        uniform float uMotion;
        varying float vPhase;
        void main() {
          float tw = 0.65 + 0.35 * sin(uTime * uMotion * (0.8 + fract(vPhase * 7.1) * 2.4) + vPhase);
          gl_FragColor = vec4(uColor * (3.5 + 4.5 * tw) * uGain, 1.0);
        }`,
    });
    bulbs = new THREE.InstancedMesh(g, m, pts.length);
    const mm = new THREE.Matrix4();
    pts.forEach((p, i) => {
      mm.makeScale(1, 1, 1).setPosition(p);
      bulbs.setMatrixAt(i, mm);
    });
    bulbs.frustumCulled = false;
    bulbs.userData.total = pts.length;
    tree.add(bulbs);

    // golden pollen around the canopy and trunk
    const motes = makeFloaters({
      count: Math.round(420 * Q),
      place: () => {
        if (R() < 0.35) return V3((R() - 0.5) * 6, 1 + R() * 11, (R() - 0.5) * 6);
        const a = R() * TAU,
          el = -0.5 + R() * 1.2;
        return crownC.clone().add(V3(Math.cos(a) * Math.cos(el) * crownR.x * 1.25, Math.sin(el) * crownR.y * 1.4, Math.sin(a) * Math.cos(el) * crownR.z * 1.25));
      },
      colA: accent.clone().lerp(warmWhite, 0.4),
      colB: C("#ffe9b0"),
      size: 0.09,
      intensity: 3.5,
      speed: 0.25,
      radius: 1.8,
      blink: 0.6,
    });
    tree.add(motes);

    // soft light column under the canopy
    const cg = new THREE.CylinderGeometry(5.5, 8.5, 15, 40, 1, true);
    const cm = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: accent.clone().lerp(warmWhite, 0.5) }, uGain: { value: 0.05 } },
      vertexShader: /* glsl */ `
        varying vec3 vN;
        varying vec3 vWorld;
        varying float vY;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vWorld = wp.xyz;
          vY = uv.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uGain;
        varying vec3 vN;
        varying vec3 vWorld;
        varying float vY;
        void main() {
          vec3 V = normalize(cameraPosition - vWorld);
          float facing = pow(abs(dot(normalize(vN), V)), 2.5);
          float k = facing * smoothstep(0.0, 0.35, vY) * smoothstep(1.0, 0.55, vY);
          gl_FragColor = vec4(uColor * k * uGain, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(cg, cm);
    cone.position.set(0, 7.5, 0);
    cone.renderOrder = 3;
    tree.add(cone);
  }
  await pause();

  /* ------------------------------------------------------------- bees */
  progress(0.84, "Hatching the bees");
  const MAX = maxCreatures;
  const beeGeo = beeGeometry();
  const wingGeo = wingGeometry();
  const bodyColor = new Float32Array(MAX * 3);
  const bodyGlow = new Float32Array(MAX);
  const wingPhase = new Float32Array(MAX);
  const aBodyColor = new THREE.InstancedBufferAttribute(bodyColor, 3).setUsage(THREE.DynamicDrawUsage);
  const aBodyGlow = new THREE.InstancedBufferAttribute(bodyGlow, 1).setUsage(THREE.DynamicDrawUsage);
  const aWingPhase = new THREE.InstancedBufferAttribute(wingPhase, 1).setUsage(THREE.DynamicDrawUsage);
  beeGeo.setAttribute("aColor", aBodyColor);
  beeGeo.setAttribute("aGlow", aBodyGlow);
  wingGeo.setAttribute("aPhase", aWingPhase);
  const beeMat = new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms, uDark: { value: C("#1a1109") } },
    vertexShader:
      /* glsl */ `
      attribute float aPart;
      attribute vec3 aColor;
      attribute float aGlow;
      varying float vPart;
      varying vec3 vColor;
      varying float vGlow;
      varying vec3 vN;
      varying vec3 vLocal;
      varying vec3 vWorld;
      void main() {
        ${INST}
        vec4 wp = modelMatrix * instM * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix * instM) * normal);
        vPart = aPart; vColor = aColor; vGlow = aGlow; vLocal = position; vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader:
      LIGHT_GLSL +
      /* glsl */ `
      uniform vec3 uDark;
      varying float vPart;
      varying vec3 vColor;
      varying float vGlow;
      varying vec3 vN;
      varying vec3 vLocal;
      varying vec3 vWorld;
      void main() {
        vec3 n = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(n, V), 0.0), 2.0);
        vec3 body;
        if (vPart < 0.5) {
          float s = smoothstep(0.42, 0.58, fract(vLocal.z * 2.4 + 0.1));
          body = mix(vColor, uDark, s);
        } else if (vPart < 1.5) {
          body = vColor * 0.75;
        } else {
          body = uDark;
        }
        vec3 col = lightIt(body, n, vWorld) * 2.2 + body * 0.25 + vColor * fres * 0.7 + vColor * vGlow * 0.9;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const wingMat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uColor: { value: C("#fff3dc") }, uFlap: { value: reduced ? 16 : 44 } },
    vertexShader:
      /* glsl */ `
      attribute float aSide;
      attribute float aW;
      attribute float aPhase;
      uniform float uTime;
      uniform float uFlap;
      varying float vW;
      void main() {
        ${INST}
        vec3 p = position;
        p.y -= 0.3;
        float a = aSide * (0.25 + 0.6 * sin(uTime * uFlap + aPhase));
        float c = cos(a), s = sin(a);
        p.xy = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
        p.y += 0.3;
        vW = aW;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instM * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vW;
      void main() {
        float a = 0.28 + 0.4 * smoothstep(0.6, 1.0, vW);
        gl_FragColor = vec4(uColor * 1.4, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const bodies = new THREE.InstancedMesh(beeGeo, beeMat, MAX);
  const wings = new THREE.InstancedMesh(wingGeo, wingMat, MAX);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.frustumCulled = wings.frustumCulled = false;
  bodies.count = wings.count = 0;
  wings.renderOrder = 7;
  scene.add(bodies, wings);
  const trails = new Trails({ max: MAX, len: 16, minStep: 0.16, intensity: 2.4 });
  const halos = new Halos({ max: MAX, px, intensity: 2.2, nearFade: [1.8, 9] });
  scene.add(trails.mesh, halos.points);
  for (let i = 0; i < MAX; i++) halos.hide(i);
  await pause();

  /* -------------------------------------------------- creature logic */
  const slots = new Array(MAX).fill(null);
  const byId = new Map();
  const order = [];
  const BASE = 0.22;
  const buyCol = accent.clone().lerp(C("#ffd27a"), 0.25);
  const sellCol = downCol.clone();
  let selectedId = null;
  let growth = 0.5,
    growthTarget = 0.5;
  const speedK = reduced ? 0.45 : 1;
  const _to = V3(),
    _m = new THREE.Matrix4(),
    _s = V3(),
    _zero = V3(),
    _up = V3(0, 1, 0),
    _f = V3();
  const api = { onRemove: null };

  function visibleHives() {
    return hives.filter((h) => h.visible);
  }
  function hiveEntrance(h, out, nrm) {
    h.updateWorldMatrix(true, false);
    out.copy(h.userData.entrance).applyMatrix4(h.matrixWorld);
    if (nrm) nrm.copy(h.userData.normal).transformDirection(h.matrixWorld);
    return out;
  }
  const treeScale = () => tree.scale.x;

  function pickTarget(c) {
    const s = treeScale();
    const r = R();
    if (r < 0.62 && flowerHeads.length) {
      const f = flowerHeads[Math.floor(R() * flowerHeads.length)];
      c.target.copy(f).add(_to.set((R() - 0.5) * 0.3, 0.45, (R() - 0.5) * 0.3));
      c.hoverAt = true;
    } else if (r < 0.86) {
      const a = R() * TAU,
        el = -0.2 + R() * 0.9;
      c.target.set(Math.cos(a) * Math.cos(el) * (crownR.x + 3), crownC.y + Math.sin(el) * (crownR.y + 3), Math.sin(a) * Math.cos(el) * (crownR.z + 3)).multiplyScalar(s);
      c.hoverAt = false;
    } else {
      const a = R() * TAU,
        rr = 8 + R() * 26;
      c.target.set(Math.cos(a) * rr, 1.5 + R() * 4, Math.sin(a) * rr);
      c.hoverAt = false;
    }
  }

  function steer(c, target, speed, dt, t, wander = 0.9) {
    _to.subVectors(target, c.pos);
    const d = _to.length();
    const want = speed * Math.min(1, d / 2.2 + 0.15);
    _to.multiplyScalar(want / Math.max(d, 1e-3));
    _to.x += Math.sin(t * 1.9 + c.phase) * wander;
    _to.y += Math.sin(t * 2.6 + c.phase * 1.3) * wander * 0.45;
    _to.z += Math.cos(t * 1.6 + c.phase * 0.7) * wander;
    c.vel.lerp(_to, damp(2.4, dt));
    c.pos.addScaledVector(c.vel, dt);
    return d;
  }

  function avoid(c) {
    const s = treeScale();
    const h = Math.hypot(c.pos.x, c.pos.z);
    const tr = 2.2 * s + 0.7;
    if (c.pos.y < 12.5 * s && h < tr && c.state !== "enter") {
      const k = tr / Math.max(h, 1e-3);
      c.pos.x *= k;
      c.pos.z *= k;
    }
    const gy = groundY(c.pos.x, c.pos.z) + 0.3;
    if (c.pos.y < gy) {
      c.pos.y = gy;
      if (c.vel.y < 0) c.vel.y *= -0.3;
    }
  }

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

  function step(c, dt, t) {
    c.age += dt;
    c.t += dt;
    const sp = c.speed * speedK;
    switch (c.state) {
      case "emerge": {
        c.pos.addScaledVector(c.vel, dt);
        c.vel.multiplyScalar(Math.max(0, 1 - dt * 0.9));
        c.vel.y -= dt * 0.6;
        c.grow = Math.min(1, c.t / 0.7);
        if (c.t > 0.9) {
          c.state = c.side === "sell" ? "flee" : "fly";
          c.t = 0;
          if (c.state === "fly") pickTarget(c);
        }
        break;
      }
      case "fly": {
        const d = steer(c, c.target, sp, dt, t, 0.9);
        avoid(c);
        if (d < 0.5) {
          c.state = "hover";
          c.t = 0;
          c.hoverFor = c.hoverAt ? 1.4 + R() * 3 : 0.3 + R() * 0.6;
          c.anchor = c.target.clone();
        }
        if (c.age > c.life) goHome(c);
        break;
      }
      case "hover": {
        const k = c.t * 5 + c.phase;
        _to.set(Math.sin(k) * 0.16, Math.sin(k * 2) * 0.06, Math.cos(k * 0.8) * 0.16).add(c.anchor);
        c.vel.lerp(_to.sub(c.pos).multiplyScalar(4), damp(6, dt));
        c.pos.addScaledVector(c.vel, dt);
        if (c.t > c.hoverFor) {
          c.state = "fly";
          c.t = 0;
          pickTarget(c);
        }
        if (c.age > c.life) goHome(c);
        break;
      }
      case "home": {
        hiveEntrance(c.hive, c.target);
        const d = steer(c, c.target, sp * 1.1, dt, t, 0.35);
        if (d < 0.35 || c.t > 40) {
          c.state = "enter";
          c.t = 0;
        }
        break;
      }
      case "enter": {
        hiveEntrance(c.hive, c.target);
        c.pos.lerp(c.target, damp(6, dt));
        c.grow = Math.max(0, 1 - c.t / 0.5);
        if (c.t > 0.5) kill(c);
        break;
      }
      case "flee": {
        const acc = Math.min(1, c.t / 6);
        steer(c, c.target, sp * (1 + acc * 2.2), dt, t, 0.5);
        avoid(c);
        const far = c.pos.length();
        c.grow = far > 110 ? Math.max(0, 1 - (far - 110) / 40) : 1;
        if (far > 150 || c.age > 45) kill(c);
        break;
      }
    }
  }

  function goHome(c) {
    const vh = visibleHives();
    c.hive = c.hive && c.hive.visible ? c.hive : vh[Math.floor(R() * vh.length)] || hives[0];
    c.state = "home";
    c.t = 0;
  }

  api.spawn = (trade, { age = 0 } = {}) => {
    if (byId.has(trade.id)) return byId.get(trade.id);
    let slot = slots.indexOf(null);
    if (slot < 0) {
      kill(order[0]);
      slot = slots.indexOf(null);
    }
    const vh = visibleHives();
    const hive = vh[Math.floor(R() * vh.length)] || hives[0];
    const c = {
      id: trade.id,
      trade,
      slot,
      side: trade.side,
      size: sizeForUsd(trade.usd),
      pos: V3(),
      vel: V3(),
      fwd: V3(0, 0, 1),
      target: V3(),
      anchor: null,
      hive,
      state: "emerge",
      t: 0,
      age: 0,
      grow: 0,
      life: 70 + R() * 80,
      phase: R() * TAU,
      speed: 3.1 + R() * 1.7,
      alive: true,
      born: performance.now(),
    };
    const nrm = V3();
    hiveEntrance(hive, c.pos, nrm);
    c.vel.copy(nrm).multiplyScalar(2.6);
    if (c.side === "sell") {
      const a = Math.atan2(c.pos.z, c.pos.x) + (R() - 0.5) * 1.2;
      c.target.set(Math.cos(a) * 240, 30 + R() * 45, Math.sin(a) * 240);
      c.speed = 3.5 + R() * 1.5;
    }
    slots[slot] = c;
    byId.set(c.id, c);
    order.push(c);
    const col = c.side === "sell" ? sellCol : buyCol;
    trails.reset(slot, c.pos, col, 0.075 * c.size);
    if (age > 0) {
      const stepDt = 1 / 20;
      const steps = Math.min(Math.round(Math.min(age, 45) / stepDt), 900);
      let tt = 0;
      for (let i = 0; i < steps && c.alive; i++) {
        tt += stepDt;
        step(c, stepDt, tt + c.phase * 10);
        trails.push(slot, c.pos);
      }
      c.born -= age * 1000;
    }
    return c.alive ? c : null;
  };

  api.get = (id) => byId.get(id) || null;
  api.list = () => order;
  api.newest = () => {
    for (let i = order.length - 1; i >= 0; i--) {
      const c = order[i];
      if (c.alive && c.state !== "enter") return c;
    }
    return null;
  };
  api.select = (id) => {
    selectedId = id;
  };
  api.release = (filter) => {
    for (const c of order.slice()) {
      if (!filter(c)) continue;
      if (c.side === "buy") {
        c.life = 0;
        if (c.state === "fly" || c.state === "hover") goHome(c);
      }
    }
  };
  api.setGrowth = (g, immediate) => {
    growthTarget = clamp(g, 0, 1);
    if (immediate) growth = growthTarget;
  };

  function applyGrowth() {
    const s = lerp(0.52, 1.0, growth);
    tree.scale.setScalar(s);
    U.uTreeCenter.value.set(0, 8.5 * s, 0);
    U.uTreeGlowR.value = 15 * s;
    U.uTreeGlow.value = lerp(0.55, 1.15, growth);
    U.barkMat.uniforms.uVeinGain.value = lerp(2.0, 3.9, growth);
    U.hiveMat.uniforms.uHoneyGain.value = lerp(0.75, 1.25, growth);
    U.blossomMat.uniforms.uGain.value = lerp(0.55, 1.2, growth);
    const nh = 4 + Math.round(3 * growth);
    hives.forEach((h, i) => (h.visible = i < nh));
    bulbs.count = Math.round(bulbs.userData.total * (0.4 + 0.6 * growth));
  }
  applyGrowth();

  /** Home camera view for the current tree size. */
  api.view = (aspect = 16 / 9) => {
    const s = lerp(0.52, 1.0, growthTarget);
    const target = V3(0, 10.2 * s + 0.6, 0);
    // portrait screens: step back so most of the canopy fits the width
    const dist = (34 * s + 10) * Math.min(1.8, Math.max(1, 0.72 / Math.max(aspect, 0.2)));
    const az = THREE.MathUtils.degToRad(-8);
    const el = THREE.MathUtils.degToRad(7);
    const pos = V3(Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    return {
      pos,
      target,
      fov: 42,
      limits: { minDistance: 6, maxDistance: 130, minPolar: 0.25, maxPolar: 1.52, flyRadius: 230, flyMinY: 0.7, flyMaxY: 120, flySpeed: 11 },
      autoRotateSpeed: 0.28,
      constrain: (p) => {
        // keep the camera out of the trunk and above the grass
        const s = tree.scale.x;
        const h = Math.hypot(p.x, p.z);
        const tr = 3.6 * s + 0.8;
        if (p.y < 13.5 * s && h < tr) {
          const k = tr / Math.max(h, 1e-3);
          p.x *= k;
          p.z *= k;
        }
        const gy = groundY(p.x, p.z) + 0.55;
        if (p.y < gy) p.y = gy;
      },
    };
  };
  api.describe = (c) =>
    c.side === "sell" ? "Leaving the valley" : c.state === "emerge" ? "Leaving the hive" : c.state === "home" || c.state === "enter" ? "Flying home" : c.state === "hover" && c.hoverAt ? "On a flower" : "Foraging";
  api.goneText = (t) => (t.side === "sell" ? "Left the valley" : "Back in the hive");
  api.followDistance = 2.4;
  api.look = { bloom: { strength: 0.8, radius: 0.55, threshold: 0.95 }, exposure: 0.66, clear: 0x000000 };
  api.scene = scene;

  const _col = new THREE.Color();
  api.update = (dt, t, camera) => {
    U.uTime.value = t;
    skyGroup.position.copy(camera.position);
    if (Math.abs(growthTarget - growth) > 1e-4) {
      growth += (growthTarget - growth) * damp(0.9, dt);
      applyGrowth();
    }
    let n = 0;
    for (let i = 0; i < order.length; i++) {
      const c = order[i];
      step(c, dt, t);
      if (!c.alive) {
        i--;
        continue;
      }
    }
    for (const c of order) {
      // orientation + bob
      if (c.vel.lengthSq() > 1e-4) {
        _f.copy(c.vel).normalize();
        c.fwd.lerp(_f, damp(7, dt)).normalize();
      }
      const sel = c.id === selectedId;
      const sc = BASE * c.size * c.grow * (sel ? 1.25 : 1);
      _m.lookAt(c.fwd, _zero, _up);
      _m.scale(_s.set(sc, sc, sc));
      _m.setPosition(c.pos.x, c.pos.y + Math.sin(t * 9 + c.phase) * 0.02, c.pos.z);
      bodies.setMatrixAt(n, _m);
      wings.setMatrixAt(n, _m);
      const col = c.side === "sell" ? sellCol : buyCol;
      bodyColor[n * 3] = col.r;
      bodyColor[n * 3 + 1] = col.g;
      bodyColor[n * 3 + 2] = col.b;
      bodyGlow[n] = sel ? 0.8 + 0.4 * Math.sin(t * 6) : 0;
      wingPhase[n] = c.phase;
      n++;
      trails.push(c.slot, c.pos);
      _col.copy(col);
      const hs = (sel ? 2.2 + 0.5 * Math.sin(t * 5) : 1.35) * BASE * 4 * c.size * c.grow;
      halos.set(c.slot, c.pos, _col, hs);
    }
    bodies.count = wings.count = n;
    bodies.instanceMatrix.needsUpdate = true;
    wings.instanceMatrix.needsUpdate = true;
    aBodyColor.needsUpdate = true;
    aBodyGlow.needsUpdate = true;
    aWingPhase.needsUpdate = true;
    trails.flush();
    halos.flush();
  };

  api.dispose = () => {
    trails.dispose();
    halos.dispose();
    disposeTree(scene);
    for (const d of disposables) d.dispose && d.dispose();
    order.length = 0;
    byId.clear();
  };

  progress(0.9, "Almost there");
  return api;
}

/* ================================================================ geometry */


function flowerGeometry() {
  const P = [],
    PART = [],
    TIP = [],
    IDX = [];
  const add = (x, y, z, part, tip) => {
    P.push(x, y, z);
    PART.push(part);
    TIP.push(tip);
    return P.length / 3 - 1;
  };
  const H = 1.0;
  // stem
  const rings = 4,
    sr = 0.024;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = t * H;
    const cx = Math.sin(t * 2.4) * 0.05;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU;
      add(cx + Math.cos(a) * sr * (1 - t * 0.35), y, Math.sin(a) * sr * (1 - t * 0.35), 0, t);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let k = 0; k < 4; k++) {
      const a = i * 4 + k,
        b = i * 4 + ((k + 1) % 4);
      IDX.push(a, a + 4, b, b, a + 4, b + 4);
    }
  // leaves
  const leaf = (y0, ang, len, w) => {
    const dx = Math.cos(ang),
      dz = Math.sin(ang);
    const px = -dz,
      pz = dx;
    const b0 = add(dx * 0.02, y0, dz * 0.02, 1, 0);
    const l = add(dx * len * 0.45 + px * w, y0 + len * 0.28, dz * len * 0.45 + pz * w, 1, 0.5);
    const r = add(dx * len * 0.45 - px * w, y0 + len * 0.28, dz * len * 0.45 - pz * w, 1, 0.5);
    const m = add(dx * len * 0.45, y0 + len * 0.22, dz * len * 0.45, 1, 0.5);
    const tp = add(dx * len, y0 + len * 0.36, dz * len, 1, 1);
    IDX.push(b0, m, l, b0, r, m, m, tp, l, m, r, tp);
  };
  leaf(0.22, 0.4, 0.32, 0.07);
  leaf(0.38, 0.4 + Math.PI, 0.28, 0.06);
  // petals: two whorls, cupped like a lotus
  const whorl = (count, len, width, tilt0, tilt1, rot, lift) => {
    for (let j = 0; j < count; j++) {
      const ang = (j / count) * TAU + rot;
      const dx = Math.cos(ang),
        dz = Math.sin(ang);
      const tx = -dz,
        tz = dx;
      const cols = 3,
        rowsN = 3;
      const start = P.length / 3;
      let rr = 0.04,
        yy = H + lift;
      const path = [];
      for (let s = 0; s <= rowsN; s++) {
        const f = s / rowsN;
        const tilt = tilt0 + (tilt1 - tilt0) * f;
        if (s > 0) {
          rr += (len / rowsN) * Math.cos(tilt);
          yy += (len / rowsN) * Math.sin(tilt);
        }
        path.push([rr, yy, f]);
      }
      for (const [r, y, f] of path) {
        const w = width * Math.pow(Math.sin(Math.PI * Math.min(1, f * 0.92 + 0.08)), 0.75) * (f > 0.98 ? 0.05 : 1);
        for (let c = 0; c < cols; c++) {
          const u = c / (cols - 1) - 0.5;
          const cup = Math.abs(u) * 0.12 * len;
          add(dx * r + tx * u * w * 2, y + cup, dz * r + tz * u * w * 2, 2, f);
        }
      }
      for (let s = 0; s < rowsN; s++)
        for (let c = 0; c < cols - 1; c++) {
          const a = start + s * cols + c;
          IDX.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
        }
    }
  };
  whorl(8, 0.4, 0.13, 0.35, 0.95, 0, 0);
  whorl(6, 0.3, 0.1, 0.85, 1.35, 0.3, 0.02);
  whorl(4, 0.17, 0.07, 1.2, 1.5, 0.9, 0.03);
  // center dome
  const cStart = P.length / 3;
  const top = add(0, H + 0.1, 0, 3, 1);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    add(Math.cos(a) * 0.07, H + 0.03, Math.sin(a) * 0.07, 3, 0.5);
  }
  for (let k = 0; k < 8; k++) IDX.push(top, cStart + 1 + ((k + 1) % 8), cStart + 1 + k);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(PART, 1));
  g.setAttribute("aTip", new THREE.Float32BufferAttribute(TIP, 1));
  g.setIndex(IDX);
  g.computeVertexNormals();
  return g;
}

/** Merge duplicate vertices of a non-indexed geometry (positions only) so normals can be smoothed. */
function weldVertices(geo) {
  const pos = geo.attributes.position;
  const map = new Map();
  const verts = [];
  const idx = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const key = Math.round(x * 1e4) + "," + Math.round(y * 1e4) + "," + Math.round(z * 1e4);
    let j = map.get(key);
    if (j === undefined) {
      j = verts.length / 3;
      map.set(key, j);
      verts.push(x, y, z);
    }
    idx.push(j);
  }
  geo.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  return g;
}

function leafGeometry() {
  // folded diamond leaf in the XY plane (normal +Z), base at the origin
  const l = 0.56,
    w = 0.16;
  const P = [0, 0, 0, -w, l * 0.45, 0.06, 0, l, 0, w, l * 0.45, 0.06, 0, l * 0.45, -0.03];
  const TIP = [0, 0.5, 1, 0.5, 0.5];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("aTip", new THREE.Float32BufferAttribute(TIP, 1));
  g.setIndex([0, 4, 1, 0, 3, 4, 4, 2, 1, 4, 3, 2]);
  g.translate(0, -l * 0.4, 0);
  g.computeVertexNormals();
  return g;
}

function blossomGeometry() {
  const P = [0, 0, 0.04],
    TIP = [0],
    IDX = [];
  const petals = 5,
    r = 0.2;
  for (let k = 0; k < petals; k++) {
    const a = (k / petals) * TAU;
    const a0 = a - 0.42,
      a1 = a + 0.42;
    const i0 = P.length / 3;
    P.push(Math.cos(a0) * r * 0.55, Math.sin(a0) * r * 0.55, 0.03);
    TIP.push(0.6);
    P.push(Math.cos(a) * r, Math.sin(a) * r, 0.07);
    TIP.push(1);
    P.push(Math.cos(a1) * r * 0.55, Math.sin(a1) * r * 0.55, 0.03);
    TIP.push(0.6);
    IDX.push(0, i0, i0 + 1, 0, i0 + 1, i0 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("aTip", new THREE.Float32BufferAttribute(TIP, 1));
  g.setIndex(IDX);
  g.computeVertexNormals();
  return g;
}

function hiveGeometry() {
  const prof = [];
  const Hh = 2.5;
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const r = 0.26 + 0.86 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(t, 0.85) * 1.02)), 0.8) * (1 - 0.1 * t);
    prof.push(new THREE.Vector2(Math.max(r * (t > 0.97 ? (1 - t) * 30 : 1), 0.02), -t * Hh));
  }
  const lathe = new THREE.LatheGeometry(prof, 40);
  tagGeometry(lathe, "aPart", 0);
  const radiusAt = (t) => {
    const i = Math.min(prof.length - 1, Math.round(t * 28));
    return prof[i].x;
  };
  const parts = [lathe];
  for (const t of [0.12, 0.34, 0.58, 0.8]) {
    const tor = new THREE.TorusGeometry(radiusAt(t) + 0.02, 0.055, 6, 40);
    tor.rotateX(Math.PI / 2);
    tor.translate(0, -t * Hh, 0);
    tagGeometry(tor, "aPart", 1);
    parts.push(tor);
  }
  const cap = new THREE.CylinderGeometry(0.34, 0.42, 0.18, 20);
  cap.translate(0, 0.02, 0);
  tagGeometry(cap, "aPart", 1);
  parts.push(cap);
  const stalk = new THREE.CylinderGeometry(0.06, 0.1, 1.0, 8);
  stalk.translate(0, 0.55, 0);
  tagGeometry(stalk, "aPart", 2);
  parts.push(stalk);
  const g = mergeGeometries(parts.map((p) => keepAttributes(p, ["position", "normal", "uv", "aPart"])));
  parts.forEach((p) => p.dispose());
  return g;
}

function beeGeometry() {
  const parts = [];
  const abd = new THREE.SphereGeometry(0.5, 10, 7);
  abd.scale(0.82, 0.8, 1.25);
  abd.translate(0, 0, -0.62);
  tagGeometry(abd, "aPart", 0);
  const tho = new THREE.SphereGeometry(0.4, 8, 6);
  tho.translate(0, 0.02, 0.18);
  tagGeometry(tho, "aPart", 1);
  const head = new THREE.SphereGeometry(0.3, 7, 5);
  head.translate(0, 0.02, 0.7);
  tagGeometry(head, "aPart", 2);
  const sting = new THREE.ConeGeometry(0.08, 0.3, 4);
  sting.rotateX(-Math.PI / 2);
  sting.translate(0, 0, -1.3);
  tagGeometry(sting, "aPart", 2);
  parts.push(abd, tho, head, sting);
  const g = mergeGeometries(parts.map((p) => keepAttributes(p, ["position", "normal", "aPart"])));
  parts.forEach((p) => p.dispose());
  return g;
}

function wingGeometry() {
  const P = [],
    SIDE = [],
    W = [],
    IDX = [];
  for (const side of [-1, 1]) {
    const c0 = P.length / 3;
    P.push(0, 0.3, 0.12);
    SIDE.push(side);
    W.push(0);
    const n = 14;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * TAU;
      const x = 0.62 + Math.cos(a) * 0.62;
      const z = Math.sin(a) * 0.26 - x * 0.28;
      P.push(side * x, 0.3 + x * 0.12, z + 0.12);
      SIDE.push(side);
      W.push(Math.min(1, x / 1.24));
    }
    for (let k = 0; k < n; k++) IDX.push(c0, c0 + 1 + k, c0 + 2 + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("aSide", new THREE.Float32BufferAttribute(SIDE, 1));
  g.setAttribute("aW", new THREE.Float32BufferAttribute(W, 1));
  g.setIndex(IDX);
  return g;
}
