// Shared 3D helpers for the world scenes: GLSL noise, ribbon trails, glow halos, geometry merge,
// CSS color reading and disposal. Imports the vendored three.js.
import * as THREE from "../vendor/three/three.module.min.js";

export { THREE };

/* ------------------------------------------------------------------ GLSL */

export const GLSL_NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), f1 = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise3(p); p = p * 2.02 + vec3(11.3, 7.1, 3.7); a *= 0.5; }
  return s;
}
`;

/* ----------------------------------------------------------- geometry util */

/** Merge BufferGeometries that share the same attribute names (indexed or not). */
export function mergeGeometries(list) {
  const geos = list.map((g) => (g.index ? g : g));
  const names = Object.keys(geos[0].attributes);
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const size = geos[0].attributes[n].itemSize;
    const arr = new Float32Array(vCount * size);
    let o = 0;
    for (const g of geos) {
      const a = g.attributes[n];
      if (!a) throw new Error("mergeGeometries: missing attribute " + n);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < size; k++) arr[o++] = a.getComponent(i, k);
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const IndexArray = vCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArray(iCount);
  let io = 0;
  let base = 0;
  for (const g of geos) {
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + base;
    else for (let i = 0; i < g.attributes.position.count; i++) idx[io++] = i + base;
    base += g.attributes.position.count;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Add a constant float attribute to a geometry (e.g. a "part" id before merging). */
export function tagGeometry(geo, name, value) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n).fill(value);
  geo.setAttribute(name, new THREE.BufferAttribute(arr, 1));
  return geo;
}

/** Keep only the listed attributes (so geometries from different generators can merge). */
export function keepAttributes(geo, names) {
  for (const n of Object.keys(geo.attributes)) if (!names.includes(n)) geo.deleteAttribute(n);
  return geo;
}

/* ------------------------------------------------------------------ colors */

let _ctx = null;
/** Parse any CSS color (hex, rgb, hsl, oklch...) to a THREE.Color, or null. */
export function cssColor(value) {
  if (!value || typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  try {
    if (!_ctx) _ctx = document.createElement("canvas").getContext("2d");
    if (!_ctx) return null;
    _ctx.fillStyle = "#010203";
    _ctx.fillStyle = v;
    const out = _ctx.fillStyle;
    if (out === "#010203" && v.toLowerCase() !== "#010203") return null;
    if (out.startsWith("#")) return new THREE.Color(out);
    const m = out.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
    if (!m) return null;
    if (m[4] !== undefined && +m[4] < 0.2) return null; // mostly transparent: ignore
    return new THREE.Color().setRGB(+m[1] / 255, +m[2] / 255, +m[3] / 255, THREE.SRGBColorSpace);
  } catch {
    return null;
  }
}

export function luminance(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Scene palette from the container's CSS custom properties, with per-scene defaults.
 * Guards keep a theme from breaking the scene: a too-dark accent or a light --bg is ignored.
 */
export function readPalette(el, defaults) {
  const cs = el ? getComputedStyle(el) : null;
  const get = (name) => (cs ? cs.getPropertyValue(name) : "");
  const out = {};
  const pick = (key, cssName, test) => {
    const c = cssColor(get(cssName));
    out[key] = c && (!test || test(c)) ? c : new THREE.Color(defaults[key]);
  };
  pick("accent", "--accent", (c) => luminance(c) > 0.06);
  pick("accent2", "--accent-2", (c) => luminance(c) > 0.03);
  pick("up", "--up", (c) => luminance(c) > 0.04);
  pick("down", "--down", (c) => luminance(c) > 0.03);
  pick("bg", "--bg", (c) => luminance(c) < 0.02);
  return out;
}

/* ------------------------------------------------------------ ribbon trails */

const TRAIL_VERT = /* glsl */ `
attribute vec3 aNext;
attribute float aSide;
attribute float aAge;
attribute vec3 aColor;
attribute float aWidth;
varying vec3 vColor;
varying float vAge;
varying float vSide;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec4 mn = modelViewMatrix * vec4(aNext, 1.0);
  vec2 d = mn.xy / max(-mn.z, 0.01) - mv.xy / max(-mv.z, 0.01);
  float l = length(d);
  d = l > 1e-6 ? d / l : vec2(1.0, 0.0);
  float w = aWidth * mix(1.0, 0.15, aAge);
  mv.xy += vec2(-d.y, d.x) * w * aSide;
  vColor = aColor;
  vAge = aAge;
  vSide = aSide;
  gl_Position = projectionMatrix * mv;
}`;

const TRAIL_FRAG = /* glsl */ `
uniform float uIntensity;
varying vec3 vColor;
varying float vAge;
varying float vSide;
void main() {
  float edge = 1.0 - vSide * vSide;
  float a = pow(1.0 - vAge, 1.7) * edge;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * uIntensity * (0.55 + 0.9 * (1.0 - vAge)), a);
}`;

/**
 * Camera-facing ribbon trails for up to `max` creatures, `len` samples each.
 * Samples are spaced by distance (minStep) so a trail has a steady length at any speed.
 */
export class Trails {
  constructor({ max, len = 18, minStep = 0.12, intensity = 2.2 }) {
    this.max = max;
    this.len = len;
    this.minStep = minStep;
    const nV = max * len * 2;
    this.samples = new Float32Array(max * len * 3);
    this.counts = new Uint16Array(max);
    this.colors = new Float32Array(max * 3);
    this.widths = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(nV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aNext = new THREE.BufferAttribute(new Float32Array(nV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aAge = new THREE.BufferAttribute(new Float32Array(nV), 1);
    this.aColor = new THREE.BufferAttribute(new Float32Array(nV * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aWidth = new THREE.BufferAttribute(new Float32Array(nV), 1).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(nV);
    for (let i = 0; i < nV; i++) side[i] = i % 2 ? 1 : -1;
    for (let s = 0; s < max; s++)
      for (let k = 0; k < len; k++) {
        const v = (s * len + k) * 2;
        this.aAge.array[v] = this.aAge.array[v + 1] = k / (len - 1);
      }
    const idx = new Uint32Array(max * (len - 1) * 6);
    let o = 0;
    for (let s = 0; s < max; s++)
      for (let k = 0; k < len - 1; k++) {
        const v = (s * len + k) * 2;
        idx[o++] = v;
        idx[o++] = v + 1;
        idx[o++] = v + 2;
        idx[o++] = v + 1;
        idx[o++] = v + 3;
        idx[o++] = v + 2;
      }
    g.setAttribute("position", this.aPos);
    g.setAttribute("aNext", this.aNext);
    g.setAttribute("aAge", this.aAge);
    g.setAttribute("aColor", this.aColor);
    g.setAttribute("aWidth", this.aWidth);
    g.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: intensity } },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.geometry = g;
  }

  /** Start a fresh trail at p. */
  reset(slot, p, color, width) {
    const b = slot * this.len * 3;
    this.samples[b] = p.x;
    this.samples[b + 1] = p.y;
    this.samples[b + 2] = p.z;
    this.counts[slot] = 1;
    this.colors[slot * 3] = color.r;
    this.colors[slot * 3 + 1] = color.g;
    this.colors[slot * 3 + 2] = color.b;
    this.widths[slot] = width;
  }

  /** Move the head to p; pushes a new sample once the head moved minStep. */
  push(slot, p) {
    const len = this.len;
    const S = this.samples;
    const b = slot * len * 3;
    let c = this.counts[slot];
    if (c === 0) return;
    // distance from head to the second sample decides whether we shift
    const ref = c > 1 ? b + 3 : b;
    const dx = p.x - S[ref],
      dy = p.y - S[ref + 1],
      dz = p.z - S[ref + 2];
    if (c === 1 || dx * dx + dy * dy + dz * dz > this.minStep * this.minStep) {
      // shift everything back by one and keep the head
      const n = Math.min(c, len - 1);
      S.copyWithin(b + 3, b, b + n * 3);
      c = Math.min(c + 1, len);
      this.counts[slot] = c;
    }
    S[b] = p.x;
    S[b + 1] = p.y;
    S[b + 2] = p.z;
  }

  setColor(slot, color, width) {
    this.colors[slot * 3] = color.r;
    this.colors[slot * 3 + 1] = color.g;
    this.colors[slot * 3 + 2] = color.b;
    if (width !== undefined) this.widths[slot] = width;
  }

  hide(slot) {
    this.counts[slot] = 0;
  }

  /** Write every slot into the GPU buffers (call once per frame). */
  flush() {
    const { len, samples: S, counts } = this;
    const P = this.aPos.array,
      N = this.aNext.array,
      C = this.aColor.array,
      W = this.aWidth.array;
    for (let s = 0; s < this.max; s++) {
      const c = counts[s];
      const b = s * len * 3;
      const vb = s * len * 2;
      const r = this.colors[s * 3],
        g = this.colors[s * 3 + 1],
        bl = this.colors[s * 3 + 2];
      const w = c > 1 ? this.widths[s] : 0;
      for (let k = 0; k < len; k++) {
        const kk = Math.min(k, Math.max(c - 1, 0)) * 3 + b;
        // neighbor toward the tail (or mirrored at the end)
        let nx, ny, nz;
        if (k + 1 < c) {
          nx = S[kk + 3];
          ny = S[kk + 4];
          nz = S[kk + 5];
        } else if (c > 1) {
          const pk = kk - 3;
          nx = 2 * S[kk] - S[pk];
          ny = 2 * S[kk + 1] - S[pk + 1];
          nz = 2 * S[kk + 2] - S[pk + 2];
        } else {
          nx = S[kk] + 0.01;
          ny = S[kk + 1];
          nz = S[kk + 2];
        }
        const ww = k < c ? w : 0;
        for (let e = 0; e < 2; e++) {
          const v = (vb + k * 2 + e) * 3;
          P[v] = S[kk];
          P[v + 1] = S[kk + 1];
          P[v + 2] = S[kk + 2];
          N[v] = nx;
          N[v + 1] = ny;
          N[v + 2] = nz;
          C[v] = r;
          C[v + 1] = g;
          C[v + 2] = bl;
          W[vb + k * 2 + e] = ww;
        }
      }
    }
    this.aPos.needsUpdate = true;
    this.aNext.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aWidth.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------ halos */

const HALO_VERT = /* glsl */ `
uniform float uPx;
uniform vec2 uNearFade;
attribute vec3 aColor;
attribute float aSize;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vColor = aColor;
  // fade out near the camera so a close-up shows the creature itself, not a blob of light
  if (uNearFade.y > 0.0) vColor *= smoothstep(uNearFade.x, uNearFade.y, -mv.z);
  gl_PointSize = clamp(aSize * uPx / max(-mv.z, 0.05), 0.0, 160.0);
  gl_Position = projectionMatrix * mv;
}`;

const HALO_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uFlare;
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  float k = exp(-d * 16.0) * 1.3 + exp(-d * 4.0) * 0.3;
  if (uFlare > 0.0) {
    vec2 a = abs(q);
    k += uFlare * (exp(-a.x * 28.0) * exp(-a.y * 2.4) + exp(-a.y * 28.0) * exp(-a.x * 2.4)) * 0.6 * (1.0 - d);
  }
  gl_FragColor = vec4(vColor * uIntensity * k, 1.0);
}`;

