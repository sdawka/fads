<script lang="ts">
  import { onMount } from "svelte";
  let ready = false;
  onMount(() => { ready = true; });
  import Reader from "../../src/components/reader/Reader.svelte";
  import type { FeedbackKind } from "../../src/components/models";
  import {
    commitDemoEdition,
    createDemoEdition,
    type DemoMode,
  } from "../lib/demo-edition";
  const sources = {
    fieldnotes: "Field Notes",
    publicworks: "Public Works",
    signal: "Signal Garden",
  } as const;

  let draftMode: DemoMode = "familiar";
  let activeMode: DemoMode = "familiar";
  let position = 0;
  let completed = false;
  let keptIds: string[] = [];
  let feedback = "";

  $: view = createDemoEdition(activeMode, position, completed);

  function makeEdition() {
    ({ activeMode, position, completed } = commitDemoEdition({ draftMode, activeMode, position, completed }));
    feedback = activeMode === "surprise" ? "A few useful detours, deliberately chosen." : "A short edition from your familiar ground.";
  }

  function reset() {
    draftMode = "familiar";
    activeMode = "familiar";
    position = 0;
    completed = false;
    keptIds = [];
    feedback = "Demo reset. Make another small edition when you are ready.";
  }

  async function onFeedback(kind: FeedbackKind) {
    feedback = kind === "good_surprise" ? "That detour landed. In your own f.ads, this stays private." : `Marked ${kind.replaceAll("_", " ")} for this local demo.`;
  }
</script>

<section class="demo" id="demo" aria-labelledby="demo-title" aria-busy={!ready} inert={!ready}>
  <div class="demo-copy">
    <p class="section-mark">Try a small edition</p>
    <h2 id="demo-title">Make a three-piece edition.</h2>
    <p>Try it with six sample stories. Stay familiar favors established interests; Allow a detour makes room for something less familiar. Choose a direction, then make your edition.</p>

    <p>Switch between Focus, List, and Grid to change how you read the same selection. This demo uses sample content and needs no account.</p>

    <div class="choice-row" aria-label="Edition direction">
      <button aria-pressed={draftMode === "familiar"} class:chosen={draftMode === "familiar"} type="button" on:click={() => (draftMode = "familiar")}>Stay familiar</button>
      <button aria-pressed={draftMode === "surprise"} class:chosen={draftMode === "surprise"} type="button" on:click={() => (draftMode = "surprise")}>Allow a detour</button>
    </div>
    <button class="make-edition" type="button" on:click={makeEdition}>Make this edition</button>
    <p class="demo-status" aria-live="polite">{feedback || "Choose a direction. Nothing changes until you make an edition."}</p>
  </div>

  <div class="reader-stage">
    <div class="demo-label"><span></span> {ready ? "Local, resettable demo" : "Loading interactive demo…"}</div>
    <Reader
      {view}
      {keptIds}
      storageKey="fads:demo-layout"
      feedbackMessage="Feedback demonstrated locally. Your installed reader learns from these choices."
      sourceName={(sourceId) => sources[sourceId as keyof typeof sources] ?? sourceId}
      onPosition={async (nextPosition) => { position = nextPosition; }}
      onComplete={async () => { completed = true; feedback = "That is the end. The next edition is a fresh choice."; }}
      onFeedback={async (kind) => { await onFeedback(kind); }}
      onKeep={async (contentId) => { keptIds = [...new Set([...keptIds, contentId])]; feedback = "Kept locally for this demo."; }}
    />
    {#if completed}
      <button class="reset-demo" type="button" on:click={reset}>Reset this demo</button>
    {/if}
  </div>
</section>

<style>
  .demo { display:grid; grid-template-columns:minmax(0,.72fr) minmax(28rem,1.28fr); gap:clamp(2rem,6vw,7rem); align-items:start; padding:clamp(4rem,9vw,9rem) max(1.25rem,calc((100vw - 76rem)/2)); background:var(--surface, oklch(1.000000 0.000000 0.000)); }
  .demo-copy { position:sticky; top:2rem; }
  .section-mark { color:var(--primary); font-weight:700; margin:0 0 1rem; }
  h2 { font-family:var(--font-display,system-ui); font-size:clamp(2.4rem,5vw,4.8rem); line-height:.93; letter-spacing:-.065em; margin:0; max-width:8ch; }
  .demo-copy > p:not(.section-mark):not(.demo-status) { color:var(--muted-foreground,oklch(0.445124 0.012960 285.862)); font-size:1.06rem; line-height:1.6; max-width:29rem; }
  .choice-row { display:flex; flex-wrap:wrap; gap:.55rem; margin:2rem 0 .8rem; }
  .choice-row button { background:transparent; border:1px solid oklch(0.846812 0.011075 280.444); border-radius:999px; color:inherit; cursor:pointer; font:inherit; padding:.65rem .9rem; }
  .choice-row button.chosen { border-color:var(--lime,oklch(0.875469 0.194269 125.015)); box-shadow:inset 0 -2px var(--lime,oklch(0.875469 0.194269 125.015)); }
  .make-edition,.reset-demo { background:var(--cobalt,oklch(0.478776 0.223069 265.763)); border:0; border-radius:.45rem; color:oklch(1.000000 0.000000 0.000); cursor:pointer; font:700 1rem/1 var(--font-body); padding:.85rem 1rem; }
  .demo-status { color:var(--muted-foreground,oklch(0.445124 0.012960 285.862)); font-size:.9rem; min-height:2.7em; }
  .reader-stage { border:1px solid oklch(0.880740 0.010964 280.454); box-shadow:9px 9px 0 var(--lime,oklch(0.875469 0.194269 125.015)); min-height:32rem; padding:1.1rem; }
  .demo-label { color:var(--muted-foreground,oklch(0.445124 0.012960 285.862)); display:flex; align-items:center; gap:.5rem; font-size:.78rem; margin-bottom:.8rem; }
  .demo-label span { background:var(--coral,oklch(0.651996 0.197399 30.346)); border-radius:50%; height:.55rem; width:.55rem; }
  .reset-demo { background:oklch(0.177638 0.000000 0.000); margin-top:1rem; }
  @media (max-width: 760px) { .demo { display:block; padding-block:4rem; } .demo-copy { position:static; } .reader-stage { margin-top:2.5rem; min-width:0; } }
</style>
