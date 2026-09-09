<script lang="ts">
  import SafeBlocks from "../SafeBlocks.svelte";
  import type { ReaderFrameProps } from "./types";
  import { describeReasons } from "./reasons";

  export let view: ReaderFrameProps["view"];
  export let position: ReaderFrameProps["position"];
  export let keptIds: ReaderFrameProps["keptIds"];
  export let sourceName: ReaderFrameProps["sourceName"];
  export let working: ReaderFrameProps["working"];
  export let returnLabel: ReaderFrameProps["returnLabel"];
  export let onMove: ReaderFrameProps["onMove"];
  export let onLayout: ReaderFrameProps["onLayout"];
  export let onFeedback: ReaderFrameProps["onFeedback"];

  $: frame = view.edition.items[position];
  $: item = frame ? view.content.find((candidate) => candidate.id === frame.contentId) : undefined;
  $: total = view.edition.items.length;
  $: title = item?.blocks.find((block) => block.kind === "heading")?.text ?? "Untitled";
</script>

{#if item}
  <article class="reading-canvas" aria-labelledby="article-title">
    <header><p>{sourceName(item.sourceId)}</p></header>
    <p class="reader-reason">Chosen from the sources and interests you have allowed.</p>
    <h1 id="article-title">{title}</h1>
    {#key item.id}<SafeBlocks blocks={item.blocks} media={item.media} skipFirstHeading={true} />{/key}
    <details class="reader-explanation">
      <summary>Why this item?</summary>
      {#if describeReasons(frame.decisionTrace).length}
        <ul>{#each describeReasons(frame.decisionTrace) as reason}<li>{reason}</li>{/each}</ul>
      {:else}
        <p>This item passed your source and content rules.</p>
      {/if}
    </details>
    <section class="feedback" aria-label="Tune this kind of recommendation">
      <p>Teach the next edition</p>
      <button type="button" disabled={working} on:click={() => onFeedback("more_like_this")}>More like this</button>
      <button type="button" disabled={working} on:click={() => onFeedback("less_like_this")}>Less like this</button>
      <button type="button" disabled={working} on:click={() => onFeedback("good_surprise")}>Good surprise</button>
      <button type="button" disabled={working} on:click={() => onFeedback("not_now")}>Not now</button>
      <button type="button" disabled={working} on:click={() => onFeedback("mute_source")}>Mute source</button>
      <button type="button" aria-pressed={keptIds.includes(item.id)} disabled={working} on:click={() => onFeedback("keep")}>Keep</button>
    </section>
    <nav aria-label="Edition controls">
      <button type="button" disabled={position === 0 || working} on:click={() => onMove("previous")} aria-label="Previous item">Previous</button>
      <button type="button" on:click={onLayout}>Back to {returnLabel.toLowerCase()}</button>
      <button type="button" disabled={working} on:click={() => onMove("next")} aria-label={position === total - 1 ? "Finish edition" : "Next item"}>{position === total - 1 ? "Finish edition" : "Next"}</button>
    </nav>
  </article>
{/if}
