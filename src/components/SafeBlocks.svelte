<script lang="ts">
  import type { MediaAttachment, SafeBlock } from "../contracts";
  import { safeExternalLinkAttributes } from "./reading";

  export let blocks: SafeBlock[] = [];
  export let media: MediaAttachment[] = [];
  export let skipFirstHeading = false;
  let loaded = new Set<string>();
  let failed = new Set<string>();

  function load(key: string) {
    failed = new Set([...failed].filter((value) => value !== key));
    loaded = new Set([...loaded, key]);
  }

  function fail(key: string) {
    loaded = new Set([...loaded].filter((value) => value !== key));
    failed = new Set([...failed, key]);
  }
</script>

<div class="safe-blocks">
  {#each blocks as block, index}
    {#if block.kind === "heading" && !(skipFirstHeading && index === 0)}
      {#if block.level <= 2}
        <h2>{block.text}</h2>
      {:else}
        <h3>{block.text}</h3>
      {/if}
    {:else if block.kind === "paragraph"}
      <p>{block.text}</p>
    {:else if block.kind === "quote"}
      <blockquote>
        <p>{block.text}</p>
        {#if block.attribution}<cite>{block.attribution}</cite>{/if}
      </blockquote>
    {:else if block.kind === "code"}
      <pre><code>{block.code}</code></pre>
    {:else if block.kind === "image"}
      {@const attributes = safeExternalLinkAttributes(block.src)}
      {#if attributes}
        <p class="external media-link">
          <a href={attributes.href} target={attributes.target} rel={attributes.rel}>
            Open image{block.alt ? `: ${block.alt}` : ""}<span aria-hidden="true"> ↗</span>
          </a>
          {#if loaded.has(`block-${index}`)}
            <img src={attributes.href} alt={block.alt ?? ""} referrerpolicy="no-referrer" on:error={() => fail(`block-${index}`)} />
          {:else}
            {#if failed.has(`block-${index}`)}<span role="status">Could not load image.</span>{/if}
            <button type="button" on:click={() => load(`block-${index}`)}>{failed.has(`block-${index}`) ? "Retry" : "Load"} image</button>
          {/if}
        </p>
      {/if}
    {:else if block.kind === "audio"}
      {@const attributes = safeExternalLinkAttributes(block.src)}
      {#if attributes}
        <p class="external media-link">
          <a href={attributes.href} target={attributes.target} rel={attributes.rel}>
            Open audio attachment<span aria-hidden="true"> ↗</span>
          </a>
          {#if loaded.has(`block-${index}`)}
            <audio controls preload="metadata" src={attributes.href} on:error={() => fail(`block-${index}`)}></audio>
          {:else}
            {#if failed.has(`block-${index}`)}<span role="status">Could not load audio.</span>{/if}
            <button type="button" on:click={() => load(`block-${index}`)}>{failed.has(`block-${index}`) ? "Retry" : "Load"} audio</button>
          {/if}
        </p>
      {/if}
      {#if block.transcript}<p class="transcript">{block.transcript}</p>{/if}
    {:else if block.kind === "video"}
      {@const attributes = safeExternalLinkAttributes(block.src)}
      {#if attributes}
        <p class="external media-link">
          <a href={attributes.href} target={attributes.target} rel={attributes.rel}>
            Open video attachment<span aria-hidden="true"> ↗</span>
          </a>
          {#if loaded.has(`block-${index}`)}
            <!-- svelte-ignore a11y_media_has_caption (External sources do not provide caption tracks; transcripts are rendered when available.) -->
            <video controls preload="metadata" src={attributes.href} on:error={() => fail(`block-${index}`)}></video>
          {:else}
            {#if failed.has(`block-${index}`)}<span role="status">Could not load video.</span>{/if}
            <button type="button" on:click={() => load(`block-${index}`)}>{failed.has(`block-${index}`) ? "Retry" : "Load"} video</button>
          {/if}
        </p>
      {/if}
      {#if block.transcript}<p class="transcript">{block.transcript}</p>{/if}
    {:else if block.kind === "link"}
      {@const attributes = safeExternalLinkAttributes(block.href)}
      {#if attributes}
        <p class="external">
          <a href={attributes.href} target={attributes.target} rel={attributes.rel}>
            {block.text}<span aria-hidden="true"> ↗</span>
          </a>
        </p>
      {/if}
    {/if}
  {/each}

  {#each media as attachment, index}
    {@const attributes = safeExternalLinkAttributes(attachment.url)}
    {#if attributes}
      <p class="external media-link">
        <a href={attributes.href} target={attributes.target} rel={attributes.rel}>
          Open {attachment.kind}{attachment.alt ? `: ${attachment.alt}` : " attachment"}<span
            aria-hidden="true"> ↗</span
          >
        </a>
        {#if loaded.has(`media-${attachment.id}-${index}`)}
          {#if attachment.kind === "image"}
            <img src={attributes.href} alt={attachment.alt ?? ""} referrerpolicy="no-referrer" on:error={() => fail(`media-${attachment.id}-${index}`)} />
          {:else if attachment.kind === "audio"}
            <audio controls preload="metadata" src={attributes.href} on:error={() => fail(`media-${attachment.id}-${index}`)}></audio>
          {:else}
            <!-- svelte-ignore a11y_media_has_caption (External sources do not provide caption tracks; transcripts are rendered when available.) -->
            <video controls preload="metadata" src={attributes.href} on:error={() => fail(`media-${attachment.id}-${index}`)}></video>
          {/if}
        {:else}
          {#if failed.has(`media-${attachment.id}-${index}`)}<span role="status">Could not load {attachment.kind}.</span>{/if}
          <button type="button" on:click={() => load(`media-${attachment.id}-${index}`)}>{failed.has(`media-${attachment.id}-${index}`) ? "Retry" : "Load"} {attachment.kind}</button>
        {/if}
      </p>
    {/if}
  {/each}
</div>

<style>
  .safe-blocks { font-family: var(--font-body); font-size: clamp(1.08rem, 1.5vw, 1.24rem); line-height: 1.72; }
  .safe-blocks :global(p) { max-width: 66ch; margin: 0 0 1.35em; }
  h2, h3 { max-width: 26ch; margin: 2em 0 0.65em; font-weight: 500; letter-spacing: -0.025em; line-height: 1.08; }
  h2 { font-size: clamp(1.7rem, 3vw, 2.55rem); }
  h3 { font-size: 1.35rem; }
  blockquote { margin: 2rem 0; border-left: 2px solid var(--ember); padding: 0.2rem 0 0.2rem 1.5rem; color: var(--muted-foreground); }
  blockquote p { margin-bottom: 0.5rem; }
  cite { font-family: var(--utility); font-size: 0.72rem; font-style: normal; letter-spacing: 0.02em; }
  pre { max-width: 100%; overflow-x: auto; border: 1px solid var(--line); background: var(--paper); padding: 1rem; font-family: var(--utility); font-size: 0.78rem; line-height: 1.55; }
  .external { font-family: var(--utility); font-size: 0.76rem; }
  .media-link { margin-block: 1rem; }
  .media-link button { margin-left: 0.75rem; }
  img, audio, video { display: block; max-width: 100%; margin-top: 0.75rem; }
  .transcript { border-left: 1px solid var(--line); padding-left: 1rem; color: var(--muted-foreground); }
  .external a { color: var(--ember); text-decoration-thickness: 1px; text-underline-offset: 0.28em; }
</style>
