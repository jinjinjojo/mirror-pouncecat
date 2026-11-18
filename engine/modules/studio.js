// Owner-only design panel: open the site with ?studio. Switch theme, background effect (and its options), animations,
// cursor and accent colors live, preview the launched state, then copy the settings into coin.config.js.
import { startFx, EFFECT_NAMES, SHAPES, DIRECTIONS, effectDefaults } from "./fx.js";

/** Everything the panel offers (the same values the build accepts, see lib/themes.mjs). */
export const CHOICES = {
  effects: [...EFFECT_NAMES, "none"],
  shapes: SHAPES,
  directions: DIRECTIONS,
  cursors: ["glow", "trail", "sparkle", "none"],
  animation: {
    title: ["rise", "wave", "glitch", "typewriter", "none"],
    reveal: ["rise", "fade", "zoom", "blur", "none"],
    mascot: ["float", "bob", "wiggle", "pulse", "none"],
  },
};
const ANIM_DEFAULTS = Object.fromEntries(Object.entries(CHOICES.animation).map(([k, list]) => [k, list[0]]));
const HEX = /^#[0-9a-f]{6}$/i;

/** A value written as JavaScript for coin.config.js: quoted strings, objects with bare keys. */
function js(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(js).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${js(x)}`).join(", ")} }`;
  return String(v);
}

/**
 * The panel's settings as lines to paste into coin.config.js. The effect is a plain name unless an option differs
 * from its default; animation, loader and motion only appear when they aren't the defaults.
 */
export function configSnippet(s) {
  const defaults = effectDefaults(s.effect);
  const o = s.options ?? {};
  const changed = {};
  for (const k of ["shape", "direction"]) if (o[k] != null && o[k] !== defaults[k]) changed[k] = o[k];
  if (o.colors?.length) changed.colors = o.colors;
  for (const k of ["amount", "speed", "size", "opacity"]) if (o[k] != null && o[k] !== defaults[k]) changed[k] = o[k];
  const look = {
    effect: Object.keys(changed).length ? { type: s.effect, ...changed } : s.effect,
    cursor: s.cursor === "image" && s.cursorOptions ? { image: s.cursorOptions.image, size: s.cursorOptions.size } : s.cursor,
  };
  if (HEX.test(s.accent ?? "")) look.accent = s.accent;
  if (HEX.test(s.accent2 ?? "")) look.accent2 = s.accent2;
  const animation = Object.fromEntries(Object.entries(s.animation ?? {}).filter(([k, v]) => k in ANIM_DEFAULTS && v !== ANIM_DEFAULTS[k]));
  if (Object.keys(animation).length) look.animation = animation;
  if (s.loader != null && s.loader !== true) look.loader = s.loader;
  if (s.motion && s.motion !== "full") look.motion = s.motion;
  return `theme: ${js(s.theme)},\nlook: {\n${Object.entries(look)
    .map(([k, v]) => `  ${k}: ${js(v)},`)
    .join("\n")}\n},`;
}

/** #RRGGBB for a color input, from #RGB, #RRGGBB or rgb(). */
function toHex(c) {
  c = String(c ?? "").trim();
  if (HEX.test(c)) return c;
  const short = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = c.match(/rgba?\(([^)]+)\)/i);
  if (rgb) return `#${rgb[1].split(/[ ,/]+/).slice(0, 3).map((x) => Math.round(Number(x)).toString(16).padStart(2, "0")).join("")}`;
  return "#ffffff";
}

const options = (list, labels = {}) => list.map((v) => `<option value="${v}">${labels[v] ?? v}</option>`).join("");
const slider = (k, label, min, max, step) =>
  `<label><span class="studio__value">${label}<output data-v="${k}"></output></span><input type="range" data-o="${k}" min="${min}" max="${max}" step="${step}"></label>`;

