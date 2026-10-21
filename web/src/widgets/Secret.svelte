<script lang="ts">
  // A password input with a button showing what is typed (DESIGN.md §4):
  // every secret field, the sign-in dialog's included. `show` is the
  // button's label, translated by the caller. Explicit attributes, not a
  // spread, which costs Svelte's attribute runtime (~1.5 KB).
  let {
    value = $bindable(),
    show,
    id,
    placeholder,
    maxlength,
    disabled,
    autocomplete = 'new-password',
    autofocus,
    label,
    onchange,
  }: {
    value?: unknown;
    show: string;
    id?: string;
    placeholder?: string;
    maxlength?: number;
    disabled?: boolean;
    autocomplete?: 'new-password' | 'current-password' | 'off';
    autofocus?: boolean;
    label?: string;
    onchange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
  } = $props();
  import Icon from '../Icon.svelte';
  let shown = $state(false);
</script>

<span class="secret">
  <!-- svelte-ignore a11y_autofocus -->
  <input {id} type={shown ? 'text' : 'password'} bind:value {placeholder} {maxlength} {disabled} {autocomplete} {autofocus} aria-label={label} {onchange} />
  <button type="button" class="quiet" title={show} aria-label={show} aria-pressed={shown} {disabled} onclick={() => (shown = !shown)}><Icon name="eye" /></button>
</span>

<style>
  .secret {
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
  }
  input {
    flex: 1;
    min-width: 0;
  }
  button {
    flex: none;
    margin-left: 2px;
    color: var(--muted);
  }
  button[aria-pressed='true'] {
    color: var(--accent);
  }
</style>