/** Soft additive glow sprites that sit on each creature so it reads from far away. */
export class Halos {
  constructor({ max, px, intensity = 2.0, flare = 0, nearFade = null }) {
    this.max = max;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.aPos);
    g.setAttribute("aColor", this.aColor);
    g.setAttribute("aSize", this.aSize);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPx: px, uIntensity: { value: intensity }, uFlare: { value: flare }, uNearFade: { value: new THREE.Vector2(...(nearFade || [0, 0])) } },
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.geometry = g;
  }
  set(slot, p, color, size) {
    const a = this.aPos.array,
      c = this.aColor.array;
    a[slot * 3] = p.x;
    a[slot * 3 + 1] = p.y;
    a[slot * 3 + 2] = p.z;
    c[slot * 3] = color.r;
    c[slot * 3 + 1] = color.g;
    c[slot * 3 + 2] = color.b;
    this.aSize.array[slot] = size;
  }
  hide(slot) {
    this.aSize.array[slot] = 0;
  }
  flush() {
    this.aPos.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* --------------------------------------------------------------- disposal */

/** Dispose every geometry, material and texture under an object. */
export function disposeTree(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) {
      seen.add(o.geometry);
      o.geometry.dispose();
    }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture && !seen.has(v)) {
          seen.add(v);
          v.dispose();
        }
      }
      if (m.uniforms)
        for (const u of Object.values(m.uniforms)) {
          const v = u && u.value;
          if (v && v.isTexture && !seen.has(v)) {
            seen.add(v);
            v.dispose();
          }
        }
      m.dispose();
    }
    if (o.isInstancedMesh && o.dispose) o.dispose();
  });
}

/* ------------------------------------------------------------------ misc */

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
/** Frame-rate independent exponential approach factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
