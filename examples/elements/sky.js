// <x-sky>: a heliostat's sky for TesserUI (DESIGN.md §9.8), grown out of
// <x-sun-dial>. Seen from above, horizon at the edge and zenith in the
// middle: the sun, the target a click (or the arrow keys) sets, the mirror
// normal between them, and named directions.
//
//   auto& sky = api.object("sky").ui("widget", "x-sky").ui("script", "/ext/sky.js");
//   sky.value("sunAz", ...); sky.value("sunEl", ...);                 // degrees
//   sky.value("targetAz", targetAz).range(0, 360); sky.value("targetEl", targetEl).range(0, 90);
//   sky.value("normalAz", ...); sky.value("normalEl", ...);           // optional: else computed
//   sky.list("sources", sources).key("name");                         // optional: {name, azimuth, elevation}
//
// A mirror reflecting the sun onto the target faces the bisector of the two
// directions; the element computes it when the node doesn't say. Clicking a
// named direction aims the target at it.

const R = 100;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Unit vector (east, north, up) of an azimuth and an elevation.
function vec(az, el) {
  return [Math.cos(rad(el)) * Math.sin(rad(az)), Math.cos(rad(el)) * Math.cos(rad(az)), Math.sin(rad(el))];
}

export function bisector(sunAz, sunEl, targetAz, targetEl) {
  const a = vec(sunAz, sunEl);
  const b = vec(targetAz, targetEl);
  const n = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const len = Math.hypot(...n) || 1;
  return { az: (deg(Math.atan2(n[0], n[1])) + 360) % 360, el: deg(Math.asin(n[2] / len)) };
}

class Sky extends HTMLElement {
  #value = {};
  #disabled = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host { display: block; max-width: 360px; margin: 0 auto; outline: none; }
        :host([disabled]) { opacity: .5; pointer-events: none; }
        :host(:focus-visible) svg { outline: 2px solid var(--accent, #2f5bd3); border-radius: 50%; }
        svg { width: 100%; display: block; cursor: crosshair; touch-action: none; }
        .dome { fill: var(--surface-2, #eceef2); stroke: var(--border, #d9dde3); }
        .ring { fill: none; stroke: var(--border, #d9dde3); stroke-dasharray: 2 3; }
        .sun { fill: #f5b400; stroke: #f5b40066; stroke-width: 6; }
        .target { fill: none; stroke: var(--accent, #2f5bd3); stroke-width: 2.5; }
        .normal { fill: var(--ok, #1f9d55); }
        .ray { stroke: var(--muted, #5d6675); stroke-dasharray: 3 3; stroke-width: 1; }
        .source { fill: var(--muted, #5d6675); cursor: pointer; }
        text { fill: var(--muted, #5d6675); font: 9px system-ui, sans-serif; text-anchor: middle; }
        p { margin: 6px 0 0; text-align: center; color: var(--muted, #5d6675); font-size: .9em; font-variant-numeric: tabular-nums; }
      </style>
      <svg viewBox="-112 -112 224 224" role="img">
        <circle class="dome" r="${R}" />
        <circle class="ring" r="${R / 3}" /><circle class="ring" r="${(2 * R) / 3}" />
        <text y="-102">N</text><text x="106" y="3">E</text><text y="109">S</text><text x="-106" y="3">W</text>
        <g class="sources"></g>
        <line class="ray sun-ray" /><line class="ray target-ray" />
        <circle class="sun" r="7" />
        <g class="target"><circle r="9" /><path d="M-14 0h8M6 0h8M0 -14v8M0 6v8" /></g>
        <path class="normal" d="M0 -6L6 0 0 6-6 0z" />
      </svg>
      <p></p>`;
    const svg = this.shadowRoot.querySelector('svg');
    svg.addEventListener('pointerdown', (e) => this.#aim(e, svg));
    this.addEventListener('keydown', (e) => this.#key(e));
  }

  connectedCallback() {
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }

  set value(v) {
    this.#value = v ?? {};
    this.#draw();
  }
  get value() {
    return this.#value;
  }
  set disabled(d) {
    this.#disabled = !!d;
    this.toggleAttribute('disabled', this.#disabled);
  }
  get disabled() {
    return this.#disabled;
  }

  #xy(az, el) {
    const r = R * (1 - Math.max(0, Math.min(90, el)) / 90);
    return [r * Math.sin(rad(az)), -r * Math.cos(rad(az))];
  }
  #place(sel, az, el) {
    const [x, y] = this.#xy(az, el);
    this.shadowRoot.querySelector(sel).setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    return [x, y];
  }

  #draw() {
    const v = this.#value;
    const { sunAz = 0, sunEl = 0, targetAz = 0, targetEl = 0 } = v;
    const n = typeof v.normalAz === 'number' ? { az: v.normalAz, el: v.normalEl ?? 0 } : bisector(sunAz, sunEl, targetAz, targetEl);
    const root = this.shadowRoot;
    const sun = this.#place('.sun', sunAz, sunEl);
    root.querySelector('.sun').style.display = sunEl < 0 ? 'none' : '';
    const target = this.#place('.target', targetAz, targetEl);
    const normal = this.#place('.normal', n.az, n.el);
    for (const [cls, p] of [['.sun-ray', sun], ['.target-ray', target]]) {
      const l = root.querySelector(cls);
      l.setAttribute('x1', normal[0]);
      l.setAttribute('y1', normal[1]);
      l.setAttribute('x2', p[0]);
      l.setAttribute('y2', p[1]);
    }
    const sources = Array.isArray(v.sources) ? v.sources : [];
    root.querySelector('.sources').innerHTML = sources
      .map((s, i) => {
        const [x, y] = this.#xy(Number(s.azimuth), Number(s.elevation));
        const name = String(s.name ?? i).replace(/[<&]/g, '');
        return `<g data-i="${i}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle class="source" r="4"/><text y="-7">${name}</text></g>`;
      })
      .join('');
    const text = `Sun ${Math.round(sunAz)}° / ${Math.round(sunEl)}° · target ${Math.round(targetAz)}° / ${Math.round(targetEl)}° · mirror ${Math.round(n.az)}° / ${Math.round(n.el)}°`;
    root.querySelector('p').textContent = text;
    root.querySelector('svg').setAttribute('aria-label', text);
  }

  #set(az, el) {
    const targetAz = Math.round(((az % 360) + 360) % 360);
    const targetEl = Math.round(Math.max(0, Math.min(90, el)));
    this.tesser?.set('', { targetAz, targetEl });
  }

  #aim(e, svg) {
    if (this.#disabled) return;
    const source = e.target.closest?.('[data-i]');
    if (source) {
      const s = this.#value.sources[Number(source.dataset.i)];
      return this.#set(Number(s.azimuth), Number(s.elevation));
    }
    const box = svg.getBoundingClientRect();
    const scale = 224 / box.width;
    const x = (e.clientX - box.left) * scale - 112;
    const y = (e.clientY - box.top) * scale - 112;
    const r = Math.min(R, Math.hypot(x, y));
    this.#set(deg(Math.atan2(x, -y)), 90 * (1 - r / R));
  }

  #key(e) {
    const step = e.shiftKey ? 15 : 5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d || this.#disabled) return;
    e.preventDefault();
    const { targetAz = 0, targetEl = 0 } = this.#value;
    this.#set(targetAz + d[0], targetEl + d[1]);
  }
}

customElements.define('x-sky', Sky);
