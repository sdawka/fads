<script lang="ts">
  import type { ReaderFrameProps } from "../types";
  export let label = "Extension example";
  export let view: ReaderFrameProps["view"];
  export let onSelect: ReaderFrameProps["onSelect"];
</script>

<aside class="reader-extension" aria-label={label}>
  <strong>{label}</strong>
  <p>{view.edition.items.length} items are available. Add this component to registry.ts to enable it.</p>
  <button type="button" on:click={() => onSelect(0)}>Open the first item</button>
</aside>

<style>
  .reader-extension { border: 1px dashed var(--border, currentColor); padding: 1rem; }
  p { margin-bottom: 0; }
</style>
