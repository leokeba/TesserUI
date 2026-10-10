export default {
  compilerOptions: {
    css: 'injected',
    // Short scoping classes: they're repeated in every template and rule.
    cssHash: ({ hash, css }) => `s${hash(css).slice(0, 4)}`,
  },
};
