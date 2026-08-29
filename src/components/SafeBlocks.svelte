<script lang="ts">
  import type { SafeBlock } from "../contracts";
  import { safeExternalLinkAttributes } from "./reading";

  export let blocks: SafeBlock[] = [];
  export let skipFirstHeading = false;
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
      <figure><img src={block.src} alt={block.alt} loading="lazy" /></figure>
    {:else if block.kind === "audio"}
      <figure>
        <audio controls preload="none" src={block.src}><track kind="captions" /></audio>
        {#if block.transcript}<figcaption>{block.transcript}</figcaption>{/if}
      </figure>
    {:else if block.kind === "video"}
      <figure>
        <video controls preload="metadata" src={block.src}><track kind="captions" /></video>
        {#if block.transcript}<figcaption>{block.transcript}</figcaption>{/if}
      </figure>
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
</div>

<style>
  .safe-blocks { font-family: var(--display); font-size: clamp(1.08rem, 1.5vw, 1.24rem); line-height: 1.72; }
  .safe-blocks :global(p) { max-width: 66ch; margin: 0 0 1.35em; }
  h2, h3 { max-width: 26ch; margin: 2em 0 0.65em; font-weight: 500; letter-spacing: -0.025em; line-height: 1.08; }
  h2 { font-size: clamp(1.7rem, 3vw, 2.55rem); }
  h3 { font-size: 1.35rem; }
  blockquote { margin: 2rem 0; border-left: 2px solid var(--ember); padding: 0.2rem 0 0.2rem 1.5rem; color: var(--muted); }
  blockquote p { margin-bottom: 0.5rem; }
  cite, figcaption { font-family: var(--utility); font-size: 0.72rem; font-style: normal; letter-spacing: 0.02em; }
  pre { max-width: 100%; overflow-x: auto; border: 1px solid var(--line); background: var(--paper); padding: 1rem; font-family: var(--utility); font-size: 0.78rem; line-height: 1.55; }
  figure { max-width: 100%; margin: 2rem 0; }
  img, video { display: block; max-width: 100%; height: auto; }
  audio { width: min(100%, 32rem); }
  .external { font-family: var(--utility); font-size: 0.76rem; }
  .external a { color: var(--ember); text-decoration-thickness: 1px; text-underline-offset: 0.28em; }
</style>
