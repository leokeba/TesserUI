// <x-keyframes>: a keyframe editor for TesserUI (DESIGN.md §9.8), such as
// helionext's axis sequencers. It draws an object whose lists of
// {t, value} frames are curves over time: one curve per list.
//
//   auto& seq = api.object("sequence").ui("widget", "x-keyframes").ui("script", "/ext/keyframes.js");
//   seq.list("frames", frames).maxSize(16);    // describe(Object&, Frame&): t (ms), value
//   seq.value("loop", loop);                   // optional
//   seq.value("running", [] { ... });          // optional: the playhead moves while true
//   seq.value("position", [] { ... }).watch(); // optional: the playhead's time (ms)
//   seq.action("start", ...); seq.action("stop", ...); seq.action("clear", ...);   // optional buttons
//
// A click on empty space adds a frame to the selected curve, dragging moves
// one, a double click (or Delete on the selected frame) removes it. Each edit
// writes the whole list. Values are bounded by the frames' `value` range,
// when the schema declares one. Without `position`, the playhead runs from
// the moment `running` turns true.

const W = 400;
const H = 160;
const PAD = 14;
const COLORS = ['var(--accent, #2f5bd3)', '#e07a1f', '#1f9d55', '#c62f2f'];

class Keyframes extends HTMLElement {
  #value = {};
  #schema = null;
  #disabled = false;
  #series = 0; // the curve edits go to
  #selected = -1;
  #drag = null; // { series, index }
  #startedAt = 0; // local clock, when `running` turned true
  #raf = 0;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host { display: block; outline: none; }
        :host([disabled]) { opacity: .5; pointer-events: none; }
        svg { width: 100%; display: block; touch-action: none; background: var(--surface-2, #eceef2); border-radius: 6px; cursor: crosshair; }
        .grid { stroke: var(--border, #d9dde3); stroke-dasharray: 2 3; }
        .curve { fill: none; stroke-width: 2; }
        .frame { stroke: var(--surface, #fff); stroke-width: 1.5; cursor: grab; }
        .frame.sel { stroke: var(--text, #1a1d23); stroke-width: 2; }
        .head { stroke: var(--danger, #c62f2f); stroke-width: 1.5; }
        text { fill: var(--muted, #5d6675); font: 9px system-ui, sans-serif; }
        .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
        .bar label { display: flex; gap: 4px; align-items: center; color: var(--muted, #5d6675); }
        button, select { font: inherit; color: var(--text, #1a1d23); background: var(--surface, #fff); border: 1px solid var(--border, #d9dde3); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
        input { accent-color: var(--accent, #2f5bd3); }
        .info { margin-left: auto; color: var(--muted, #5d6675); font-variant-numeric: tabular-nums; }
      </style>
      <svg viewBox="0 0 ${W} ${H}" role="img"></svg>
      <div class="bar"></div>`;
    const svg = this.shadowRoot.querySelector('svg');
    svg.addEventListener('pointerdown', (e) => this.#down(e, svg));
    svg.addEventListener('pointermove', (e) => this.#move(e, svg));
    svg.addEventListener('pointerup', () => this.#up());
    svg.addEventListener('dblclick', (e) => this.#remove(e, svg));
    this.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.#selected >= 0) this.#erase(this.#series, this.#selected);
    });
  }

  connectedCallback() {
    if (!this.hasAttribute('tabindex')) this.tabIndex = 0;
  }
  disconnectedCallback() {
    cancelAnimationFrame(this.#raf);
  }

  set value(v) {
    const was = !!this.#value.running;
    this.#value = v ?? {};
    if (this.#value.running && !was) this.#startedAt = performance.now();
    this.#draw();
  }
  get value() {
    return this.#value;
  }
  set schema(s) {
    this.#schema = s;
    this.#bar();
    this.#draw();
  }
  get schema() {
    return this.#schema;
  }
  set disabled(d) {
    this.#disabled = !!d;
    this.toggleAttribute('disabled', this.#disabled);
  }
  get disabled() {
    return this.#disabled;
  }

  // The children that are lists of {t, value}.
  #names() {
    const c = this.#schema?.children ?? {};
    return Object.keys(c).filter((k) => c[k].type === 'list' && c[k].items?.children?.t && c[k].items?.children?.value);
  }
  #frames(name) {
    const f = this.#value[name];
    return Array.isArray(f) ? f.map((x) => ({ t: Number(x.t), value: Number(x.value) })) : [];
  }
  // Time and value spans, from the schema's ranges and the frames.
  #span() {
    let tMax = 1000;
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of this.#names()) {
      const v = this.#schema.children[n].items.children.value;
      if (v.min !== undefined) lo = Math.min(lo, v.min);
      if (v.max !== undefined) hi = Math.max(hi, v.max);
      for (const f of this.#frames(n)) {
        tMax = Math.max(tMax, f.t);
        lo = Math.min(lo, f.value);
        hi = Math.max(hi, f.value);
      }
    }
    if (Number(this.#value.duration) > tMax) tMax = Number(this.#value.duration);
    if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
    if (hi === lo) (hi += 1), (lo -= 1);
    return { tMax: tMax * 1.1, lo, hi };
  }
  #xy(f, s) {
    return [PAD + (f.t / s.tMax) * (W - 2 * PAD), H - PAD - ((f.value - s.lo) / (s.hi - s.lo)) * (H - 2 * PAD)];
  }
  #point(e, svg) {
    const b = svg.getBoundingClientRect();
    const s = this.#span();
    const x = ((e.clientX - b.left) / b.width) * W;
    const y = ((e.clientY - b.top) / b.height) * H;
    return {
      t: Math.max(0, Math.round(((x - PAD) / (W - 2 * PAD)) * s.tMax)),
      value: Math.round((s.lo + ((H - PAD - y) / (H - 2 * PAD)) * (s.hi - s.lo)) * 100) / 100,
      x,
      y,
    };
  }
  #hit(p) {
    const s = this.#span();
    const names = this.#names();
    for (let k = 0; k < names.length; k++) {
      const frames = this.#frames(names[k]);
      for (let i = 0; i < frames.length; i++) {
        const [x, y] = this.#xy(frames[i], s);
        if (Math.hypot(x - p.x, y - p.y) < 8) return { series: k, index: i };
      }
    }
    return null;
  }

  #write(k, frames) {
    const name = this.#names()[k];
    const v = this.#schema.children[name].items.children.value;
    const clamp = (x) => Math.min(v.max ?? Infinity, Math.max(v.min ?? -Infinity, x));
    const sorted = frames.map((f) => ({ t: f.t, value: clamp(f.value) })).sort((a, b) => a.t - b.t);
    this.#value = { ...this.#value, [name]: sorted };
    this.#draw();
    this.tesser?.set(name, sorted, true);
  }
  #erase(k, i) {
    const frames = this.#frames(this.#names()[k]);
    frames.splice(i, 1);
    this.#selected = -1;
    this.#write(k, frames);
  }

  #down(e, svg) {
    if (this.#disabled || !this.#names().length) return;
    const p = this.#point(e, svg);
    const hit = this.#hit(p);
    if (hit) {
      this.#series = hit.series;
      this.#selected = hit.index;
      this.#drag = hit;
      svg.setPointerCapture(e.pointerId);
      this.#draw();
      return;
    }
    const name = this.#names()[this.#series];
    const max = this.#schema.children[name].maxSize;
    const frames = this.#frames(name);
    if (max !== undefined && frames.length >= max) return;
    frames.push({ t: p.t, value: p.value });
    this.#write(this.#series, frames);
  }
  #move(e, svg) {
    if (!this.#drag) return;
    const p = this.#point(e, svg);
    const frames = this.#frames(this.#names()[this.#drag.series]);
    frames[this.#drag.index] = { t: p.t, value: p.value };
    // Sorting may move the dragged frame: follow it.
    const moved = frames[this.#drag.index];
    this.#write(this.#drag.series, frames);
    this.#drag.index = this.#selected = this.#frames(this.#names()[this.#drag.series]).findIndex((f) => f.t === moved.t);
  }
  #up() {
    this.#drag = null;
  }
  #remove(e, svg) {
    const hit = this.#hit(this.#point(e, svg));
    if (hit && !this.#disabled) this.#erase(hit.series, hit.index);
  }

  // Buttons for the object's start, stop and clear actions, a loop switch
  // and a curve selector when there are several.
  #bar() {
    const bar = this.shadowRoot.querySelector('.bar');
    bar.textContent = '';
    const c = this.#schema?.children ?? {};
    for (const a of ['start', 'stop', 'clear']) {
      if (c[a]?.type !== 'action') continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c[a].label ?? a[0].toUpperCase() + a.slice(1);
      b.onclick = () => this.tesser?.call(a, null);
      bar.append(b);
    }
    if (c.loop?.type === 'boolean' && c.loop.writable) {
      const l = document.createElement('label');
      l.innerHTML = '<input type="checkbox"> Loop';
      l.firstChild.onchange = (e) => this.tesser?.set('loop', e.target.checked);
      bar.append(l);
    }
    const names = this.#names();
    if (names.length > 1) {
      const s = document.createElement('select');
      names.forEach((n, i) => s.add(new Option(c[n].label ?? n, String(i))));
      s.onchange = () => ((this.#series = Number(s.value)), (this.#selected = -1), this.#draw());
      bar.append(s);
    }
    const info = document.createElement('span');
    info.className = 'info';
    bar.append(info);
  }

  #draw() {
    const svg = this.shadowRoot.querySelector('svg');
    if (!this.#schema) return;
    const s = this.#span();
    const names = this.#names();
    let out = '';
    for (let i = 0; i <= 4; i++) {
      const y = PAD + (i * (H - 2 * PAD)) / 4;
      out += `<line class="grid" x1="${PAD}" x2="${W - PAD}" y1="${y}" y2="${y}"/>`;
    }
    out += `<text x="2" y="${PAD - 4}">${+s.hi.toFixed(2)}</text><text x="2" y="${H - 3}">${+s.lo.toFixed(2)}</text>`;
    out += `<text x="${W - 40}" y="${H - 3}">${(s.tMax / 1000).toFixed(1)} s</text>`;
    names.forEach((n, k) => {
      const color = COLORS[k % COLORS.length];
      const pts = this.#frames(n).map((f) => this.#xy(f, s));
      if (pts.length) out += `<polyline class="curve" stroke="${color}" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
      pts.forEach(([x, y], i) => {
        const sel = k === this.#series && i === this.#selected ? ' sel' : '';
        out += `<circle class="frame${sel}" fill="${color}" cx="${x}" cy="${y}" r="5"/>`;
      });
    });
    const head = this.#head();
    if (head !== null) {
      const x = PAD + (head / s.tMax) * (W - 2 * PAD);
      out += `<line class="head" x1="${x}" x2="${x}" y1="${PAD / 2}" y2="${H - PAD / 2}"/>`;
    }
    svg.innerHTML = out;
    const label = `${names.map((n) => `${this.#schema.children[n].label ?? n}: ${this.#frames(n).length} frames`).join(', ')}`;
    svg.setAttribute('aria-label', label);
    const info = this.shadowRoot.querySelector('.info');
    if (info) info.textContent = head === null ? label : `${(head / 1000).toFixed(1)} s`;
    const loop = this.shadowRoot.querySelector('.bar input');
    if (loop) loop.checked = !!this.#value.loop;
    cancelAnimationFrame(this.#raf);
    if (this.#value.running && this.#value.position === undefined) this.#raf = requestAnimationFrame(() => this.#draw());
  }

  // The playhead's time: the device's position, else the time since
  // running started, wrapped when looping.
  #head() {
    if (typeof this.#value.position === 'number') return this.#value.position;
    if (!this.#value.running) return null;
    let end = 0;
    for (const n of this.#names()) for (const f of this.#frames(n)) end = Math.max(end, f.t);
    const t = performance.now() - this.#startedAt;
    return end && this.#value.loop ? t % end : Math.min(t, end);
  }
}

customElements.define('x-keyframes', Keyframes);
