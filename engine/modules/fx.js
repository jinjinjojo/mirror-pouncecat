// Animated backgrounds on one fixed canvas behind the page. Colors come from the theme's CSS variables unless the
// config sets its own (look.effect.colors). Every effect takes amount (how many), speed, size and opacity; the shape
// effects (particles and its one-word presets) also take a shape and a direction.
// Effects: swirl, starfield, aurora, pixelstars, paper, dust, bubbles, coderain, synthgrid, fireflies, particles, snow,
// embers, bokeh, constellation, meteors, confetti. Presets: paws, hearts, coins, candles, sparkles, fish.

function parseColor(c, fallback = [255, 255, 255]) {
  c = (c || "").trim();
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) return m[1].split("").map((x) => parseInt(x + x, 16));
  m = c.match(/^#([0-9a-f]{6})/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) return m[1].split(/[ ,/]+/).slice(0, 3).map(Number);
  return fallback;
}
const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
const rand = (a, b) => a + Math.random() * (b - a);
const any = (list) => list[(Math.random() * list.length) | 0];

/** The shape effects and their default shape and direction (the same table as SHAPE_EFFECTS in lib/themes.mjs). */
export const SHAPE_EFFECTS = {
  particles: { shape: "dot", direction: "up" },
  paws: { shape: "paw", direction: "up" },
  hearts: { shape: "heart", direction: "up" },
  coins: { shape: "coin", direction: "down" },
  candles: { shape: "candle", direction: "up" },
  sparkles: { shape: "sparkle", direction: "drift" },
  fish: { shape: "fish", direction: "right" },
};
export const SHAPES = ["dot", "star", "sparkle", "heart", "paw", "fish", "coin", "candle"];
export const DIRECTIONS = ["up", "down", "left", "right", "drift"];

/** Options with nothing set: the theme's colors, normal amount, speed, size and opacity, the preset's shape. */
export function effectDefaults(name) {
  const shaped = SHAPE_EFFECTS[name];
  return { colors: [], amount: 1, speed: 1, size: 1, opacity: 1, shape: shaped?.shape ?? null, direction: shaped?.direction ?? null };
}

// ---------- shapes: each is drawn once per color into a small canvas (a sprite), then stamped every frame ----------
const SPRITE = 100;
const sprites = new Map();
const isImagePath = (s) => /[\\/]/.test(s) || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(s);

function sprite(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"));
  return c;
}

const HEART = "M12 20s-7-4.4-9.2-9A5 5 0 0 1 12 6.3 5 5 0 0 1 21.2 11C19 15.6 12 20 12 20Z"; // the heart icon

// Built-in shapes, drawn in a 100×100 box. Paws point up, fish swim right; the effect turns them to their heading.
const DRAW = {
  dot(g, c) {
    const grad = g.createRadialGradient(50, 50, 0, 50, 50, 50);
    grad.addColorStop(0, rgba(c, 1));
    grad.addColorStop(0.4, rgba(c, 0.8));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 100, 100);
  },
  star(g, c) {
    g.fillStyle = rgba(c, 1);
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 19 : 46;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      g.lineTo(50 + Math.cos(a) * r, 53 + Math.sin(a) * r);
    }
    g.fill();
  },
  sparkle(g, c) {
    const grad = g.createRadialGradient(50, 50, 0, 50, 50, 50);
    grad.addColorStop(0, rgba(c, 0.45));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 100, 100);
    g.fillStyle = rgba(c, 1);
    g.beginPath();
    g.moveTo(50, 2);
    g.quadraticCurveTo(55, 45, 98, 50);
    g.quadraticCurveTo(55, 55, 50, 98);
    g.quadraticCurveTo(45, 55, 2, 50);
    g.quadraticCurveTo(45, 45, 50, 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.beginPath();
    g.arc(50, 50, 5, 0, 6.283);
    g.fill();
  },
  heart(g, c) {
    g.fillStyle = rgba(c, 1);
    g.translate(50, 50);
    g.scale(4.5, 4.5);
    g.translate(-12, -11.7);
    g.fill(new Path2D(HEART));
  },
  paw(g, c) {
    g.fillStyle = rgba(c, 1);
    const pads = [
      [50, 67, 22, 18, 0],
      [25, 42, 8.5, 11, -0.4],
      [40, 26, 9, 12, -0.15],
      [60, 26, 9, 12, 0.15],
      [75, 42, 8.5, 11, 0.4],
    ];
    for (const [x, y, rx, ry, rot] of pads) {
      g.beginPath();
      g.ellipse(x, y, rx, ry, rot, 0, 6.283);
      g.fill();
    }
  },
  fish(g, c) {
    g.fillStyle = rgba(c, 1);
    g.beginPath();
    g.ellipse(58, 50, 32, 19, 0, 0, 6.283);
    g.fill();
    g.beginPath();
    g.moveTo(32, 50);
    g.lineTo(6, 30);
    g.lineTo(12, 50);
    g.lineTo(6, 70);
    g.fill();
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(76, 45, 4.5, 0, 6.283);
    g.fill();
  },
  coin(g, c) {
    g.fillStyle = rgba(c, 1);
    g.beginPath();
    g.arc(50, 50, 46, 0, 6.283);
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.22)";
    g.lineWidth = 4;
    g.beginPath();
    g.arc(50, 50, 43, 0, 6.283);
    g.stroke();
    g.lineWidth = 3.5;
    g.beginPath();
    g.arc(50, 50, 31, 0, 6.283);
    g.stroke();
    g.strokeStyle = "rgba(255,255,255,0.5)";
    g.lineWidth = 5;
    g.lineCap = "round";
    g.beginPath();
    g.arc(50, 50, 37, Math.PI * 1.08, Math.PI * 1.42);
    g.stroke();
  },
  candle(g, c) {
    g.fillStyle = rgba(c, 1);
    g.fillRect(47, 4, 6, 92);
    g.beginPath();
    if (g.roundRect) g.roundRect(32, 24, 36, 52, 4);
    else g.rect(32, 24, 36, 52);
    g.fill();
  },
};

