<script lang="ts">
  // The interface's theme (DESIGN.md §9.3): its variables, light and dark,
  // and the look of the elements every page has, under .tesserui. Global,
  // and injected once like any component's CSS: drawn before App (embed.ts,
  // the launcher's workspace), so App's rules come after these.
</script>

<style>
  :global {
    .tesserui {
      --bg: #f3f4f6;
      --surface: #fff;
      --surface-2: #eceef2;
      --text: #1a1d23;
      --muted: #5d6675;
      --border: #d9dde3;
      --accent: #2f5bd3;
      --on-accent: #fff;
      --danger: #c62f2f;
      --ok: #1f9d55;
      --warn: #b7791f;
      --radius: 10px;
      --gap: 16px;
      --control: 36px;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      .tesserui {
        --bg: #101318;
        --surface: #191d24;
        --surface-2: #232933;
        --text: #e5e8ed;
        --muted: #98a2b1;
        --border: #2d343f;
        --accent: #7393ff;
        --on-accent: #0c1022;
        --danger: #f06a6a;
        --ok: #4cc38a;
        --warn: #e0b04f;
        color-scheme: dark;
      }
    }
    @media (max-width: 640px) {
      .tesserui {
        --control: 44px;
      }
    }
    .tesserui,
    .tesserui * {
      box-sizing: border-box;
    }
    .tesserui {
      background: var(--bg);
      color: var(--text);
      font:
        15px/1.45 system-ui,
        -apple-system,
        'Segoe UI',
        Roboto,
        sans-serif;
      -webkit-text-size-adjust: 100%;
    }
    .tesserui.full {
      min-height: 100vh;
    }
    .tesserui a {
      color: var(--accent);
    }
    .tesserui h2,
    .tesserui h3 {
      margin: 0;
      font-size: 1rem;
    }
    .tesserui input,
    .tesserui select,
    .tesserui textarea,
    .tesserui button {
      font: inherit;
      color: inherit;
      min-height: var(--control);
      border: 1px solid var(--border);
      border-radius: calc(var(--radius) - 4px);
      background: var(--surface-2);
      padding: 0 10px;
      min-width: 0;
    }
    /* Safari drops the native arrow of a styled select: draw one. */
    .tesserui select {
      appearance: none;
      padding-right: 28px;
      background-image: linear-gradient(45deg, #0000 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, #0000 50%);
      background-position:
        right 15px center,
        right 10px center;
      background-size: 5px 5px;
      background-repeat: no-repeat;
    }
    .tesserui textarea {
      padding: 8px 10px;
      width: 100%;
      resize: vertical;
    }
    .tesserui input:focus-visible,
    .tesserui select:focus-visible,
    .tesserui textarea:focus-visible,
    .tesserui button:focus-visible,
    .tesserui a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .tesserui button {
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--surface);
      white-space: nowrap;
    }
    .tesserui button:hover:not(:disabled) {
      border-color: var(--muted);
    }
    .tesserui button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-accent);
    }
    .tesserui button.danger {
      color: var(--danger);
      border-color: color-mix(in srgb, var(--danger) 45%, transparent);
    }
    .tesserui button.danger:hover:not(:disabled) {
      background: var(--danger);
      border-color: var(--danger);
      color: #fff;
    }
    .tesserui button.quiet {
      background: none;
      border-color: transparent;
    }
    .tesserui :disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .tesserui input[type='range'] {
      accent-color: var(--accent);
      padding: 0;
      border: 0;
      background: none;
    }
    .tesserui input[type='checkbox'],
    .tesserui input[type='radio'] {
      accent-color: var(--accent);
      width: 20px;
      height: 20px;
      min-height: 0;
      margin: 0;
    }
    .tesserui input[role='switch'] {
      appearance: none;
      width: 44px;
      height: 26px;
      border-radius: 13px;
      background: var(--border);
      border: 0;
      position: relative;
      cursor: pointer;
      transition: background 0.15s;
    }
    .tesserui input[role='switch']::before {
      content: '';
      position: absolute;
      inset: 3px auto 3px 3px;
      width: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px #0004;
      transition: transform 0.15s;
    }
    .tesserui input[role='switch']:checked {
      background: var(--accent);
    }
    .tesserui input[role='switch']:checked::before {
      transform: translateX(18px);
    }
    .tesserui .muted {
      color: var(--muted);
    }
    .tesserui .center {
      text-align: center;
      padding: 48px 16px;
    }
    .tesserui .error {
      color: var(--danger);
      font-size: 0.9em;
      margin: 4px 0 0;
    }
    .tesserui .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
      min-width: 0;
    }
    .tesserui .banner {
      margin: 0;
      padding: 10px 16px;
      display: flex;
      gap: 8px;
      align-items: center;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
    }
    .tesserui .banner.warn {
      color: var(--warn);
    }
  }
</style>
