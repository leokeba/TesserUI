<script lang="ts">
  // The UI's notifications (DESIGN.md §7.8). Their timers wait while the
  // pointer or focus is on them, and while the tab is hidden.
  import Icon from './Icon.svelte';
  import { humanize } from './model/format';
  import { parentPath } from './model/schema';
  import { useSession } from './shared.svelte';

  const session = useSession();
  const toasts = session.store.toasts;
  const ICON = { info: 'info', ok: 'check', warn: 'alert', error: 'alert' };

  // An error's or an event's path, named after it and its parent, and the
  // page that shows it.
  const name = (path: string) => session.schemaAt(path)?.label ?? humanize(path.slice(path.lastIndexOf('/') + 1));
  function about(path: string) {
    const up = parentPath(path);
    return {
      label: (up === '/' ? '' : name(up) + ' › ') + name(path),
      href: '#' + (session.schemaAt(path)?.type === 'object' ? path : up),
    };
  }

  const hidden = () => toasts.hold('hidden', document.hidden);
  addEventListener('visibilitychange', hidden);
  $effect(() => () => removeEventListener('visibilitychange', hidden));
</script>

<ol
  class="toasts"
  aria-live="polite"
  aria-label={session.t('Notifications')}
  onmouseenter={() => toasts.hold('pointer', true)}
  onmouseleave={() => toasts.hold('pointer', false)}
  onfocusin={() => toasts.hold('focus', true)}
  onfocusout={() => toasts.hold('focus', false)}
>
  {#each toasts.list as toast (toast.id)}
    <li class="toast" data-kind={toast.kind} role={toast.kind === 'error' || toast.kind === 'warn' ? 'alert' : undefined}>
      <Icon name={ICON[toast.kind]} />
      <span class="text">
        {#if toast.path && toast.path !== '/'}{@const a = about(toast.path)}<a href={a.href}>{a.label}</a>{toast.text && ': '}{/if}{toast.text}
        {#if toast.count > 1}<span class="count">×{toast.count}</span>{/if}
      </span>
      <button type="button" class="quiet" aria-label={session.t('Dismiss')} onclick={() => toasts.dismiss(toast.id)}><Icon name="x" /></button>
    </li>
  {/each}
</ol>

<style>
  .toasts {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: grid;
    gap: 8px;
    z-index: 4;
    width: max-content;
    max-width: min(420px, calc(100% - 32px));
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .toast {
    --c: var(--accent);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 4px 4px 14px;
    min-height: 44px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--c);
    border-radius: var(--radius);
    box-shadow: 0 4px 16px #0003;
    animation: rise 0.2s ease-out;
  }
  .toast > :global(.icon) {
    color: var(--c);
  }
  [data-kind='ok'] {
    --c: var(--ok);
  }
  [data-kind='warn'] {
    --c: var(--warn);
  }
  [data-kind='error'] {
    --c: var(--danger);
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .text a {
    color: inherit;
    font-weight: 600;
  }
  .count {
    color: var(--muted);
    margin-left: 4px;
  }
  .toast button {
    min-height: 32px;
    padding: 0 6px;
    color: var(--muted);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
  @media (min-width: 800px) {
    .toasts {
      left: auto;
      right: 16px;
      transform: none;
    }
  }
</style>
