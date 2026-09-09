<script lang="ts">
  import type { ReaderFrameProps } from "./types";

  export let view: ReaderFrameProps["view"];
  export let sourceName: ReaderFrameProps["sourceName"];
  export let onSelect: ReaderFrameProps["onSelect"];

  function title(content: ReaderFrameProps["view"]["content"][number]) {
    return content.blocks.find((block) => block.kind === "heading")?.text ?? "Untitled";
  }
</script>

<ol class="reader-index" aria-label="List of edition items">
  {#each view.edition.items as editionItem, position}
    {@const content = view.content.find((candidate) => candidate.id === editionItem.contentId)}
    {#if content}
      <li><button type="button" on:click={() => onSelect(position)}><span>{position + 1}</span><strong>{title(content)}</strong><small>{sourceName(content.sourceId)}</small></button></li>
    {/if}
  {/each}
</ol>
