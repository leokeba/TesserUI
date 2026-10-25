<script lang="ts">
  // A time series of the value, kept by the renderer for ui.history seconds
  // (DESIGN.md §7.7), or an array's values by index, drawn on a canvas.
  import { useSession } from '../shared.svelte';
  import { chartRange, formatValue } from '../model/format';
  import type { WidgetProps } from './types';
  let { leaf, value }: WidgetProps = $props();
  const session = useSession();
  const store = session.store;

  let canvas: HTMLCanvasElement | undefined = $state();
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  $effect(() => {
    void store.historyTick;
    const span = (leaf.history ?? 60) * 1000;
    const array = Array.isArray(value) ? value.map((v, i): [number, number] => [i, Number(v)]) : null;
    const points = array ?? store.historyOf(leaf.path);
    const c = canvas;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    const css = getComputedStyle(c);
    g.clearRect(0, 0, w, h);
    if (!points.length) return;
    const values = points.map((p) => p[1]);
    const [lo, hi] = chartRange(values, leaf);
    const pad = 6 * devicePixelRatio;
    const x = array ? (i: number) => (i / Math.max(1, array.length - 1)) * w : (t: number) => w - ((now - t) / span) * w;
    const y = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad);
    g.strokeStyle = css.getPropertyValue('--border');
    g.lineWidth = devicePixelRatio;
    g.beginPath();
    g.moveTo(0, y(lo));
    g.lineTo(w, y(lo));
    g.stroke();
    g.strokeStyle = css.getPropertyValue('--accent');
    g.lineWidth = 2 * devicePixelRatio;
    g.lineJoin = 'round';
    g.beginPath();
    points.forEach(([t, v], i) => (i ? g.lineTo(x(t), y(v)) : g.moveTo(x(t), y(v))));
    const last = y(points[points.length - 1][1]);
    if (!array) g.lineTo(w, last);
    g.stroke();
    // The latest value, at "now": a steady value is read once and draws as
    // a line growing from when it was, which starts out tiny.
    if (!array) {
      g.fillStyle = css.getPropertyValue('--accent');
      g.beginPath();
      g.arc(w - 3 * devicePixelRatio, last, 3 * devicePixelRatio, 0, 7);
      g.fill();
    }
    // The axis's ends, once the values span half of it: a nearly flat line's
    // axis is widened around it, and its ends would mean nothing.
    if (Math.max(...values) - Math.min(...values) < (hi - lo) / 2) return;
    g.fillStyle = css.getPropertyValue('--muted');
    g.font = `${11 * devicePixelRatio}px system-ui`;
    // Bytes keep their unit: it scales them (KB, MB).
    const f = { ...leaf, unit: leaf.unit === 'B' ? 'B' : undefined };
    g.fillText(formatValue(hi, f), 2, 12 * devicePixelRatio);
    g.fillText(formatValue(lo, f), 2, h - 3 * devicePixelRatio);
  });
</script>

<div class="chart" role="img" aria-label={Array.isArray(value) ? leaf.label : session.t('{label}, last {n} s', { label: leaf.label, n: leaf.history ?? 60 })}>
  {#if !Array.isArray(value)}<output>{formatValue(value, leaf)}</output>{/if}
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .chart {
    display: grid;
    gap: 4px;
  }
  output {
    font-variant-numeric: tabular-nums;
    justify-self: end;
    margin-top: -1.9em;
  }
  canvas {
    width: 100%;
    height: 96px;
    background: var(--surface-2);
    border-radius: 6px;
  }
  @media (max-width: 640px) {
    canvas {
      height: 64px;
    }
  }
</style>
