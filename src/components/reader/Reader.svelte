<script lang="ts">
  import { onMount } from "svelte";
  import type { ActiveEditionView, FeedbackKind } from "../models";
  import { moveReader } from "../reading";
  import { Button } from "$lib/components/ui/button";
  import { frameRegistry } from "./registry";
  import type { Layout } from "./types";
  import "./reader.css";

  export let view: ActiveEditionView;
  export let keptIds: string[] = [];
  export let onPosition: (position: number) => Promise<void>;
  export let onComplete: () => Promise<void>;
  export let onFeedback: (kind: FeedbackKind, contentId: string, sourceId: string) => Promise<void>;
  export let onKeep: (contentId: string) => Promise<void>;
  export let sourceName: (sourceId: string) => string = (sourceId) => sourceId;
  export let feedbackMessage = "Your feedback will shape a later edition.";
  export let storageKey = "fads:reader-layout";

  let layout: Layout = "focus";
  let returnLayout: Layout = "list";
  let position = view.position;
  let viewId = view.edition.id;
  let status = "";
  let working = false;
  $: activeFrame = frameRegistry.find((candidate) => candidate.id === layout) ?? frameRegistry[0];

  $: if (view.edition.id !== viewId) {
    viewId = view.edition.id;
    position = view.position;
    layout = readLayout();
    status = "";
  }
  $: total = view.edition.items.length;
  $: if (!working && view.position !== position) position = view.position;

  onMount(() => {
    layout = readLayout();
    if (layout !== "focus") returnLayout = layout;
  });

  function readLayout(): Layout {
    if (typeof localStorage === "undefined") return "focus";
    try {
      const saved = localStorage.getItem(storageKey);
      return frameRegistry.some((frame) => frame.id === saved) ? saved! : "focus";
    } catch {
      return "focus";
    }
  }

  function setLayout(next: Layout) {
    layout = next;
    if (next !== "focus") returnLayout = next;
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Private browsing and storage-disabled contexts still retain the current session preference.
    }
  }

  async function select(next: number) {
    if (next < 0 || next >= total || working) return;
    const previous = position;
    position = next;
    layout = "focus";
    working = true;
    try {
      await onPosition(next);
      status = `Item ${next + 1} of ${total}.`;
    } catch (error) {
      position = previous;
      status = error instanceof Error ? error.message : "Progress could not be saved.";
    } finally {
      working = false;
    }
  }

  async function move(direction: "previous" | "next") {
    const next = moveReader({ position, total }, direction);
    if (next.atEnd) {
      working = true;
      try {
        await onComplete();
      } catch (error) {
        status = error instanceof Error ? error.message : "The edition could not be completed.";
      } finally {
        working = false;
      }
      return;
    }
    await select(next.position);
  }

  async function feedback(kind: FeedbackKind) {
    const frame = view.edition.items[position];
    const item = frame ? view.content.find((candidate) => candidate.id === frame.contentId) : undefined;
    if (!item || working) return;
    working = true;
    try {
      if (kind === "keep") await onKeep(item.id);
      else await onFeedback(kind, item.id, item.sourceId);
      status = kind === "keep" ? "Kept for later." : feedbackMessage;
    } catch (error) {
      status = error instanceof Error ? error.message : "Feedback could not be saved.";
    } finally {
      working = false;
    }
  }
</script>

<section class="reader" aria-label="Edition reader">
  <div class="reader-bar">
    <div role="group" aria-label="Reader layout">
      {#each frameRegistry as option}
        <Button variant="outline" aria-pressed={layout === option.id} onclick={() => setLayout(option.id)}>{option.label}</Button>
      {/each}
    </div>
    <p>{total ? `${position + 1} of ${total}` : "No items"}</p>
  </div>

  {#if status}<p class="reader-status" role="status">{status}</p>{/if}

  {#if view.completed}
    <section class="reader-end" aria-labelledby="reader-end-title"><h1 id="reader-end-title">That’s the edition.</h1><p>You reached the deliberate end: {total} {total === 1 ? "item" : "items"}, selected for this moment.</p></section>
  {:else if total}
    <svelte:component this={activeFrame.component} {view} {position} {keptIds} {sourceName} {working} returnLabel={frameRegistry.find((frame) => frame.id === returnLayout)?.label ?? "List"} onSelect={select} onMove={move} onLayout={() => setLayout(returnLayout)} onFeedback={feedback} />
  {:else}
    <p class="reader-empty">This edition has no eligible items.</p>
  {/if}
</section>
