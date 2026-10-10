<script lang="ts">
  // A time series of the value, kept by the renderer for ui.history seconds
  // (DESIGN.md §7.7), drawn on a canvas.
  import { useSession } from '../shared.svelte';
  import { formatValue } from '../model/format';
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
    const points = store.historyOf(leaf.path);
    const c = canvas;
    if (!c) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    const css = getComputedStyle(c);
    g.clearRect(0, 0, w, h);
    if (!points.length) return;
    let lo = leaf.min ?? Math.min(...points.map((p) => p[1]));
    let hi = leaf.max ?? Math.max(...points.map((p) => p[1]));
    if (hi === lo) (hi += 1), (lo -= 1);
    const pad = 6 * devicePixelRatio;
    const x = (t: number) => w - ((now - t) / span) * w;
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
    g.lineTo(w, y(points[points.length - 1][1]));
    g.stroke();
    g.fillStyle = css.getPropertyValue('--muted');
    g.font = `${11 * devicePixelRatio}px system-ui`;
    g.fillText(formatValue(hi, { ...leaf, unit: undefined }), 2, 12 * devicePixelRatio);
    g.fillText(formatValue(lo, { ...leaf, unit: undefined }), 2, h - 3 * devicePixelRatio);
  });
</script>

<div class="chart" role="img" aria-label={session.t('{label}, last {n} s', { label: leaf.label, n: leaf.history ?? 60 })}>
  <output>{formatValue(value, leaf)}</output>
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
</style>
