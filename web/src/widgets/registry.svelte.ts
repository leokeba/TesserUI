// The widgets this renderer draws, by semantic name (DESIGN.md §4, §5.1).
// Adding one: its component here, its rules in model.ts (fits()), its row
// in the spec. Custom elements need neither: any name with a hyphen is one.

import type { Component } from 'svelte';
import { isElement, type Leaf } from '../model/model';
import Action from './Action.svelte';
import Bool from './Bool.svelte';
import Choice from './Choice.svelte';
import Color from './Color.svelte';
import Events from './Events.svelte';
import Flags from './Flags.svelte';
import Num from './Num.svelte';
import Range from './Range.svelte';
import Readout from './Readout.svelte';
import Text from './Text.svelte';
import type { WidgetProps } from './types';

// pair: label, then control; wide: label above, control the card's width;
// bare: the control alone.
export type Layout = 'pair' | 'wide' | 'bare';

type Widget = Component<WidgetProps>;

interface Def {
  component: Widget;
  layout?: Layout;
  // Usable as an action's argument input.
  field?: boolean;
}

const c = (component: unknown) => component as Widget;

// Draws nothing, until a widget's chunk arrives.
const none = c(() => {});

// A widget used on few pages, from the chunk beside ui.js (DESIGN.md §9.4),
// loaded when a page first reads its component. Rows read it
// reactively, so they draw it as it arrives, or as a readout if it can't.
function lazy(load: () => Promise<{ default: unknown }>, def: Omit<Def, 'component'> = {}): Def {
  const chunk = $state<{ component?: Widget }>({});
  let loading = false;
  return {
    ...def,
    get component() {
      if (!loading) {
        loading = true;
        load().then(
          (m) => (chunk.component = c(m.default)),
          (e) => (console.error(e), (chunk.component = c(Readout))),
        );
      }
      return chunk.component ?? none;
    },
  };
}

const table = lazy(() => import('./Table.svelte'), { layout: 'wide' });

export const WIDGETS: Record<string, Def> = {
  toggle: { component: c(Bool), field: true },
  checkbox: { component: c(Bool), field: true },
  led: { component: c(Bool) },
  slider: { component: c(Range), field: true },
  knob: lazy(() => import('./Knob.svelte'), { field: true }),
  number: { component: c(Num), field: true },
  stepper: { component: c(Num), field: true },
  readout: { component: c(Readout) },
  bar: { component: c(Readout) },
  gauge: lazy(() => import('./Gauge.svelte')),
  chart: lazy(() => import('./Chart.svelte'), { layout: 'wide' }),
  segmented: { component: c(Choice), field: true },
  select: { component: c(Choice), field: true },
  radio: { component: c(Choice), field: true },
  text: { component: c(Text), field: true },
  password: { component: c(Text), field: true },
  textarea: { component: c(Text), layout: 'wide', field: true },
  color: { component: c(Color), field: true },
  flags: { component: c(Flags), field: true },
  timezone: lazy(() => import('./Timezone.svelte'), { field: true }),
  button: { component: c(Action), layout: 'bare' },
  hold: { component: c(Action), layout: 'bare' },
  json: lazy(() => import('./JsonView.svelte'), { layout: 'wide' }),
  events: { component: c(Events), layout: 'wide' },
  log: lazy(() => import('./Log.svelte'), { layout: 'wide' }),
  table,
  list: table,
  file: lazy(() => import('./File.svelte'), { layout: 'wide' }),
};

// Custom elements (§9.8): the element's host and its scripts' loader.
const element = lazy(() => import('./Element.svelte'));

export function widgetOf(leaf: Leaf): { component: Widget; layout: Layout } {
  if (isElement(leaf.widget)) return { component: element.component, layout: 'wide' };
  const def = WIDGETS[leaf.widget] ?? WIDGETS.readout;
  // An action with an argument shows its input next to the button.
  if (leaf.field) return { component: def.component, layout: leaf.field === 'json' ? 'wide' : 'pair' };
  return { component: def.component, layout: def.layout ?? 'pair' };
}

// An action argument's input.
export const fieldOf = (w: string | undefined) => (w && WIDGETS[w]?.field ? WIDGETS[w].component : null);
