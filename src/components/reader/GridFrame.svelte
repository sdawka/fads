<script lang="ts">
  import ListFrame from "./ListFrame.svelte";
  import type { ReaderFrameProps } from "./types";

  export let view: ReaderFrameProps["view"];
  export let sourceName: ReaderFrameProps["sourceName"];
  export let onSelect: ReaderFrameProps["onSelect"];
</script>

<div class="reader-grid"><ListFrame {view} {sourceName} {onSelect} /></div>
