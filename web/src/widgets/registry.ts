// The widgets this renderer draws, by semantic name (DESIGN.md §4, §5.1).
// Adding one: its component here, its rules in model.ts (fits()), its row
// in the spec. Custom elements need neither: any name with a hyphen is one.

import type { Component } from 'svelte';
import { isElement, type Leaf } from '../model/model';
import Action from './Action.svelte';
import Bool from './Bool.svelte';
import Chart from './Chart.svelte';
import Choice from './Choice.svelte';
import Color from './Color.svelte';
import Element from './Element.svelte';
import Events from './Events.svelte';
import File from './File.svelte';
import Flags from './Flags.svelte';
import Gauge from './Gauge.svelte';
import JsonView from './JsonView.svelte';
import Knob from './Knob.svelte';
import Num from './Num.svelte';
import Range from './Range.svelte';
import Readout from './Readout.svelte';
import Table from './Table.svelte';
import Text from './Text.svelte';
import Timezone from './Timezone.svelte';
import type { WidgetProps } from './types';

// pair: label, then control; wide: label above, control the card's width;
// bare: the control alone.
export type Layout = 'pair' | 'wide' | 'bare';

interface Def {
  component: Component<WidgetProps>;
  layout?: Layout;
  // Usable as an action's argument input.
  field?: boolean;
}

const c = (component: unknown) => component as Component<WidgetProps>;

export const WIDGETS: Record<string, Def> = {
  toggle: { component: c(Bool), field: true },
  checkbox: { component: c(Bool), field: true },
  led: { component: c(Bool) },
  slider: { component: c(Range), field: true },
  knob: { component: c(Knob), field: true },
  number: { component: c(Num), field: true },
  stepper: { component: c(Num), field: true },
  readout: { component: c(Readout) },
  bar: { component: c(Readout) },
  gauge: { component: c(Gauge) },
  chart: { component: c(Chart), layout: 'wide' },
  segmented: { component: c(Choice), field: true },
  select: { component: c(Choice), field: true },
  radio: { component: c(Choice), field: true },
  text: { component: c(Text), field: true },
  password: { component: c(Text), field: true },
  textarea: { component: c(Text), layout: 'wide', field: true },
  color: { component: c(Color), field: true },
  flags: { component: c(Flags), field: true },
  timezone: { component: c(Timezone), field: true },
  button: { component: c(Action), layout: 'bare' },
  hold: { component: c(Action), layout: 'bare' },
  json: { component: c(JsonView), layout: 'wide' },
  events: { component: c(Events), layout: 'wide' },
  table: { component: c(Table), layout: 'wide' },
  list: { component: c(Table), layout: 'wide' },
  file: { component: c(File), layout: 'wide' },
};

export function widgetOf(leaf: Leaf): { component: Component<WidgetProps>; layout: Layout } {
  if (isElement(leaf.widget)) return { component: c(Element), layout: 'wide' };
  const def = WIDGETS[leaf.widget] ?? WIDGETS.readout;
  // An action with an argument shows its input next to the button.
  if (leaf.field) return { component: def.component, layout: leaf.field === 'json' ? 'wide' : 'pair' };
  return { component: def.component, layout: def.layout ?? 'pair' };
}

// An action argument's input.
export const fieldOf = (w: string | undefined) => (w && WIDGETS[w]?.field ? WIDGETS[w].component : null);
