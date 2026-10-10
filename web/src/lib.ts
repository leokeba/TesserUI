// The npm package's module entry (DESIGN.md §9.9): mount UIs in an
// application, or build custom ones on TesserUI's client, model and store.
export { mountUi as mount, resolve, type Mounted, type Options } from './embed';
export { Session, type Config } from './store/session.svelte';
export { Store, type EventEntry } from './store/store.svelte';
export { Subscriptions, type SubSpec } from './store/subs';
export { EnvelopeClient, serialLink, webSocketLink, type Link } from './client/envelope';
export { HttpClient } from './client/http';
export { parse, stringify } from './client/json';
export type { Client, ConnState, Notification, Reply, Request } from './client/types';
export { buildLeaf, buildPage, buildSection, inferWidget, isElement, type Item, type Leaf, type LinkItem, type Page, type Section, type Widget } from './model/model';
export { buildView, type View, type ViewItem, type ViewPage } from './model/views';
export { holds, parseConditions, type Condition } from './model/conditions';
export { formatValue, humanize, printf } from './model/format';
export { schemaAt, mergeSchema, type Schema } from './model/schema';
export const version: string = __VERSION__;
