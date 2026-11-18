// Renderer, post-processing and camera rig shared by every world scene.
import { THREE, clamp, damp } from "./common.js";
import { OrbitControls } from "../vendor/three/addons/controls/OrbitControls.js";
import { EffectComposer } from "../vendor/three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "../vendor/three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "../vendor/three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "../vendor/three/addons/postprocessing/OutputPass.js";

const MASK_SDTRI = `
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
`;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Create the WebGL2 renderer, bloom pipeline and camera rig inside `host`.
 * Throws when WebGL2 is unavailable (the caller shows the fallback image).
 */
export function createStage({ host, quality, reduced: reducedIn, onContextLost, onContextRestored }) {
  let reduced = !!reducedIn;
  const canvas = document.createElement("canvas");
  canvas.className = "w-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!gl) throw new Error("WebGL2 unavailable");

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 1);
  host.appendChild(canvas);

  const maxDpr = quality === "high" ? 2 : quality === "medium" ? 1.5 : 1;
  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const minDpr = Math.min(dpr, quality === "low" ? 0.75 : 1);
  renderer.setPixelRatio(dpr);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 4000);
  const px = { value: 600 }; // pixels per world unit at distance 1 (for point sizes)

  // No multisampling on the half-float scene buffer: several GPU/driver pairs (AMD through ANGLE/Direct3D 11 among
  // them) render a multisampled float target as solid black. The bloom softens the edges anyway.
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 0 });
  rt.texture.name = "world.hdr";
  const composer = new EffectComposer(renderer, rt);
  const renderPass = new RenderPass(new THREE.Scene(), camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.55, 0.85);
  const bloomScale = quality === "high" ? 1 : quality === "medium" ? 0.7 : 0.5;
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.max(64, Math.round(w * bloomScale)), Math.max(64, Math.round(h * bloomScale)));
  // Replace the bloom's final additive blend with one that can fade the glow out inside a screen-space
  // disc (the black hole's shadow stays black instead of filling with blurred light).
  const maskUniforms = {
    tDiffuse: { value: null },
    opacity: { value: 1 },
    uMask: { value: new THREE.Vector4(0, 0, 0, 0.85) },
    uTri0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTri1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uAspect: { value: 1 },
  };
  bloom.blendMaterial.dispose();
  bloom.blendMaterial = new THREE.ShaderMaterial({
    name: "world.bloomBlend",
    uniforms: maskUniforms,
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader:
      "uniform sampler2D tDiffuse; uniform float opacity; uniform vec4 uMask; uniform vec4 uTri0; uniform vec4 uTri1; uniform float uAspect; varying vec2 vUv;" +
      MASK_SDTRI +
      "void main() { vec4 c = texture2D(tDiffuse, vUv) * opacity;" +
      " if (uMask.z > 0.0) { vec2 d = (vUv - uMask.xy) * vec2(uAspect, 1.0) / uMask.z; float m = smoothstep(uMask.w, 1.0, length(d));" +
      "  if (uTri1.w > 0.0) m = min(m, smoothstep(-0.12, 0.03, sdTri(vec2(abs(d.x), d.y), uTri0.xy, uTri0.zw, uTri1.xy) - uTri1.z));" +
      "  c *= m; }" +
      " gl_FragColor = c; }",
    premultipliedAlpha: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  bloom.copyUniforms = maskUniforms;
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);

  let width = 1,
    height = 1;
  function resize(w, h) {
    width = Math.max(1, Math.round(w));
    height = Math.max(1, Math.round(h));
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    px.value = (height * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  // ------------------------------------------------------------ camera rig
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.9;
  controls.enablePan = false;
  controls.autoRotate = false;
  controls.enableZoom = false; // turned on once the visitor engages (see world.js)
  canvas.style.touchAction = "pan-y"; // vertical swipes keep scrolling the page

  const rig = {
    mode: "orbit",
    home: { pos: new THREE.Vector3(0, 10, 40), target: new THREE.Vector3(0, 8, 0) },
    limits: { minDistance: 8, maxDistance: 120, minPolar: 0.2, maxPolar: 1.5, flyRadius: 200, flyMinY: 0.8, flySpeed: 10 },
    tween: null,
    idle: 0,
    autoSpeed: 0.3,
    fly: { yaw: 0, pitch: 0, vel: new THREE.Vector3(), keys: new Set(), drag: null, touchMove: 0 },
    follow: { get: null, last: new THREE.Vector3(), entering: null, lost: null },
  };

  controls.addEventListener("start", () => {
    rig.idle = 0;
    rig.tween = null;
  });

  function applyLimits(following) {
    const L = rig.limits;
    controls.minDistance = following ? 0.9 : L.minDistance;
    controls.maxDistance = following ? 40 : L.maxDistance;
    controls.minPolarAngle = following ? 0.05 : L.minPolar;
    controls.maxPolarAngle = following ? Math.PI - 0.05 : L.maxPolar;
  }

  function setView(view) {
    rig.home.pos.copy(view.pos);
    rig.home.target.copy(view.target);
    if (view.fov) camera.fov = view.fov;
    Object.assign(rig.limits, view.limits || {});
    rig.constrain = view.constrain || null;
    rig.autoSpeed = view.autoRotateSpeed ?? rig.autoSpeed;
    camera.updateProjectionMatrix();
    resize(width, height);
    applyLimits(false);
  }

  function jumpHome() {
    camera.position.copy(rig.home.pos);
    controls.target.copy(rig.home.target);
    camera.lookAt(rig.home.target);
    controls.update();
  }

  function tweenTo(pos, target, dur = 1.4) {
    rig.tween = {
      p0: camera.position.clone(),
      t0: controls.target.clone(),
      p1: pos.clone(),
      t1: target.clone(),
      t: 0,
      dur: reduced ? Math.min(dur, 0.6) : dur,
    };
  }

  function forward(v = new THREE.Vector3()) {
    return camera.getWorldDirection(v);
  }

  function setMode(mode, opts = {}) {
    const prev = rig.mode;
    rig.mode = mode;
    rig.tween = null;
    rig.idle = 0;
    controls.autoRotate = false;
    rig.fly.vel.set(0, 0, 0);
    rig.fly.keys.clear();
    rig.follow.entering = null;
    if (mode === "fly") {
      controls.enabled = false;
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
      rig.fly.yaw = e.y;
      rig.fly.pitch = e.x;
      canvas.style.touchAction = "none";
    } else {
      controls.enabled = true;
      canvas.style.touchAction = "pan-y";
    }
    if (mode === "orbit") {
      applyLimits(false);
      if (prev === "fly" || prev === "follow") {
        // keep looking where we look now, then glide the pivot back to the scene center
        const d = clamp(camera.position.distanceTo(rig.home.target), rig.limits.minDistance, rig.limits.maxDistance);
        controls.target.copy(camera.position).addScaledVector(forward(), d);
        const pos = camera.position.clone();
        const off = pos.clone().sub(rig.home.target);
        if (off.length() > rig.limits.maxDistance) pos.copy(rig.home.target).addScaledVector(off.normalize(), rig.limits.maxDistance);
        if (pos.y < rig.limits.flyMinY + 0.5) pos.y = rig.limits.flyMinY + 0.5;
        tweenTo(pos, rig.home.target, 1.2);
      }
    }
    if (mode === "follow") {
      applyLimits(true);
      rig.follow.get = opts.get || null;
      rig.follow.lost = opts.onLost || null;
      const p = rig.follow.get && rig.follow.get();
      if (p) {
        rig.follow.last.copy(p);
        const off0 = camera.position.clone().sub(p);
        const dist = opts.distance || 5;
        const off1 = off0.clone().setLength(dist);
        off1.y = Math.max(off1.y, dist * 0.28);
        off1.setLength(dist);
        rig.follow.entering = { off0, off1, tgt0: controls.target.clone(), t: 0, dur: reduced ? 0.5 : 1.3 };
      }
    }
  }

  /** Switch the followed creature without leaving follow mode. */
  function retarget(get, distance = 5) {
    if (rig.mode !== "follow") return setMode("follow", { get, onLost: rig.follow.lost, distance });
    rig.follow.get = get;
    const p = get && get();
    if (!p) return;
    rig.follow.last.copy(p);
    const off0 = camera.position.clone().sub(p);
    const off1 = off0.clone().setLength(Math.min(off0.length(), distance));
    rig.follow.entering = { off0, off1, tgt0: controls.target.clone(), t: 0, dur: reduced ? 0.5 : 1.1 };
  }

  function reset() {
    if (rig.mode !== "orbit") setMode("orbit");
    applyLimits(false);
    tweenTo(rig.home.pos, rig.home.target, 1.5);
  }

  // Fly mode: drag to look.
  const ac = new AbortController();
  const sig = { signal: ac.signal };
  canvas.addEventListener(
    "pointerdown",
    (e) => {
      rig.idle = 0;
      if (rig.mode !== "fly") return;
      rig.fly.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
    },
    sig,
  );
  canvas.addEventListener(
    "pointermove",
    (e) => {
      const d = rig.fly.drag;
      if (rig.mode !== "fly" || !d || d.id !== e.pointerId) return;
      const k = e.pointerType === "touch" ? 0.0055 : 0.0038;
      rig.fly.yaw -= (e.clientX - d.x) * k;
      rig.fly.pitch = clamp(rig.fly.pitch - (e.clientY - d.y) * k, -1.45, 1.45);
      d.x = e.clientX;
      d.y = e.clientY;
    },
    sig,
  );
  const endDrag = (e) => {
    if (rig.fly.drag && rig.fly.drag.id === e.pointerId) rig.fly.drag = null;
  };
  canvas.addEventListener("pointerup", endDrag, sig);
  canvas.addEventListener("pointercancel", endDrag, sig);

  const KEYMAP = {
    KeyW: "f",
    ArrowUp: "f",
    KeyS: "b",
    ArrowDown: "b",
    KeyA: "l",
    ArrowLeft: "l",
    KeyD: "r",
    ArrowRight: "r",
    KeyE: "u",
    Space: "u",
    KeyQ: "d",
  };
  /** Returns true when the key was used (caller prevents default). */
  function key(code, down, shift) {
    rig.fly.fast = !!shift;
    const k = KEYMAP[code];
    if (!k || rig.mode !== "fly") return false;
    if (down) rig.fly.keys.add(k);
    else rig.fly.keys.delete(k);
    rig.idle = 0;
    return true;
  }
  function flyInput(dir, on) {
    if (on) rig.fly.keys.add(dir);
    else rig.fly.keys.delete(dir);
  }

  const _v = new THREE.Vector3();
  const _f = new THREE.Vector3();
  const _r = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _euler = new THREE.Euler(0, 0, 0, "YXZ");

  function update(dt) {
    rig.idle += dt;
    const L = rig.limits;
    if (rig.mode === "fly") {
      _euler.set(rig.fly.pitch, rig.fly.yaw, 0, "YXZ");
      camera.quaternion.setFromEuler(_euler);
      const K = rig.fly.keys;
      _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _r.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _v.set(0, 0, 0);
      if (K.has("f")) _v.add(_f);
      if (K.has("b")) _v.sub(_f);
      if (K.has("r")) _v.add(_r);
      if (K.has("l")) _v.sub(_r);
      if (K.has("u")) _v.y += 1;
      if (K.has("d")) _v.y -= 1;
      if (_v.lengthSq() > 0) _v.normalize().multiplyScalar(L.flySpeed * (rig.fly.fast ? 3 : 1) * (reduced ? 0.6 : 1));
      rig.fly.vel.lerp(_v, damp(5, dt));
      camera.position.addScaledVector(rig.fly.vel, dt);
      // stay inside the world
      if (camera.position.length() > L.flyRadius) camera.position.setLength(L.flyRadius);
      if (camera.position.y < L.flyMinY) camera.position.y = L.flyMinY;
      if (L.flyMaxY && camera.position.y > L.flyMaxY) camera.position.y = L.flyMaxY;
      if (rig.constrain) rig.constrain(camera.position);
      return;
    }
    if (rig.mode === "follow") {
      const p = rig.follow.get && rig.follow.get();
      if (!p) {
        const lost = rig.follow.lost;
        if (lost) lost();
        else setMode("orbit");
        return;
      }
      const en = rig.follow.entering;
      if (en) {
        en.t += dt / en.dur;
        const e = easeInOut(Math.min(1, en.t));
        _p.copy(en.off0).lerp(en.off1, e);
        camera.position.copy(p).add(_p);
        controls.target.copy(en.tgt0).lerp(p, e);
        if (en.t >= 1) rig.follow.entering = null;
        camera.lookAt(controls.target);
      } else {
        _p.copy(p).sub(rig.follow.last);
        camera.position.add(_p);
        controls.target.copy(p);
        controls.update(dt);
      }
      rig.follow.last.copy(p);
      if (camera.position.y < L.flyMinY) camera.position.y = L.flyMinY;
      if (rig.constrain) rig.constrain(camera.position);
      return;
    }
    // orbit
    if (rig.tween) {
      const tw = rig.tween;
      tw.t += dt / tw.dur;
      const e = easeInOut(Math.min(1, tw.t));
      camera.position.copy(tw.p0).lerp(tw.p1, e);
      controls.target.copy(tw.t0).lerp(tw.t1, e);
      if (tw.t >= 1) rig.tween = null;
    }
    controls.autoRotate = !reduced && !rig.tween && rig.idle > 7;
    controls.autoRotateSpeed = rig.autoSpeed * clamp((rig.idle - 7) / 4, 0, 1);
    controls.update(dt);
    if (rig.constrain) rig.constrain(camera.position);
  }

  const _proj = new THREE.Vector3();
  /** Project a world point to CSS pixels inside the canvas; null when behind the camera. */
  function project(v) {
    _proj.copy(v).project(camera);
    if (_proj.z > 1 || _proj.z < -1) return null;
    return { x: (_proj.x * 0.5 + 0.5) * width, y: (-_proj.y * 0.5 + 0.5) * height };
  }

  // Adaptive resolution: drop the pixel ratio when frames are slow for a while.
  let slow = 0,
    frames = 0;
  function watchPerf(frameMs) {
    frames++;
    if (frames < 120) return;
    slow = frameMs > 34 ? slow + 1 : Math.max(0, slow - 2);
    if (slow > 90 && dpr > minDpr + 0.01) {
      dpr = Math.max(minDpr, dpr * 0.8);
      slow = 0;
      resize(width, height);
    }
  }

  /** mask: { u, v, r, inner } in UV units (r relative to the height) or null. */
  function render(dt, mask) {
    const m = maskUniforms.uMask.value;
    const t0 = maskUniforms.uTri0.value;
    const t1 = maskUniforms.uTri1.value;
    if (mask) m.set(mask.u, mask.v, mask.r, mask.inner ?? 0.85);
    else m.z = 0;
    // optional mirrored triangle (in units of r), e.g. the cat ears: tri = [x0, y0, x1, y1, x2, y2, rounding]
    if (mask && mask.tri) {
      const k = mask.triScale || 1;
      const T = mask.tri;
      t0.set(T[0] * k, T[1] * k, T[2] * k, T[3] * k);
      t1.set(T[4] * k, T[5] * k, (T[6] || 0) * k, 1);
    } else t1.w = 0;
    maskUniforms.uAspect.value = width / height;
    composer.render(dt);
  }

  /**
   * True when the frame just rendered shows anything at all. Reads three rows of the finished image, so it must run
   * in the same animation frame as render(), and only now and then (each read waits for the GPU).
   */
  function probeLit() {
    const gl = renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const row = new Uint8Array(w * 4);
    for (const f of [0.3, 0.5, 0.7]) {
      gl.readPixels(0, Math.floor(h * f), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      for (let i = 0; i < row.length; i += 4) if (row[i] + row[i + 1] + row[i + 2] > 24) return true;
    }
    return false;
  }

  function setScene(scene, look) {
    renderPass.scene = scene;
    bloom.strength = look.bloom?.strength ?? 0.8;
    bloom.radius = look.bloom?.radius ?? 0.55;
    bloom.threshold = look.bloom?.threshold ?? 0.85;
    renderer.toneMappingExposure = look.exposure ?? 1;
    if (look.clear) renderer.setClearColor(look.clear, 1);
  }

  canvas.addEventListener(
    "webglcontextlost",
    (e) => {
      e.preventDefault();
      onContextLost && onContextLost();
    },
    sig,
  );
  canvas.addEventListener("webglcontextrestored", () => onContextRestored && onContextRestored(), sig);

  function dispose() {
    ac.abort();
    controls.dispose();
    for (const p of composer.passes) p.dispose && p.dispose();
    composer.dispose();
    renderer.dispose();
    try {
      renderer.forceContextLoss();
    } catch {}
    canvas.remove();
  }

  return {
    THREE,
    renderer,
    canvas,
    camera,
    controls,
    px,
    rig,
    get size() {
      return { width, height, dpr };
    },
    resize,
    setView,
    setScene,
    jumpHome,
    setMode,
    retarget,
    reset,
    key,
    flyInput,
    update,
    render,
    probeLit,
    project,
    watchPerf,
    setReduced(v) {
      reduced = !!v;
    },
    clearKeys() {
      rig.fly.keys.clear();
    },
    compile: async (scene) => {
      // Compile for the target the scene is really drawn into: three.js keys a program on the bound target's colour
      // space and tone mapping, so compiling for the screen built a second set of programs no frame ever used (and
      // the real ones then compiled on the first frame). compileAsync reads the target synchronously.
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      try {
        // compileAsync warns when KHR_parallel_shader_compile is missing; compile synchronously then.
        if (renderer.compileAsync && renderer.extensions.has("KHR_parallel_shader_compile")) {
          const done = renderer.compileAsync(scene, camera);
          renderer.setRenderTarget(prev);
          return await done;
        }
        renderer.compile(scene, camera);
      } finally {
        renderer.setRenderTarget(prev);
      }
    },
    dispose,
  };
}
