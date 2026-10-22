<script lang="ts">
  // Claiming (DESIGN.md §9.7.3): a node without an admin account lets
  // anyone who reaches it change everything. The launcher offers to add a
  // first admin account (the page's `claim` names the node's accounts,
  // TesserKIT's /sys/auth), then signs in with it: the node closes, and asks
  // everyone else to sign in. "Not now" is remembered per node.
  import { untrack } from 'svelte';
  import Icon from '../Icon.svelte';
  import { storageGet, storageSet, type Session } from '../store/session.svelte';
  import Secret from '../widgets/Secret.svelte';
  import { claim, claimable } from './claim';

  let { session }: { session: Session } = $props();
  const t = (text: string, vars?: Record<string, string>) => session.t(text, vars);
  // svelte-ignore state_referenced_locally
  const base = session.config.claim!;
  const skipped = () => 'tesserui:claim:' + (session.root.id ?? session.apiUrl());

  let offered = $state(false);
  let name = $state('admin');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  // Asked on each load of the node, while signed out.
  $effect(() => {
    offered = false;
    if (!session.loaded || session.signedIn || storageGet(skipped())) return;
    untrack(() => claimable(session, base)).then((yes) => (offered = yes));
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = await claim(session, base, name, password);
    busy = false;
    if (!error) offered = false;
  }

  function skip() {
    storageSet(skipped(), 'skipped');
    offered = false;
  }
</script>

{#if offered}
  <div class="scrim"></div>
  <dialog open aria-labelledby="claim-title">
    <form method="dialog" onsubmit={create}>
      <h2 id="claim-title"><Icon name="lock" /> {t('No admin account')}</h2>
      <p>{t('Anyone who reaches {node} can change it. Create its admin account: it then asks everyone else to sign in.', { node: session.nodeLabel('/') })}</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input autofocus bind:value={name} placeholder={t('Name')} aria-label={t('Name')} autocomplete="username" required maxlength="24" />
      <Secret show={t('Show password')} bind:value={password} placeholder={t('Password')} label={t('Password')} autocomplete="new-password" maxlength={64} />
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="quiet" onclick={skip}>{t('Not now')}</button>
        <button class="primary" disabled={busy || !name || !password}>{t('Create the admin account')}</button>
      </div>
    </form>
  </dialog>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 5;
    background: #0008;
    backdrop-filter: blur(2px);
  }
  dialog {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    width: min(400px, calc(100% - 32px));
    position: fixed;
    inset: 0;
    margin: auto;
    box-shadow: 0 10px 40px #0005;
    z-index: 6;
  }
  form {
    display: grid;
    gap: 12px;
  }
  p {
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
