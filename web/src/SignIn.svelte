<script lang="ts">
  // Signing in (DESIGN.md §7.4): the login action's text fields, or a token
  // typed in when the node has no login action.
  import Icon from './Icon.svelte';
  import { humanize } from './model/format';
  import { useSession } from './shared.svelte';
  import Secret from './widgets/Secret.svelte';

  const session = useSession();
  const t = (text: string) => session.t(text);
  let token = $state('');
  const loginFields = $derived(
    Object.entries(session.login?.schema.params?.children ?? {})
      .filter(([, c]) => c.type === 'string')
      .map(([name, c]) => ({ name, label: c.label ?? humanize(name), secret: !!c.secret })),
  );
  let creds: Record<string, string> = $state({});
  let loginError = $state('');
  async function authenticate(e: SubmitEvent) {
    e.preventDefault();
    if (!session.login) return session.setToken(token);
    loginError = (await session.signIn(creds)) ?? '';
    if (!loginError) creds = {};
  }
</script>

<dialog open aria-labelledby="token-title">
  <form method="dialog" onsubmit={authenticate}>
    <h2 id="token-title"><Icon name="lock" /> {t('Authentication')}</h2>
    {#if session.login}
      {#each loginFields as f, i (f.name)}
        {#if f.secret}
          <!-- svelte-ignore a11y_autofocus -->
          <Secret show={t('Show password')} autofocus={i === 0} bind:value={creds[f.name]} placeholder={f.label} label={f.label} autocomplete="current-password" />
        {:else}
          <!-- svelte-ignore a11y_autofocus -->
          <input autofocus={i === 0} bind:value={creds[f.name]} placeholder={f.label} aria-label={f.label} autocomplete="username" />
        {/if}
      {/each}
      {#if loginError}<p class="error" role="alert">{loginError}</p>{/if}
    {:else}
      <p>{t('This node needs a token to make changes.')}</p>
      <Secret show={t('Show password')} bind:value={token} label={t('Token')} autocomplete="current-password" />
    {/if}
    <div class="actions">
      <button type="button" class="quiet" onclick={() => (session.needToken = false)}>{t('Cancel')}</button>
      <button class="primary">{session.login ? t('Sign in') : t('Save')}</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--text);
    width: min(360px, calc(100% - 32px));
    position: fixed;
    inset: 0;
    margin: auto;
    box-shadow: 0 10px 40px #0005;
    z-index: 6;
  }
  dialog form {
    display: grid;
    gap: 12px;
  }
  dialog p {
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
