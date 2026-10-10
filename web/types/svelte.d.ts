// For declaration files only (tsconfig.lib.json): components are internal.
declare module '*.svelte' {
  const component: import('svelte').Component<Record<string, unknown>>;
  export default component;
}