export async function openStudio(ctx) {
  const { data } = ctx;
  let themes = {};
  try {
    themes = await (await fetch("engine/themes/index.json")).json();
  } catch {}
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const shapes = [...CHOICES.shapes, ...(data.images?.logo ? ["logo"] : [])];
  const state = {
    theme: data.theme,
    effect: data.look?.effect ?? "none",
    options: { ...effectDefaults(data.look?.effect), ...data.look?.effectOptions },
    cursor: data.look?.cursor ?? "none",
    cursorOptions: data.look?.cursorOptions ?? null,
    accent: css.getPropertyValue("--accent").trim(),
    accent2: css.getPropertyValue("--accent-2").trim(),
    animation: { title: root.dataset.animTitle || "rise", reveal: root.dataset.animReveal || "rise", mascot: root.dataset.animMascot || "float" },
    loader: data.look?.loader ?? true,
    motion: data.look?.motion ?? "full",
  };

  const panel = document.createElement("aside");
  panel.className = "studio";
  panel.innerHTML = `
    <button type="button" class="studio__close" aria-label="Close studio">✕</button>
    <h2>Studio</h2>
    <label>Theme<select data-k="theme">${Object.entries(themes).map(([id, t]) => `<option value="${id}">${t.label} (${t.mode})</option>`).join("")}</select></label>
    <h3>Background</h3>
    <div class="studio__row">
      <label>Effect<select data-k="effect">${options(CHOICES.effects)}</select></label>
      <label>Direction<select data-o="direction">${options(CHOICES.directions)}</select></label>
    </div>
    <div class="studio__row">
      <label>Shape<select data-o="shape">${options([...shapes, "custom"], { custom: "text or image…" })}</select></label>
      <label>Text or image<input type="text" data-o="custom" placeholder="🐾 or images/paw.svg" maxlength="80"></label>
    </div>
    <div class="studio__row">${slider("amount", "Amount", 0.1, 4, 0.1)}${slider("speed", "Speed", 0.1, 4, 0.1)}</div>
    <div class="studio__row">${slider("size", "Size", 0.1, 4, 0.1)}${slider("opacity", "Opacity", 0, 1, 0.05)}</div>
    <div class="studio__row">
      <label>Color 1<input type="color" data-c="0"></label>
      <label>Color 2<input type="color" data-c="1"></label>
    </div>
    <button type="button" class="studio__ghost" data-act="theme-colors">Use the theme's colors</button>
    <h3>Motion</h3>
    <div class="studio__row studio__row--3">
      <label>Title<select data-a="title">${options(CHOICES.animation.title)}</select></label>
      <label>Reveal<select data-a="reveal">${options(CHOICES.animation.reveal)}</select></label>
      <label>Mascot<select data-a="mascot">${options(CHOICES.animation.mascot)}</select></label>
    </div>
    <label>Cursor<select data-k="cursor">${options([...CHOICES.cursors, ...(state.cursorOptions ? ["image"] : [])])}</select></label>
    <h3>Colors</h3>
    <div class="studio__row">
      <label>Accent<input type="color" data-k="accent"></label>
      <label>Accent 2<input type="color" data-k="accent2"></label>
    </div>
    ${data.launched ? "" : '<button type="button" data-act="launched">Preview the launched state</button>'}
    <label>Paste into coin.config.js<textarea readonly data-out></textarea></label>
    <button type="button" data-act="copy">Copy settings</button>`;
  document.body.append(panel);
  const $ = (sel) => panel.querySelector(sel);
  const out = $("[data-out]");

  /** The colors an effect uses when the config sets none: accent and accent 2, or up and down for candles. */
  const themeColors = () => {
    const cs = getComputedStyle(root);
    const names = state.options.shape === "candle" ? ["--up", "--down"] : ["--accent", "--accent-2"];
    return names.map((n) => cs.getPropertyValue(n).trim());
  };

  /** Shows the state in every control except the one being edited. */
  function sync(editing = null) {
    const set = (el, v) => el !== editing && (el.value = v);
    set($('[data-k="theme"]'), state.theme);
    set($('[data-k="effect"]'), state.effect);
    set($('[data-k="cursor"]'), state.cursor);
    const shaped = state.options.shape != null;
    const shape = state.options.shape ?? "dot";
    const custom = !shapes.includes(shape);
    set($('[data-o="direction"]'), state.options.direction ?? "up");
    set($('[data-o="shape"]'), custom ? "custom" : shape);
    set($('[data-o="custom"]'), custom ? shape : "");
    $('[data-o="direction"]').disabled = !shaped;
    $('[data-o="shape"]').disabled = !shaped;
    $('[data-o="custom"]').disabled = !shaped || $('[data-o="shape"]').value !== "custom";
    for (const k of ["amount", "speed", "size", "opacity"]) {
      set($(`[data-o="${k}"]`), state.options[k]);
      $(`[data-v="${k}"]`).textContent = state.options[k];
    }
    const theme = themeColors();
    panel.querySelectorAll("[data-c]").forEach((el, i) => set(el, toHex(state.options.colors[i] ?? state.options.colors[0] ?? theme[i])));
    for (const k of Object.keys(ANIM_DEFAULTS)) set($(`[data-a="${k}"]`), state.animation[k]);
    set($('[data-k="accent"]'), toHex(state.accent));
    set($('[data-k="accent2"]'), toHex(state.accent2));
    out.value = configSnippet(state);
  }

  function restartFx() {
    ctx.stopFx?.();
    ctx.stopFx = null;
    const old = document.querySelector("[data-fx]");
    if (!old) return;
    const fresh = old.cloneNode();
    old.replaceWith(fresh);
    root.dataset.effect = state.effect;
    if (state.effect !== "none") ctx.stopFx = startFx(fresh, state.effect, { reduced: false, options: state.options, data });
  }
  let pending = 0;
  const restartSoon = () => {
    clearTimeout(pending);
    pending = setTimeout(restartFx, 150);
  };

  async function restartCursor() {
    ctx.stopCursor?.();
    ctx.stopCursor = null;
    root.dataset.cursor = state.cursor;
    if (state.cursor === "none" || !matchMedia("(pointer: fine)").matches) return;
    const { startCursor } = await import("./cursor.js");
    ctx.stopCursor = startCursor(state.cursor, { options: state.cursorOptions });
  }

  /** Plays an animation preset again so the change can be seen. */
  function replay(kind) {
    if (kind === "title") {
      const h = document.querySelector('[data-split="chars"].is-split');
      if (!h) return;
      const letters = [...h.querySelectorAll(".split-c")];
      letters.forEach((l) => (l.style.transition = "none"));
      h.classList.remove("is-in", "is-in-now");
      void h.offsetWidth;
      letters.forEach((l) => (l.style.transition = ""));
      setTimeout(() => h.classList.add("is-in", "is-in-now"), 60);
    }
    if (kind === "reveal" && root.classList.contains("reveal-on")) {
      const shown = [...document.querySelectorAll("[data-reveal].is-in")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight;
      });
      shown.forEach((el) => el.classList.remove("is-in"));
      void document.body.offsetWidth;
      requestAnimationFrame(() => shown.forEach((el) => el.classList.add("is-in")));
    }
  }

  async function applyTheme(id) {
    const t = themes[id];
    if (!t) return;
    const link = document.querySelector('link[href*="engine/themes/"]');
    const next = link.cloneNode();
    next.href = `engine/themes/${id}.css`;
    next.onload = () => link.remove();
    link.after(next);
    if (t.fontsUrl && !document.querySelector(`link[href="${t.fontsUrl}"]`)) {
      document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: t.fontsUrl }));
    }
    root.dataset.theme = id;
    root.dataset.mode = t.mode;
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-2");
    await new Promise((r) => setTimeout(r, 120));
    const cs = getComputedStyle(root);
    state.accent = cs.getPropertyValue("--accent").trim();
    state.accent2 = cs.getPropertyValue("--accent-2").trim();
    state.effect = t.effect;
    state.options = effectDefaults(t.effect);
    state.cursor = t.cursor;
    restartFx();
    await restartCursor();
  }

  panel.addEventListener("input", async (e) => {
    const el = e.target;
    const { k, o, c, a } = el.dataset;
    if (k === "theme") await applyTheme(el.value);
    if (k === "effect") {
      // A new effect keeps the colors, amount, speed, size and opacity; shape and direction are its own.
      const { shape, direction } = effectDefaults(el.value);
      state.effect = el.value;
      state.options = { ...state.options, shape, direction };
      restartFx();
    }
    if (k === "cursor") {
      state.cursor = el.value;
      await restartCursor();
    }
    if (k === "accent" || k === "accent2") {
      state[k] = el.value;
      root.style.setProperty(k === "accent" ? "--accent" : "--accent-2", el.value);
      if (!state.options.colors.length) restartSoon();
    }
    if (o === "shape") state.options.shape = el.value === "custom" ? $('[data-o="custom"]').value.trim() || effectDefaults(state.effect).shape : el.value;
    if (o === "custom") state.options.shape = el.value.trim() || effectDefaults(state.effect).shape;
    if (o === "direction") state.options.direction = el.value;
    if (["amount", "speed", "size", "opacity"].includes(o)) state.options[o] = Math.round(Number(el.value) * 100) / 100;
    if (o) restartSoon();
    if (c != null) {
      state.options.colors = [...panel.querySelectorAll("[data-c]")].map((x) => x.value);
      restartSoon();
    }
    if (a) {
      state.animation[a] = el.value;
      root.dataset[`anim${a[0].toUpperCase()}${a.slice(1)}`] = el.value;
      replay(a);
    }
    sync(el);
  });
  panel.addEventListener("click", async (e) => {
    if (e.target.closest(".studio__close")) panel.remove();
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "theme-colors") {
      state.options.colors = [];
      restartFx();
      sync();
    }
    if (act === "copy") {
      out.select();
      try {
        await navigator.clipboard.writeText(out.value);
      } catch {}
    }
    if (act === "launched") location.href = `preview-launched.html?studio`;
  });
  sync();
}