function textSprite(text, c) {
  return sprite(SPRITE, (g) => {
    const font = (px) => `600 ${px}px system-ui, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    let px = SPRITE * 0.78;
    g.font = font(px);
    const w = g.measureText(text).width;
    if (w > SPRITE * 0.94) g.font = font((px *= (SPRITE * 0.94) / w));
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = rgba(c, 1);
    g.fillText(text, SPRITE / 2, SPRITE / 2 + px * 0.05);
  });
}

/** An image (the logo or a file in the site) as a sprite: null while it loads, the dot if it can't be loaded. */
function imageSprite(src, onReady) {
  let entry = sprites.get(`img|${src}`);
  if (!entry) {
    entry = { canvas: null, failed: false, waiting: new Set() };
    sprites.set(`img|${src}`, entry);
    const img = new Image();
    const settle = () => {
      for (const cb of entry.waiting) cb();
      entry.waiting.clear();
    };
    img.onload = () => {
      const size = SPRITE * 1.28;
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const k = Math.min(size / iw, size / ih);
      entry.canvas = sprite(size, (g) => g.drawImage(img, (size - iw * k) / 2, (size - ih * k) / 2, iw * k, ih * k));
      settle();
    };
    img.onerror = () => {
      entry.failed = true;
      settle();
    };
    img.src = src;
  }
  if (!entry.canvas && !entry.failed && onReady) entry.waiting.add(onReady);
  return entry;
}

/** The sprite for a shape in a color (images ignore the color), or null while an image is still loading. */
function shapeSprite(shape, c, env) {
  if (shape === "logo" || isImagePath(shape)) {
    const entry = imageSprite(shape === "logo" ? env.logo : env.url(shape), env.ready);
    if (entry.canvas || !entry.failed) return entry.canvas;
    shape = "dot";
  }
  const key = `${shape}|${c}`;
  if (!sprites.has(key)) sprites.set(key, DRAW[shape] ? sprite(SPRITE, (g) => DRAW[shape](g, c)) : textSprite(shape, c));
  return sprites.get(key);
}

/** A soft round glow in one color, for embers and bokeh. `rim` gives the bright edge of an out-of-focus light. */
function glowSprite(c, rim = false) {
  const key = `${rim ? "disc" : "glow"}|${c}`;
  if (!sprites.has(key)) {
    sprites.set(
      key,
      sprite(128, (g) => {
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        const hot = c.map((v) => Math.round(v + (255 - v) * 0.6));
        if (rim) {
          grad.addColorStop(0, rgba(c, 0.55));
          grad.addColorStop(0.8, rgba(c, 0.7));
          grad.addColorStop(0.93, rgba(c, 0.95));
          grad.addColorStop(1, rgba(c, 0));
        } else {
          grad.addColorStop(0, rgba(hot, 1));
          grad.addColorStop(0.14, rgba(c, 0.9));
          grad.addColorStop(0.35, rgba(c, 0.3));
          grad.addColorStop(1, rgba(c, 0));
        }
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
      }),
    );
  }
  return sprites.get(key);
}

// Size (px at size 1), speed (px/ms), how much each shape tilts and spins, and how many fit a screen (one per `per`
// square pixels, at most `max`). `face` shapes turn to where they're going; coins flip; sparkles twinkle.
const STYLE = {
  dot: { s: [5, 14], v: [0.01, 0.03], tilt: 0, spin: 0, per: 9000, max: 150 },
  star: { s: [10, 24], v: [0.01, 0.028], tilt: 3.14, spin: 0.0005, per: 20000, max: 70 },
  sparkle: { s: [14, 34], v: [0.006, 0.018], tilt: 0.3, spin: 0.0003, twinkle: true, per: 15000, max: 90 },
  heart: { s: [14, 30], v: [0.012, 0.03], tilt: 0.35, spin: 0, per: 24000, max: 60 },
  paw: { s: [22, 40], v: [0.01, 0.024], tilt: 0.35, spin: 0, face: "up", per: 26000, max: 56 },
  fish: { s: [30, 52], v: [0.018, 0.042], tilt: 0, spin: 0, face: "right", per: 42000, max: 34 },
  coin: { s: [16, 32], v: [0.028, 0.065], tilt: 0.3, spin: 0, flip: true, per: 26000, max: 56 },
  candle: { s: [18, 38], v: [0.014, 0.036], tilt: 0, spin: 0, per: 24000, max: 60 },
  custom: { s: [18, 34], v: [0.012, 0.03], tilt: 0.3, spin: 0, per: 26000, max: 56 },
};
const HEADING = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const EFFECTS = {

  /**
   * A laser pointer in a dark room: one red dot darts across the page in quick pointer moves (a dash, a stop, a little
   * jitter, sometimes a circle), leaving a short fading trail, while warm dust floats in the air. A live buy
   * ("coin:trade" on document, with x/y) sends the dot straight to where it landed, where it bursts: the cat got it.
   */
  laser(g, C, { n, S }) {
    const red = C.accent;
    let dust = [];
    const dot = { x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: 0, dur: 1, hold: 0, trail: [], circle: 0, mode: "move" };
    const bursts = [];
    let W = 0;
    let H = 0;
    const pick = (now) => {
      dot.fx = dot.x;
      dot.fy = dot.y;
      const far = Math.random() < 0.35;
      const r = far ? Math.max(W, H) * 0.6 : Math.min(W, H) * 0.25;
      dot.tx = Math.min(W - 30, Math.max(30, dot.x + (Math.random() - 0.5) * 2 * r));
      dot.ty = Math.min(H - 30, Math.max(30, dot.y + (Math.random() - 0.5) * 2 * r));
      dot.t0 = now;
      dot.dur = far ? 380 + Math.random() * 380 : 220 + Math.random() * 300;
      dot.hold = 250 + Math.random() * (Math.random() < 0.3 ? 1600 : 600);
      dot.mode = Math.random() < 0.12 ? "circle" : "move";
      dot.circle = 0;
    };
    const onTrade = (e) => {
      const d = e.detail || {};
      if (d.side !== "buy" || d.x == null) return;
      const now = performance.now();
      dot.fx = dot.x;
      dot.fy = dot.y;
      dot.tx = d.x;
      dot.ty = d.y;
      dot.t0 = now;
      dot.dur = 260;
      dot.hold = 900;
      dot.mode = "catch";
    };
    document.addEventListener("coin:trade", onTrade);
    return {
      init(w, h) {
        W = w;
        H = h;
        if (!dot.x) {
          dot.x = w * 0.7;
          dot.y = h * 0.45;
          pick(performance.now());
        }
        dust = Array.from({ length: n(Math.min(90, Math.round((w * h) / 16000))) }, () => ({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 0.4 + Math.random() * 1.4,
          vx: (Math.random() - 0.5) * 0.008,
          vy: -0.004 - Math.random() * 0.01,
          a: 0.08 + Math.random() * 0.22,
          ph: Math.random() * 6.28,
        }));
      },
      frame(t, dt, w, h) {
        const now = performance.now();
        g.clearRect(0, 0, w, h);
        for (const m of dust) {
          m.x += m.vx * dt + Math.sin(t / 2400 + m.ph) * 0.03;
          m.y += m.vy * dt;
          if (m.y < -4) {
            m.y = h + 4;
            m.x = Math.random() * w;
          }
          g.fillStyle = rgba(C.accent2 ?? C.fg, m.a);
          g.beginPath();
          g.arc(m.x, m.y, m.r * S, 0, 6.283);
          g.fill();
        }
        // The dot: ease to the target, then hold (with a small hand jitter), sometimes circling, then pick again.
        const k = Math.min(1, (now - dot.t0) / dot.dur);
        const e = 1 - Math.pow(1 - k, 3);
        let x = dot.fx + (dot.tx - dot.fx) * e;
        let y = dot.fy + (dot.ty - dot.fy) * e;
        if (k >= 1) {
          if (dot.mode === "circle") {
            dot.circle += dt * 0.012;
            x += Math.cos(dot.circle) * 26;
            y += Math.sin(dot.circle) * 26;
          } else {
            x += Math.sin(now / 90) * 1.2;
            y += Math.cos(now / 110) * 1.2;
          }
          if (dot.mode === "catch" && !dot.burst) {
            bursts.push({ x, y, t0: now });
            dot.burst = true;
          }
          if (now - dot.t0 > dot.dur + dot.hold) {
            dot.burst = false;
            if (dot.mode === "catch") {
              // Caught: the dot reappears somewhere else in the room.
              dot.x = Math.random() * w;
              dot.y = Math.random() * h;
            }
            pick(now);
          }
        }
        dot.x = x;
        dot.y = y;
        dot.trail.push([x, y]);
        if (dot.trail.length > 14) dot.trail.shift();
        g.lineCap = "round";
        for (let i = 1; i < dot.trail.length; i++) {
          const [ax, ay] = dot.trail[i - 1];
          const [bx, by] = dot.trail[i];
          g.strokeStyle = rgba(red, (i / dot.trail.length) * 0.35);
          g.lineWidth = (1 + (i / dot.trail.length) * 3) * S;
          g.beginPath();
          g.moveTo(ax, ay);
          g.lineTo(bx, by);
          g.stroke();
        }
        const glow = g.createRadialGradient(x, y, 0, x, y, 30 * S);
        glow.addColorStop(0, rgba(red, 0.55));
        glow.addColorStop(0.25, rgba(red, 0.22));
        glow.addColorStop(1, rgba(red, 0));
        g.fillStyle = glow;
        g.fillRect(x - 30 * S, y - 30 * S, 60 * S, 60 * S);
        g.fillStyle = "rgba(255,240,240,0.95)";
        g.beginPath();
        g.arc(x, y, 2.4 * S, 0, 6.283);
        g.fill();
        for (let i = bursts.length - 1; i >= 0; i--) {
          const b = bursts[i];
          const q = (now - b.t0) / 700;
          if (q >= 1) {
            bursts.splice(i, 1);
            continue;
          }
          for (let j = 0; j < 8; j++) {
            const a = (j / 8) * 6.283;
            const r = 8 + q * 46;
            g.fillStyle = rgba(red, (1 - q) * 0.8);
            g.beginPath();
            g.arc(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r, (2.2 - q * 1.6) * S, 0, 6.283);
            g.fill();
          }
        }
      },
      stop() {
        document.removeEventListener("coin:trade", onTrade);
      },
    };
  },
  /**
   * Deep space you scroll through: domain-warped nebula clouds from a small WebGL shader (drawn at a third of the
   * screen's size and scaled up; they're soft anyway), crisp twinkling stars in three depth layers on top, all
   * drifting with the scroll at different speeds. A live buy ("coin:trade" on document, with x/y) sends a ring of
   * light out from where it landed. Without WebGL the clouds are a still gradient; the stars stay.
   */
  nebula(g, C, { n, S, o }) {
    const glc = document.createElement("canvas");
    let gl = null;
    try {
      gl = glc.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "low-power" });
    } catch {
      gl = null;
    }
    const VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
    const FS = `precision mediump float;
uniform vec2 uRes;uniform float uTime;uniform float uScroll;uniform float uAmount;uniform vec3 uBg;uniform vec3 uA;uniform vec3 uB;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
  vec2 p=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  float t=uTime;
  vec2 q=p*1.25+vec2(0.,-uScroll);
  vec2 w=vec2(fbm(q+vec2(t*.013,0.)),fbm(q+vec2(5.2,1.3)-t*.011));
  float n=fbm(q+1.9*w+vec2(0.,t*.006));
  float m=fbm(q*1.7-w*1.2+3.7);
  vec3 neb=mix(uB,uA,smoothstep(.55,.95,m));
  float dens=smoothstep(.28,.86,n);
  vec3 col=uBg+neb*pow(dens,1.55)*.95*uAmount;
  col+=mix(uB,uA,.5)*pow(max(n-.62,0.)*2.8,2.2)*.5*uAmount;
  col*=1.-.3*smoothstep(.52,.78,fbm(q*2.6+11.3));
  float v=length(p*vec2(.85,1.));
  col*=1.-.42*smoothstep(.45,1.25,v);
  gl_FragColor=vec4(col,1.);
}`;
    let prog = null;
    const U = {};
    if (gl) {
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
      };
      const vs = sh(gl.VERTEX_SHADER, VS);
      const fs = sh(gl.FRAGMENT_SHADER, FS);
      if (vs && fs) {
        prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) prog = null;
      }
      if (prog) {
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
        const loc = gl.getAttribLocation(prog, "p");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        for (const k of ["uRes", "uTime", "uScroll", "uAmount", "uBg", "uA", "uB"]) U[k] = gl.getUniformLocation(prog, k);
        const v3 = (c) => c.map((x) => x / 255);
        gl.uniform3fv(U.uBg, v3(C.bg));
        gl.uniform3fv(U.uA, v3(C.accent));
        gl.uniform3fv(U.uB, v3(C.accent2));
      }
    }
    let stars = [];
    const pulses = [];
    let lastGl = -1e9;
    const onTrade = (e) => {
      const d = e.detail || {};
      if (d.side !== "buy") return;
      pulses.push({ x: d.x ?? innerWidth / 2, y: d.y ?? innerHeight / 2, t0: performance.now(), k: Math.min(1.6, 0.6 + Math.log10(1 + (d.usd || 0)) / 3) });
      if (pulses.length > 6) pulses.shift();
    };
    document.addEventListener("coin:trade", onTrade);
    return {
      init(w, h) {
        const scale = w * h > 1.1e6 ? 0.34 : 0.45;
        glc.width = Math.max(2, Math.round(w * scale));
        glc.height = Math.max(2, Math.round(h * scale));
        if (prog) {
          gl.viewport(0, 0, glc.width, glc.height);
          gl.uniform2f(U.uRes, glc.width, glc.height);
          // A tall phone screen shows the clouds bigger and closer: a little dimmer there, so text stays easy to read.
          gl.uniform1f(U.uAmount, Math.min(1.8, 0.55 + 0.45 * o.amount) * (w < 640 ? 0.7 : 1));
        }
        lastGl = -1e9;
        const count = n(Math.min(420, Math.round((w * h) / 3600)));
        stars = Array.from({ length: count }, () => {
          const z = Math.random();
          return { x: rand(0, w), y: rand(0, h * 3), z, tw: rand(0, 6.28), sp: rand(0.6, 1.8), hot: Math.random() < 0.08 };
        });
      },
      frame(t, dt, w, h) {
        const sy = scrollY;
        // The clouds move slowly: about 30 frames a second is plenty, and the canvas keeps the last one between.
        if (t - lastGl > 32 || dt === 16) {
          lastGl = t;
          if (prog) {
            gl.uniform1f(U.uTime, t / 1000);
            gl.uniform1f(U.uScroll, (sy / Math.max(1, h)) * 0.18);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            g.drawImage(glc, 0, 0, w, h);
          } else {
            const grd = g.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, Math.max(w, h) * 0.8);
            grd.addColorStop(0, rgba(C.accent2, 0.22));
            grd.addColorStop(1, rgba(C.bg, 1));
            g.fillStyle = grd;
            g.fillRect(0, 0, w, h);
          }
          for (const s of stars) {
            // Three depths: far stars barely move with the scroll, near ones more (the page's own depth).
            const depth = s.z < 0.6 ? 0.03 : s.z < 0.9 ? 0.07 : 0.14;
            const y = (((s.y - sy * depth) % (h * 3)) + h * 3) % (h * 3);
            if (y > h) continue;
            const a = (0.25 + 0.6 * s.z) * (0.55 + 0.45 * Math.sin(t / (520 * s.sp) + s.tw));
            const r = (0.5 + s.z * 1.3) * S;
            g.fillStyle = rgba(s.hot ? C.accent : C.fg, a);
            g.fillRect(s.x, y, r, r);
          }
          this.rings(g, w, h);
        }
      },
      rings(g, w, h) {
        const now = performance.now();
        for (let i = pulses.length - 1; i >= 0; i--) {
          const p = pulses[i];
          const k = (now - p.t0) / 1600;
          if (k >= 1) {
            pulses.splice(i, 1);
            continue;
          }
          const r = 20 + k * Math.min(w, h) * 0.55 * p.k;
          g.strokeStyle = rgba(C.accent, (1 - k) * 0.5);
          g.lineWidth = 1.5 + (1 - k) * 2;
          g.beginPath();
          g.arc(p.x, p.y, r, 0, 6.283);
          g.stroke();
          const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          glow.addColorStop(0, rgba(C.accent, (1 - k) * 0.16));
          glow.addColorStop(1, rgba(C.accent, 0));
          g.fillStyle = glow;
          g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        }
      },
      stop() {
        document.removeEventListener("coin:trade", onTrade);
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
      },
    };
  },

  starfield(g, C, { n, S }) {
    let stars = [];
    return {
      init(w, h) {
        stars = Array.from({ length: n(Math.min(420, Math.round((w * h) / 4200))) }, () => ({
          x: rand(0, w),
          y: rand(0, h),
          z: rand(0.2, 1),
          t: rand(0, 6.28),
        }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const s of stars) {
          s.x -= dt * 0.006 * s.z;
          if (s.x < -2) s.x = w + 2;
          const a = 0.25 + 0.55 * s.z * (0.6 + 0.4 * Math.sin(t / 700 + s.t));
          g.fillStyle = rgba(s.z > 0.93 ? C.accent : C.fg, a);
          const r = s.z * 1.3 * S;
          g.fillRect(s.x, s.y, r, r);
        }
      },
    };
  },

  swirl(g, C, { n, S }) {
    let stars = [];
    let motes = [];
    let cx = 0;
    let cy = 0;
    const spawn = (w, h, anywhere) => {
      const R = Math.hypot(w, h) * 0.55;
      return { a: rand(0, 6.283), r: anywhere ? rand(40, R) : rand(R * 0.7, R), s: rand(0.00006, 0.00018), size: rand(0.6, 2.2), hue: Math.random() };
    };
    return {
      init(w, h) {
        cx = w * 0.5;
        cy = h * 0.46;
        stars = Array.from({ length: n(Math.min(260, Math.round((w * h) / 7000))) }, () => ({ x: rand(0, w), y: rand(0, h), z: rand(0.2, 1), t: rand(0, 6.28) }));
        motes = Array.from({ length: n(Math.min(340, Math.round((w * h) / 5200))) }, () => spawn(w, h, true));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        const glow = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.6);
        glow.addColorStop(0, rgba(C.accent2, 0.1));
        glow.addColorStop(0.35, rgba(C.accent2, 0.045));
        glow.addColorStop(1, rgba(C.accent2, 0));
        g.fillStyle = glow;
        g.fillRect(0, 0, w, h);
        for (const s of stars) {
          const a = 0.18 + 0.5 * s.z * (0.6 + 0.4 * Math.sin(t / 900 + s.t));
          g.fillStyle = rgba(C.fg, a);
          g.fillRect(s.x, s.y, s.z * 1.2 * S, s.z * 1.2 * S);
        }
        g.globalCompositeOperation = "lighter";
        for (const m of motes) {
          m.a += m.s * dt * (1 + 260 / (m.r + 30));
          m.r -= dt * 0.012 * (1 + 120 / (m.r + 20));
          if (m.r < 14) Object.assign(m, spawn(w, h, false));
          const x = cx + Math.cos(m.a) * m.r;
          const y = cy + Math.sin(m.a) * m.r * 0.62;
          const fade = Math.min(1, m.r / 160);
          const col = m.hue > 0.82 ? C.accent : m.hue > 0.55 ? C.accent2 : C.fg;
          g.fillStyle = rgba(col, 0.55 * fade);
          g.beginPath();
          g.arc(x, y, m.size * (0.5 + fade * 0.5) * S, 0, 6.283);
          g.fill();
        }
        g.globalCompositeOperation = "source-over";
      },
    };
  },

  aurora(g, C, { n, S }) {
    let blobs = [];
    const cols = C.pick([C.accent, C.accent2]);
    return {
      init(w, h) {
        blobs = Array.from({ length: n(4) }, (_, i) => ({ c: cols[i % cols.length], px: rand(0, 6.28), py: rand(0, 6.28), sx: rand(0.00005, 0.00012), sy: rand(0.00004, 0.0001), r: Math.max(w, h) * rand(0.32, 0.5) * S, i }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        g.globalCompositeOperation = "lighter";
        for (const b of blobs) {
          const x = w * (0.5 + 0.42 * Math.sin(t * b.sx + b.px));
          const y = h * (0.35 + 0.3 * Math.sin(t * b.sy + b.py));
          const grad = g.createRadialGradient(x, y, 0, x, y, b.r);
          grad.addColorStop(0, rgba(b.c, 0.16));
          grad.addColorStop(1, rgba(b.c, 0));
          g.fillStyle = grad;
          g.fillRect(0, 0, w, h);
        }
        g.globalCompositeOperation = "source-over";
      },
    };
  },

  pixelstars(g, C, { mode, n, S }) {
    let px = [];
    const size = Math.max(2, Math.round(4 * S));
    const ink = mode === "light" ? C.fg : [255, 255, 255];
    return {
      init(w, h) {
        px = Array.from({ length: n(Math.min(220, Math.round((w * h) / 9000))) }, () => ({ x: Math.floor(rand(0, w / size)) * size, y: Math.floor(rand(0, h / size)) * size, t: rand(0, 6.28), sp: rand(0.6, 1.6), big: Math.random() > 0.85 }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const p of px) {
          const a = Math.max(0, Math.sin(t / 600 * p.sp + p.t));
          if (a < 0.05) continue;
          g.fillStyle = rgba(p.big ? C.accent : ink, (mode === "light" ? 0.35 : 0.7) * a);
          g.fillRect(p.x, p.y, size, size);
          if (p.big && a > 0.6) {
            g.fillRect(p.x - size, p.y, size, size);
            g.fillRect(p.x + size, p.y, size, size);
            g.fillRect(p.x, p.y - size, size, size);
            g.fillRect(p.x, p.y + size, size, size);
          }
        }
      },
    };
  },

  paper(g, C, { n, S }) {
    let bits = [];
    const tones = C.user.length ? C.user.map((c) => rgba(c, 1)) : ["#FFFFFF", "#FAF6EA", "#FFE14D", "#F3EDDC"];
    const make = (w, h, top) => ({ x: rand(0, w), y: top ? rand(-h * 0.2, -20) : rand(0, h), w: rand(8, 22) * S, h: rand(10, 28) * S, r: rand(0, 6.28), vr: rand(-0.0012, 0.0012), vy: rand(0.012, 0.032), sway: rand(0, 6.28), c: tones[(Math.random() * tones.length) | 0] });
    return {
      init(w, h) {
        bits = Array.from({ length: n(Math.min(40, Math.round((w * h) / 42000))) }, () => make(w, h, false));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const b of bits) {
          b.y += b.vy * dt;
          b.r += b.vr * dt;
          const x = b.x + Math.sin(t / 1400 + b.sway) * 26;
          if (b.y > h + 30 + b.h) Object.assign(b, make(w, h, true));
          g.save();
          g.translate(x, b.y);
          g.rotate(b.r);
          g.shadowColor = "rgba(0,0,0,0.12)";
          g.shadowBlur = 6;
          g.shadowOffsetY = 2;
          g.fillStyle = b.c;
          g.globalAlpha = 0.75;
          g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
          g.restore();
        }
      },
    };
  },

  dust(g, C, { n, S }) {
    let motes = [];
    const make = (w, h, bottom) => ({ x: rand(0, w), y: bottom ? h + rand(0, 40) : rand(0, h), r: Math.random() > 0.9 ? rand(6, 16) : rand(0.8, 2.4), vy: rand(0.006, 0.02), ph: rand(0, 6.28), f: rand(0.4, 1) });
    return {
      init(w, h) {
        motes = Array.from({ length: n(Math.min(120, Math.round((w * h) / 12000))) }, () => make(w, h, false));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const m of motes) {
          m.y -= m.vy * dt;
          if (m.y < -20 - m.r * 2 * S) Object.assign(m, make(w, h, true));
          const x = m.x + Math.sin(t / 2200 + m.ph) * 18;
          const a = (m.r > 5 ? 0.06 : 0.45) * m.f * (0.6 + 0.4 * Math.sin(t / 500 + m.ph));
          const r = m.r * S;
          const grad = g.createRadialGradient(x, m.y, 0, x, m.y, r * 2);
          grad.addColorStop(0, rgba(C.accent, a));
          grad.addColorStop(1, rgba(C.accent, 0));
          g.fillStyle = grad;
          g.beginPath();
          g.arc(x, m.y, r * 2, 0, 6.283);
          g.fill();
        }
      },
    };
  },

  bubbles(g, C, { n, S }) {
    let bs = [];
    const cols = C.pick([C.accent, C.accent2, C.up]);
    const make = (w, h, bottom) => {
      const r = rand(8, 42) * S;
      return { x: rand(0, w), y: bottom ? h + r + rand(12, 80) : rand(0, h), r, vy: rand(0.015, 0.045), ph: rand(0, 6.28), c: cols[(Math.random() * cols.length) | 0] };
    };
    return {
      init(w, h) {
        bs = Array.from({ length: n(Math.min(36, Math.round((w * h) / 36000))) }, () => make(w, h, false));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const b of bs) {
          b.y -= b.vy * dt;
          if (b.y < -b.r - 18) Object.assign(b, make(w, h, true));
          const x = b.x + Math.sin(t / 1600 + b.ph) * 20;
          g.fillStyle = rgba(b.c, 0.12);
          g.strokeStyle = rgba(b.c, 0.35);
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(x, b.y, b.r, 0, 6.283);
          g.fill();
          g.stroke();
          g.fillStyle = "rgba(255,255,255,0.55)";
          g.beginPath();
          g.arc(x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.18, 0, 6.283);
          g.fill();
        }
      },
    };
  },

  coderain(g, C, { n, S, o }) {
    const chars = "アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789$ABCDEF";
    let cols = [];
    const fs = Math.max(8, Math.round(16 * S));
    return {
      init(w, h) {
        // One drop per column at amount 1; more amount stacks drops per column, less leaves columns out.
        const k = Math.ceil(w / fs);
        cols = Array.from({ length: n(k) }, (_, i) => ({ x: (Math.floor(i / o.amount) % k) * fs, y: rand(-h, 0), v: rand(0.05, 0.14) }));
        g.clearRect(0, 0, w, h);
      },
      frame(t, dt, w, h) {
        g.fillStyle = rgba(C.bg, 0.12);
        g.fillRect(0, 0, w, h);
        g.font = `${fs}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace"}`;
        for (const c of cols) {
          c.y += c.v * dt;
          if (c.y > h + rand(0, 400)) c.y = rand(-200, 0);
          const ch = chars[(Math.random() * chars.length) | 0];
          g.fillStyle = rgba(C.accent, 0.85);
          g.fillText(ch, c.x, c.y);
          g.fillStyle = rgba(C.accent, 0.25);
          g.fillText(chars[(Math.random() * chars.length) | 0], c.x, c.y - fs);
        }
      },
    };
  },

  synthgrid(g, C, { n, S }) {
    let stars = [];
    return {
      init(w, h) {
        stars = Array.from({ length: n(120) }, () => ({ x: rand(0, w), y: rand(0, h * 0.55), z: rand(0.3, 1) }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        const horizon = h * 0.62;
        for (const s of stars) {
          g.fillStyle = rgba(C.fg, 0.25 * s.z);
          g.fillRect(s.x, s.y, 1.4 * s.z * S, 1.4 * s.z * S);
        }
        const sunR = Math.min(w, h) * Math.min(0.2 * S, 0.42);
        const sx = w * 0.5;
        const sy = horizon - sunR * 0.55;
        const sun = g.createLinearGradient(0, sy - sunR, 0, sy + sunR);
        sun.addColorStop(0, rgba(C.accent2, 0.9));
        sun.addColorStop(1, rgba(C.accent, 0.9));
        g.save();
        g.beginPath();
        g.arc(sx, sy, sunR, 0, 6.283);
        g.clip();
        g.fillStyle = sun;
        g.fillRect(sx - sunR, sy - sunR, sunR * 2, sunR * 2);
        g.globalCompositeOperation = "destination-out";
        for (let i = 0; i < 7; i++) {
          const yy = sy + sunR * (0.1 + i * 0.14);
          g.fillRect(sx - sunR, yy, sunR * 2, 2 + i * 1.4);
        }
        g.restore();
        const glow = g.createRadialGradient(sx, sy, sunR * 0.6, sx, sy, sunR * 2.4);
        glow.addColorStop(0, rgba(C.accent2, 0.25));
        glow.addColorStop(1, rgba(C.accent2, 0));
        g.fillStyle = glow;
        g.fillRect(0, 0, w, horizon);
        g.fillStyle = rgba(C.bg, 0.9);
        g.fillRect(0, horizon, w, h - horizon);
        g.strokeStyle = rgba(C.accent2, 0.55);
        g.lineWidth = 1;
        const off = (t * 0.00035) % 1;
        for (let i = 0; i < 18; i++) {
          const p = (i + off) / 18;
          const y = horizon + (h - horizon) * p * p;
          g.globalAlpha = p;
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(w, y);
          g.stroke();
        }
        g.globalAlpha = 1;
        for (let i = -20; i <= 20; i++) {
          g.beginPath();
          g.moveTo(sx + i * 18, horizon);
          g.lineTo(sx + i * w * 0.09, h);
          g.stroke();
        }
      },
    };
  },

  fireflies(g, C, { n, S }) {
    let flies = [];
    return {
      init(w, h) {
        flies = Array.from({ length: n(Math.min(90, Math.round((w * h) / 16000))) }, () => ({ x: rand(0, w), y: rand(0, h), vx: rand(-0.02, 0.02), vy: rand(-0.02, 0.02), ph: rand(0, 6.28), r: rand(1.2, 2.8) }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        g.globalCompositeOperation = "lighter";
        for (const f of flies) {
          f.vx += rand(-0.0006, 0.0006) * dt;
          f.vy += rand(-0.0006, 0.0006) * dt;
          f.vx = Math.max(-0.04, Math.min(0.04, f.vx));
          f.vy = Math.max(-0.04, Math.min(0.04, f.vy));
          f.x = (f.x + f.vx * dt + w) % w;
          f.y = (f.y + f.vy * dt + h) % h;
          const a = Math.max(0, Math.sin(t / 900 + f.ph));
          const r = f.r * S;
          const grad = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, r * 7);
          grad.addColorStop(0, rgba(C.accent, 0.9 * a));
          grad.addColorStop(0.25, rgba(C.accent, 0.3 * a));
          grad.addColorStop(1, rgba(C.accent, 0));
          g.fillStyle = grad;
          g.fillRect(f.x - r * 7, f.y - r * 7, r * 14, r * 14);
        }
        g.globalCompositeOperation = "source-over";
      },
    };
  },

  // Shapes floating across the page: paws, hearts, coins, candles, sparkles, fish, stars, dots, the logo, any image
  // in the site or a short text/emoji. Candles: the first color goes the chosen way, the second the other way.
  particles(g, C, env) {
    const { o, n, S } = env;
    const st = STYLE[o.shape] ?? STYLE.custom;
    const candle = o.shape === "candle";
    const cols = C.pick(candle ? [C.up, C.down] : [C.accent, C.accent2]);
    const drift = o.direction === "drift";
    const heading = HEADING[o.direction] ?? HEADING.up;
    let ps = [];
    const make = (w, h, p = {}, enter = false) => {
      const z = rand(0.5, 1);
      const ci = (Math.random() * cols.length) | 0;
      const v = rand(st.v[0], st.v[1]) * (0.55 + 0.45 * z);
      const way = candle && ci % 2 ? -1 : 1;
      const a = rand(0, 6.283);
      Object.assign(p, {
        ci,
        s: rand(st.s[0], st.s[1]) * z * S,
        al: rand(0.35, 0.75) * (0.6 + 0.4 * z),
        ph: rand(0, 6.283),
        sw: rand(5, 18),
        r: rand(-st.tilt, st.tilt),
        vr: rand(-1, 1) * st.spin,
        vx: drift ? Math.cos(a) * v * 0.6 : heading[0] * v * way,
        vy: drift ? Math.sin(a) * v * 0.6 : heading[1] * v * way,
        x: rand(0, w),
        y: rand(0, h),
      });
      // New arrivals come in from the edge they move away from.
      if (enter && Math.abs(p.vy) >= Math.abs(p.vx)) p.y = p.vy < 0 ? h + p.s : -p.s;
      else if (enter) p.x = p.vx < 0 ? w + p.s : -p.s;
      return p;
    };
    return {
      init(w, h) {
        ps = Array.from({ length: n(Math.min(st.max, (w * h) / st.per)) }, () => make(w, h));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        const imgs = cols.map((c) => shapeSprite(o.shape, c, env));
        const d = g.getTransform().a;
        for (const p of ps) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.r += p.vr * dt;
          const m = p.s;
          if (drift) {
            // wander: the heading turns a little every frame; the page wraps around
            const a = Math.atan2(p.vy, p.vx) + rand(-1, 1) * 0.0012 * dt;
            const v = Math.hypot(p.vx, p.vy);
            p.vx = Math.cos(a) * v;
            p.vy = Math.sin(a) * v;
            if (p.x < -m) p.x += w + m * 2;
            else if (p.x > w + m) p.x -= w + m * 2;
            if (p.y < -m) p.y += h + m * 2;
            else if (p.y > h + m) p.y -= h + m * 2;
          } else if (p.x < -m * 2 || p.x > w + m * 2 || p.y < -m * 2 || p.y > h + m * 2) make(w, h, p, true);
          const img = imgs[p.ci];
          if (!img) continue;
          const upright = Math.abs(p.vy) >= Math.abs(p.vx);
          const sway = drift ? 0 : Math.sin(t / 1400 + p.ph) * p.sw;
          const x = p.x + (upright ? sway : 0);
          const y = p.y + (upright ? 0 : sway * 0.5);
          let rot = p.r;
          let kx = 1;
          let ky = 1;
          if (st.face === "up") rot += Math.atan2(p.vy, p.vx) + Math.PI / 2;
          if (st.face === "right") {
            rot = Math.atan2(p.vy, p.vx) + Math.sin(t / 260 + p.ph) * 0.08;
            if (p.vx < 0) ky = -1; // swimming left: mirrored, not upside down
          }
          if (st.flip) kx = Math.cos(t / 420 + p.ph);
          if (st.twinkle) {
            const k = 0.7 + 0.3 * Math.sin(t / 380 + p.ph * 3);
            kx *= k;
            ky *= k;
          }
          const c = Math.cos(rot);
          const s = Math.sin(rot);
          g.globalAlpha = p.al;
          g.setTransform(d * c * kx, d * s * kx, -d * s * ky, d * c * ky, d * x, d * y);
          g.drawImage(img, -m / 2, -m / 2, m, m);
        }
        g.setTransform(d, 0, 0, d, 0, 0);
        g.globalAlpha = 1;
      },
    };
  },

  snow(g, C, { n, S, mode }) {
    let flakes = [];
    const cols = C.pick([C.fg]);
    const alpha = mode === "light" ? 0.38 : 0.8;
    const make = (w, h, top) => ({ x: rand(0, w), y: top ? rand(-30, -4) : rand(0, h), z: rand(0.25, 1), ph: rand(0, 6.28), c: any(cols) });
    return {
      init(w, h) {
        flakes = Array.from({ length: n(Math.min(260, (w * h) / 6000)) }, () => make(w, h, false));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const f of flakes) {
          f.y += (0.012 + 0.045 * f.z) * dt;
          f.x += Math.sin(t / 1800 + f.ph) * 0.012 * f.z * dt;
          if (f.y > h + 8) Object.assign(f, make(w, h, true));
          if (f.x < -8) f.x += w + 16;
          else if (f.x > w + 8) f.x -= w + 16;
          g.fillStyle = rgba(f.c, alpha * (0.35 + 0.65 * f.z));
          g.beginPath();
          g.arc(f.x, f.y, Math.max(0.5, (0.6 + 2.4 * f.z) * S), 0, 6.283);
          g.fill();
        }
      },
    };
  },

  embers(g, C, { n, S }) {
    let sparks = [];
    const cols = C.pick([C.accent, C.accent2]);
    const make = (w, h, fresh) => ({ x: rand(0, w), y: fresh ? h + rand(4, 40) : rand(h * 0.15, h), vx: rand(-0.012, 0.012), vy: -rand(0.03, 0.085), life: fresh ? 0 : rand(0, 0.8), span: rand(3500, 7500), r: rand(0.8, 2.4), ph: rand(0, 6.28), c: any(cols) });
    return {
      init(w, h) {
        sparks = Array.from({ length: n(Math.min(140, (w * h) / 10000)) }, () => make(w, h, false));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        g.globalCompositeOperation = "lighter";
        for (const e of sparks) {
          e.life += dt / e.span;
          e.vx = Math.max(-0.03, Math.min(0.03, e.vx + rand(-1, 1) * 0.00035 * dt));
          e.x += (e.vx + Math.sin(t / 700 + e.ph) * 0.008) * dt;
          e.y += e.vy * dt;
          if (e.life >= 1 || e.y < -30) Object.assign(e, make(w, h, true));
          const k = 1 - e.life;
          const R = e.r * S * (0.45 + 0.55 * k) * 7;
          g.globalAlpha = Math.min(1, k * 1.4) * (0.65 + 0.35 * Math.sin(t / 70 + e.ph * 7));
          g.drawImage(glowSprite(e.c), e.x - R, e.y - R, R * 2, R * 2);
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      },
    };
  },

  bokeh(g, C, { n, S, mode }) {
    let lights = [];
    const cols = C.pick([C.accent, C.accent2]);
    return {
      init(w, h) {
        lights = Array.from({ length: n(Math.min(30, (w * h) / 46000)) }, () => ({ x: rand(0, w), y: rand(0, h), r: rand(26, 110) * S, vx: rand(-0.012, 0.012), vy: rand(-0.01, 0.01), a: rand(0.06, 0.18), ph: rand(0, 6.28), c: any(cols) }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        if (mode !== "light") g.globalCompositeOperation = "lighter";
        for (const b of lights) {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          if (b.x < -b.r) b.x += w + b.r * 2;
          else if (b.x > w + b.r) b.x -= w + b.r * 2;
          if (b.y < -b.r) b.y += h + b.r * 2;
          else if (b.y > h + b.r) b.y -= h + b.r * 2;
          g.globalAlpha = b.a * (0.7 + 0.3 * Math.sin(t / 2600 + b.ph));
          g.drawImage(glowSprite(b.c, true), b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = "source-over";
      },
    };
  },

  constellation(g, C, { n, S }) {
    let pts = [];
    let px = null;
    let py = null;
    const cols = C.pick([C.accent, C.accent2]);
    const L = 150; // how close two stars must be to be joined
    const move = (e) => {
      px = e.clientX;
      py = e.clientY;
    };
    const out = (e) => {
      if (!e.relatedTarget) px = null;
    };
    addEventListener("pointermove", move, { passive: true });
    addEventListener("pointerout", out);
    return {
      init(w, h) {
        pts = Array.from({ length: n(Math.min(110, (w * h) / 13000)) }, () => ({ x: rand(0, w), y: rand(0, h), vx: rand(-0.02, 0.02), vy: rand(-0.02, 0.02), r: rand(1, 2.4), c: any(cols) }));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const p of pts) {
          if (px != null) {
            // gently drawn toward the pointer
            const dx = px - p.x;
            const dy = py - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < L * L * 1.7 && d2 > 900) {
              p.x += dx * 0.00005 * dt;
              p.y += dy * 0.00005 * dt;
            }
          }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.x < 0 || p.x > w) p.vx = -p.vx;
          if (p.y < 0 || p.y > h) p.vy = -p.vy;
          p.x = Math.max(0, Math.min(w, p.x));
          p.y = Math.max(0, Math.min(h, p.y));
        }
        g.lineWidth = 1;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          for (let j = i + 1; j < pts.length; j++) {
            const b = pts[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            if (dx > L || dx < -L || dy > L || dy < -L) continue;
            const d = Math.hypot(dx, dy);
            if (d > L) continue;
            g.strokeStyle = rgba(cols[0], 0.3 * (1 - d / L));
            g.beginPath();
            g.moveTo(a.x, a.y);
            g.lineTo(b.x, b.y);
            g.stroke();
          }
          if (px != null) {
            const d = Math.hypot(a.x - px, a.y - py);
            if (d < L * 1.3) {
              g.strokeStyle = rgba(cols[cols.length - 1], 0.5 * (1 - d / (L * 1.3)));
              g.beginPath();
              g.moveTo(a.x, a.y);
              g.lineTo(px, py);
              g.stroke();
            }
          }
        }
        for (const p of pts) {
          g.fillStyle = rgba(p.c, 0.85);
          g.beginPath();
          g.arc(p.x, p.y, Math.max(0.6, p.r * S), 0, 6.283);
          g.fill();
        }
      },
      stop() {
        removeEventListener("pointermove", move);
        removeEventListener("pointerout", out);
      },
    };
  },

  meteors(g, C, { n, S, o }) {
    let stars = [];
    let rocks = [];
    let wait = 0;
    const cols = C.pick([C.accent, C.accent2]);
    const spawn = (w, h, midway) => {
      const side = Math.random() < 0.5 ? 1 : -1;
      const a = rand(0.3, 0.55); // below the horizon line, left or right
      const v = rand(0.55, 1.05);
      const r = { x: rand(w * 0.1, w * 0.9), y: rand(-h * 0.05, h * 0.35), vx: Math.cos(a) * v * side, vy: Math.sin(a) * v, len: rand(120, 260) * S, life: 0, span: rand(900, 1500), wd: rand(1.3, 2.4), c: any(cols) };
      if (midway) {
        // one is already on its way, so even a still frame shows a shooting star
        r.life = rand(0.35, 0.55);
        r.x += r.vx * r.span * r.life * 0.5;
        r.y += r.vy * r.span * r.life * 0.5;
      }
      return r;
    };
    return {
      init(w, h) {
        stars = Array.from({ length: n(Math.min(220, (w * h) / 6500)) }, () => ({ x: rand(0, w), y: rand(0, h), z: rand(0.2, 1), t: rand(0, 6.28) }));
        rocks = [spawn(w, h, true)];
        wait = rand(800, 2400);
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        for (const s of stars) {
          g.fillStyle = rgba(C.fg, 0.12 + 0.4 * s.z * (0.6 + 0.4 * Math.sin(t / 900 + s.t)));
          const r = Math.max(0.6, s.z * 1.3 * S);
          g.fillRect(s.x, s.y, r, r);
        }
        wait -= dt;
        if (wait <= 0) {
          rocks.push(spawn(w, h, false));
          wait = rand(900, 3600) / o.amount;
        }
        rocks = rocks.filter((r) => (r.life += dt / r.span) < 1);
        g.lineCap = "round";
        for (const r of rocks) {
          r.x += r.vx * dt;
          r.y += r.vy * dt;
          const fade = Math.sin(Math.PI * r.life);
          const v = Math.hypot(r.vx, r.vy);
          const tx = r.x - (r.vx / v) * r.len;
          const ty = r.y - (r.vy / v) * r.len;
          const tail = g.createLinearGradient(r.x, r.y, tx, ty);
          tail.addColorStop(0, rgba(r.c, 0.9 * fade));
          tail.addColorStop(1, rgba(r.c, 0));
          g.strokeStyle = tail;
          g.lineWidth = r.wd * S;
          g.beginPath();
          g.moveTo(tx, ty);
          g.lineTo(r.x, r.y);
          g.stroke();
          const R = r.wd * 5 * S;
          g.globalAlpha = fade;
          g.drawImage(glowSprite(r.c), r.x - R, r.y - R, R * 2, R * 2);
          g.globalAlpha = 1;
          g.fillStyle = rgba(C.fg, 0.95 * fade);
          g.beginPath();
          g.arc(r.x, r.y, Math.max(0.8, r.wd * 0.8 * S), 0, 6.283);
          g.fill();
        }
      },
    };
  },

  confetti(g, C, { n, S }) {
    let bits = [];
    const cols = C.pick([C.accent, C.accent2, C.up]);
    const make = (w, h, top) => ({ x: rand(0, w), y: top ? rand(-60, -10) : rand(0, h), w: rand(6, 11) * S, h: rand(9, 16) * S, r: rand(0, 6.28), vr: rand(-0.003, 0.003), vy: rand(0.03, 0.075), ph: rand(0, 6.28), fl: rand(0.003, 0.008), c: any(cols), dot: Math.random() < 0.2 });
    return {
      init(w, h) {
        bits = Array.from({ length: n(Math.min(90, (w * h) / 15000)) }, () => make(w, h, false));
      },
      frame(t, dt, w, h) {
        g.clearRect(0, 0, w, h);
        const d = g.getTransform().a;
        for (const b of bits) {
          b.y += b.vy * dt;
          b.r += b.vr * dt;
          if (b.y > h + 20 + b.h) Object.assign(b, make(w, h, true));
          const x = b.x + Math.sin(t / 1100 + b.ph) * 26;
          const flutter = Math.cos(t * b.fl + b.ph); // the piece turns over as it falls
          const c = Math.cos(b.r);
          const s = Math.sin(b.r);
          g.setTransform(d * c, d * s, -d * s * flutter, d * c * flutter, d * x, d * b.y);
          g.fillStyle = rgba(b.c, 0.85);
          if (b.dot) {
            g.beginPath();
            g.arc(0, 0, b.w * 0.45, 0, 6.283);
            g.fill();
          } else g.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        }
        g.setTransform(d, 0, 0, d, 0, 0);
      },
    };
  },
};

export const EFFECT_NAMES = [...Object.keys(EFFECTS), ...Object.keys(SHAPE_EFFECTS).filter((k) => !EFFECTS[k])];

/**
 * Starts an effect on the canvas and returns a function that stops it. `options` are the config's look.effect
 * options (anything missing gets its default); `data` is the page's runtime data (for the logo).
 */
export function startFx(canvas, name, { reduced = false, options = {}, data = {} } = {}) {
  const make = EFFECTS[name] ?? (SHAPE_EFFECTS[name] ? EFFECTS.particles : null);
  if (!make) return () => {};
  const o = effectDefaults(name);
  for (const [k, v] of Object.entries(options ?? {})) if (v != null && k in o) o[k] = v;
  const g = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const user = (o.colors ?? []).map((c) => parseColor(c, null)).filter(Boolean);
  const C = {
    accent: parseColor(css.getPropertyValue("--accent")),
    accent2: parseColor(css.getPropertyValue("--accent-2")),
    fg: parseColor(css.getPropertyValue("--fg")),
    bg: parseColor(css.getPropertyValue("--bg"), [0, 0, 0]),
    up: parseColor(css.getPropertyValue("--up")),
    down: parseColor(css.getPropertyValue("--down")),
    user,
    /** The effect's own theme palette, or the config's colors when it sets some. */
    pick: (palette) => (user.length ? user : palette),
  };
  if (user.length) {
    C.accent = user[0];
    C.accent2 = user[1] ?? user[0];
  }
  const root = new URL("../../", import.meta.url); // the site's root: this file is engine/modules/fx.js
  let w = 0;
  let h = 0;
  let stopped = false;
  const env = {
    mode: document.documentElement.dataset.mode,
    o,
    S: o.size,
    n: (count) => Math.max(1, Math.round(count * o.amount)),
    url: (path) => new URL(path, root).href,
    logo: data?.images?.logo ? new URL(data.images.logo, root).href : "",
    // an image shape finished loading: a still (reduced-motion) frame is drawn again with it
    ready: () => !stopped && reduced && fx.frame(0, 16, w, h),
  };
  const fx = make(g, C, env);
  canvas.style.opacity = o.opacity < 1 ? String(o.opacity) : "";
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = innerWidth;
    h = innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    fx.init(w, h);
  };
  resize();
  let raf = 0;
  let last = performance.now();
  let clock = last; // effect time: runs faster or slower with the speed option
  const loop = (now) => {
    const dt = Math.min(64, now - last) * o.speed;
    last = now;
    clock += dt;
    fx.frame(clock, dt, w, h);
    raf = requestAnimationFrame(loop);
  };
  const onVisibility = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden && !stopped) {
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  };
  if (reduced) {
    fx.frame(0, 16, w, h);
  } else {
    raf = requestAnimationFrame(loop);
    document.addEventListener("visibilitychange", onVisibility);
  }
  let rt = 0;
  const onResize = () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (innerWidth === w && Math.abs(innerHeight - h) < 160) return;
      resize();
      if (reduced) fx.frame(0, 16, w, h);
    }, 150);
  };
  addEventListener("resize", onResize);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearTimeout(rt);
    document.removeEventListener("visibilitychange", onVisibility);
    removeEventListener("resize", onResize);
    fx.stop?.();
  };
}
