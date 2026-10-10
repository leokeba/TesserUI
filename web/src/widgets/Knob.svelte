<script lang="ts">
  // A rotary control over 270°: drag around it, or use the arrow keys.
  import { formatValue } from '../model/format';
  import { asNumber, type WidgetProps } from './types';
  let { leaf, value, set, disabled, id }: WidgetProps = $props();

  const min = $derived(leaf.min ?? 0);
  const max = $derived(leaf.max ?? 1);
  const step = $derived(leaf.step ?? (max - min) / 100);
  const n = $derived(Number.isNaN(asNumber(value)) ? min : asNumber(value));
  const angle = $derived(-135 + (270 * (Math.min(Math.max(n, min), max) - min)) / (max - min || 1));

  const point = (a: number, r = 30) => `${40 + r * Math.sin((a * Math.PI) / 180)} ${40 - r * Math.cos((a * Math.PI) / 180)}`;
  const arc = (a0: number, a1: number) => `M${point(a0)}A30 30 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${point(a1)}`;

  function put(v: number, drag: boolean) {
    const snapped = Math.round((Math.min(Math.max(v, min), max) - min) / step) * step + min;
    set(Number(snapped.toFixed(10)), drag);
  }
  function move(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (disabled || !el.hasPointerCapture(e.pointerId)) return;
    const r = el.getBoundingClientRect();
    const a = (Math.atan2(e.clientX - r.left - r.width / 2, r.top + r.height / 2 - e.clientY) * 180) / Math.PI;
    put(min + ((Math.min(Math.max(a, -135), 135) + 135) / 270) * (max - min), true);
  }
  function key(e: KeyboardEvent) {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (d === undefined || disabled) return;
    e.preventDefault();
    put(n + d * step, false);
  }
</script>

<div
  {id}
  class="knob"
  class:disabled
  role="slider"
  tabindex={disabled ? -1 : 0}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={n}
  aria-valuetext={formatValue(value, leaf)}
  aria-label={leaf.label}
  aria-disabled={disabled}
  onpointerdown={(e) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    move(e);
  }}
  onpointermove={move}
  onkeydown={key}
>
  <svg viewBox="0 0 80 80" aria-hidden="true">
    <path class="track" d={arc(-135, 135)} />
    {#if angle > -134.9}<path class="fill" d={arc(-135, angle)} />{/if}
    <circle cx={point(angle).split(' ')[0]} cy={point(angle).split(' ')[1]} r="5" />
  </svg>
  <span>{formatValue(value, leaf)}</span>
</div>

<style>
  .knob {
    position: relative;
    width: 96px;
    height: 96px;
    touch-action: none;
    cursor: grab;
    border-radius: 50%;
    flex: none !important;
  }
  .knob.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  svg {
    width: 100%;
    height: 100%;
    fill: none;
    stroke-width: 7;
    stroke-linecap: round;
  }
  .track {
    stroke: var(--surface-2);
  }
  .fill {
    stroke: var(--accent);
  }
  circle {
    fill: var(--surface);
    stroke: var(--accent);
    stroke-width: 3;
  }
  span {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
</style>
