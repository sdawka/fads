<script lang="ts">
  import { onMount } from "svelte";

  import type { ContentEnvelope, FramedRecommendation } from "../contracts";
  import { createBrowserUiClient } from "./api-client";
  import type { ActiveEditionView, FadsUiClient, FeedbackKind, Surface } from "./models";
  import { describeControlValue, moveReader } from "./reading";
  import SafeBlocks from "./SafeBlocks.svelte";

  export let activeSurface: Surface = "edition";
  export let client: FadsUiClient | undefined = undefined;

  let session: "loading" | "signed-out" | "authenticated" = "loading";
  let edition: ActiveEditionView | undefined;
  let loadError = "";
  let statusMessage = "";
  let curiosity = 58;
  let energy = 46;
  let creating = false;
  let atEnd = false;
  let traceExpanded = false;
  let kept = new Set<string>();
  let manualInterests = ["urban ecology", "tools for thought"];
  let suggestions = ["vernacular architecture", "small press publishing"];
  let rssSources: Array<{ name: string; url: string; muted: boolean }> = [];
  let rssUrl = "";

  const navigation: Array<{ href: string; label: string; surface: Surface }> = [
    { href: "/", label: "Edition", surface: "edition" },
    { href: "/keeps/", label: "Keeps", surface: "keeps" },
    { href: "/sources/", label: "Sources", surface: "sources" },
    { href: "/garden/", label: "Garden", surface: "garden" },
    { href: "/settings/", label: "Settings", surface: "settings" },
  ];

  $: position = edition?.position ?? 0;
  $: total = edition?.edition.items.length ?? 0;
  $: frame = edition?.edition.items[position];
  $: item = frame ? edition?.content.find((candidate) => candidate.id === frame?.contentId) : undefined;
  $: title = item?.blocks.find((block) => block.kind === "heading")?.text ?? "Untitled";

  onMount(async () => {
    const uiClient = client ?? createBrowserUiClient();
    client = uiClient;
    try {
      const inspected = await uiClient.session();
      session = inspected.authenticated ? "authenticated" : "signed-out";
      if (session === "authenticated" && activeSurface === "edition") {
        edition = await uiClient.activeEdition();
        atEnd = edition?.completed ?? false;
      }
    } catch (error) {
      session = "signed-out";
      loadError = error instanceof Error && error.message === "Your session expired." ? error.message : "";
    }
  });

  async function makeEdition() {
    if (!client || creating) return;
    creating = true;
    statusMessage = "Making your edition…";
    try {
      edition = await client.createEdition({ curiosity, energy });
      atEnd = false;
      statusMessage = `Edition ready with ${edition.edition.items.length} items.`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The edition could not be made.";
    } finally {
      creating = false;
    }
  }

  async function move(direction: "previous" | "next") {
    if (!edition || !client) return;
    const next = moveReader({ position: edition.position, total }, direction);
    if (next.atEnd) {
      try {
        await client.complete(edition.edition.id);
        atEnd = true;
        edition = { ...edition, completed: true };
        statusMessage = "Edition complete.";
      } catch (error) {
        statusMessage = error instanceof Error ? error.message : "Progress could not be saved.";
      }
      return;
    }
    edition = { ...edition, position: next.position };
    statusMessage = `Item ${next.position + 1} of ${total}.`;
    try {
      await client.setProgress(edition.edition.id, next.position);
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "Progress will be saved when online.";
    }
  }

  async function react(kind: FeedbackKind) {
    if (!edition || !item || !client) return;
    if (kind === "keep") {
      kept = new Set(kept).add(item.id);
    }
    statusMessage = kind === "keep" ? "Kept for later." : "Noted. Your taste changed a little.";
    try {
      await client.interact({
        editionId: edition.edition.id,
        contentId: item.id,
        sourceId: item.sourceId,
        kind,
      });
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "Feedback will be sent when online.";
    }
  }

  function addSource() {
    const value = rssUrl.trim();
    if (!value) return;
    rssSources = [...rssSources, { name: new URL(value).hostname, url: value, muted: false }];
    rssUrl = "";
    statusMessage = "RSS source added. Refresh queued.";
  }

  function addInterest(event: SubmitEvent) {
    const form = event.currentTarget as HTMLFormElement;
    const input = new FormData(form).get("interest")?.toString().trim();
    if (!input || manualInterests.includes(input)) return;
    manualInterests = [...manualInterests, input];
    form.reset();
    statusMessage = `${input} added to your garden.`;
  }

  function decideSuggestion(value: string, confirm: boolean) {
    suggestions = suggestions.filter((suggestion) => suggestion !== value);
    if (confirm && !manualInterests.includes(value)) manualInterests = [...manualInterests, value];
    statusMessage = confirm ? `${value} confirmed.` : `${value} dismissed.`;
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
  }

  function formatOf(content: ContentEnvelope): string {
    if (content.blocks.some((block) => block.kind === "video")) return "VIDEO";
    if (content.blocks.some((block) => block.kind === "audio")) return "AUDIO";
    return "READ";
  }

  function factorPercent(factor: FramedRecommendation["decisionTrace"]["factors"][number]): string {
    return `${Math.round(Math.abs(factor.weight) * 100)}%`;
  }
</script>

<a class="skip-link" href="#main-content">Skip to content</a>

{#if session === "loading"}
  <main class="signed-out" id="main-content">
    <p class="loading" role="status">Opening your reading room…</p>
  </main>
{:else if session === "signed-out"}
  <main class="signed-out" id="main-content">
    <header class="solo-masthead"><a class="wordmark" href="/">f.ads</a></header>
    <section class="signin-canvas" aria-labelledby="welcome-title">
      <div class="signin-copy">
        <p class="eyebrow">PRIVATE READING SURFACE</p>
        <h1 id="welcome-title">A quieter place to follow your curiosity.</h1>
        <p>One finite, explainable edition drawn from sources you allow. No feed to finish and no audience to perform for.</p>
        {#if loadError}<p class="notice" role="alert">{loadError}</p>{/if}
        <div class="signin-actions">
          <a class="button primary" href="/oauth/start">Enter with ATProto</a>
          <a class="text-link" href="/concept/">Open the original concept deck <span aria-hidden="true">↗</span></a>
        </div>
      </div>
      <aside class="premise" aria-label="What f.ads promises">
        <p class="rail-label">THE AGREEMENT</p>
        <ol>
          <li><span>01</span> You choose the allowances.</li>
          <li><span>02</span> Every choice has a reason.</li>
          <li><span>03</span> Every edition has an end.</li>
        </ol>
      </aside>
    </section>
  </main>
{:else}
  <div class="app-shell">
    <header class="app-masthead">
      <a class="wordmark" href="/" aria-label="f.ads home">f.ads</a>
      <nav aria-label="Primary navigation">
        {#each navigation as link}
          <a href={link.href} aria-current={activeSurface === link.surface ? "page" : undefined}>{link.label}</a>
        {/each}
      </nav>
      <span class="private-mark"><span aria-hidden="true">●</span> PRIVATE</span>
    </header>

    <p class="sr-status" aria-live="polite" role="status">{statusMessage}</p>

    <main id="main-content" class:reader-main={activeSurface === "edition"}>
      {#if activeSurface === "edition"}
        {#if !edition}
          <section class="start-edition" aria-labelledby="edition-start-title">
            <div class="issue-mark" aria-hidden="true">ISSUE<br />— NEW</div>
            <div class="start-copy">
              <p class="eyebrow">MAKE AN EDITION</p>
              <h1 id="edition-start-title">How should today’s reading feel?</h1>
              <p>Set the shape. The edition will stop after twelve items, often sooner.</p>
            </div>
            <form class="edition-controls" on:submit|preventDefault={makeEdition}>
              <label for="curiosity">
                <span><strong>Curiosity</strong><output for="curiosity">{describeControlValue("curiosity", curiosity)}</output></span>
                <input id="curiosity" type="range" min="0" max="100" bind:value={curiosity} aria-describedby="curiosity-description" />
                <small id="curiosity-description">Familiar <span>→</span> surprising</small>
              </label>
              <label for="energy">
                <span><strong>Energy</strong><output for="energy">{describeControlValue("energy", energy)}</output></span>
                <input id="energy" type="range" min="0" max="100" bind:value={energy} aria-describedby="energy-description" />
                <small id="energy-description">Light <span>→</span> demanding</small>
              </label>
              <button class="button primary" type="submit" disabled={creating}>Make an edition</button>
            </form>
          </section>
        {:else if atEnd}
          <section class="edition-end" aria-labelledby="edition-end-title">
            <p class="issue-number">ISSUE {formatDate(edition.edition.createdAt).toUpperCase()}</p>
            <h1 id="edition-end-title">That’s the edition.</h1>
            <p>You reached the deliberate end: {total} {total === 1 ? "item" : "items"}, selected for this moment.</p>
            <div class="summary-rule" aria-hidden="true"><span>{total}</span><span>Curiosity {edition.edition.curiosity}</span><span>Energy {edition.edition.energy}</span></div>
            <div class="end-actions">
              <a class="button primary" href="/keeps/">Visit your keeps</a>
              <button class="button quiet" type="button" on:click={() => { edition = undefined; atEnd = false; }}>Set another edition</button>
            </div>
          </section>
        {:else if item && frame}
          <section class="reading-frame" aria-labelledby="article-title">
            <article class="reading-canvas">
              <header class="article-meta">
                <div><span>{formatOf(item)}</span><span>{item.sourceId}</span></div>
                <p><span>{position + 1} of {total}</span><progress value={position + 1} max={total}>Item {position + 1} of {total}</progress></p>
              </header>
              <div class="article-body">
                <p class="published">{formatDate(item.publishedAt)} · {frame.frame}</p>
                <h1 id="article-title">{title}</h1>
                <SafeBlocks blocks={item.blocks} skipFirstHeading={true} />
              </div>
              <div class="feedback" aria-label="Tune this kind of recommendation">
                <p>Teach the next edition</p>
                <div>
                  <button type="button" on:click={() => react("more_like_this")}>More like this</button>
                  <button type="button" on:click={() => react("less_like_this")}>Less like this</button>
                  <button type="button" on:click={() => react("good_surprise")}>Good surprise</button>
                  <button type="button" on:click={() => react("not_now")}>Not now</button>
                  <button type="button" on:click={() => react("mute_source")}>Mute source</button>
                  <button class:chosen={kept.has(item.id)} type="button" on:click={() => react("keep")}>Keep</button>
                </div>
              </div>
            </article>

            <aside class:expanded={traceExpanded} class="trace-rail" aria-label="Why this item was selected">
              <button class="trace-toggle" type="button" aria-expanded={traceExpanded} on:click={() => traceExpanded = !traceExpanded}>Why this item?</button>
              <div class="trace-content">
                <p class="rail-label">DECISION TRACE</p>
                <p class="trace-intro">Visible ingredients, not a verdict.</p>
                <ol>
                  {#each frame.decisionTrace.factors as factor, index}
                    <li>
                      <span class="factor-number">{String(index + 1).padStart(2, "0")}</span>
                      <div><strong>{factor.factor}</strong><span>{factorPercent(factor)} influence</span></div>
                    </li>
                  {/each}
                </ol>
                <dl>
                  <div><dt>Curiosity</dt><dd>{edition.edition.curiosity}</dd></div>
                  <div><dt>Energy</dt><dd>{edition.edition.energy}</dd></div>
                  <div><dt>Source</dt><dd>{item.sourceId}</dd></div>
                </dl>
              </div>
            </aside>

            <nav class="reader-controls" aria-label="Edition controls">
              <button type="button" on:click={() => move("previous")} disabled={position === 0} aria-label="Previous item"><span aria-hidden="true">←</span> Previous</button>
              <span>{position + 1} / {total}</span>
              <button class="next" type="button" on:click={() => move("next")} aria-label={position === total - 1 ? "Finish edition" : "Next item"}>
                {position === total - 1 ? "Finish edition" : "Next"} <span aria-hidden="true">→</span>
              </button>
            </nav>
          </section>
        {:else}
          <section class="empty-state"><h1>This edition has no eligible items.</h1><p>Check source mutes and allowance labels, then make another edition.</p><a href="/settings/">Review allowances</a></section>
        {/if}
      {:else if activeSurface === "keeps"}
        <section class="library-surface" aria-labelledby="keeps-title">
          <header><p class="eyebrow">YOUR MARGINS</p><h1 id="keeps-title">Keeps</h1><p>Things worth returning to, newest first.</p></header>
          {#if kept.size === 0}
            <div class="empty-note"><p>Nothing kept yet.</p><a href="/">Open an edition and keep what stays with you.</a></div>
          {:else}
            <ol class="keep-list">{#each [...kept] as contentId}<li><span>RECENT</span><strong>{contentId}</strong><button type="button" on:click={() => { const next = new Set(kept); next.delete(contentId); kept = next; }}>Remove</button></li>{/each}</ol>
          {/if}
        </section>
      {:else if activeSurface === "sources"}
        <section class="management-surface" aria-labelledby="sources-title">
          <header><p class="eyebrow">WHAT MAY ENTER</p><h1 id="sources-title">Sources</h1><p>Your source list is private. A source must be allowed before it can appear.</p></header>
          <div class="management-grid">
            <section aria-labelledby="atproto-title"><p class="section-number">01 · SOCIAL</p><h2 id="atproto-title">ATProto</h2><p class="connection"><span aria-hidden="true">●</span> Connected as owner</p><div class="row-actions"><button class="button quiet" type="button">Refresh now</button><button class="text-button" type="button">Disconnect</button></div></section>
            <section aria-labelledby="rss-title"><p class="section-number">02 · PUBLICATIONS</p><h2 id="rss-title">RSS</h2><form on:submit|preventDefault={addSource}><label for="rss-url">Feed URL</label><div class="inline-field"><input id="rss-url" type="url" required placeholder="https://example.com/feed.xml" bind:value={rssUrl} /><button class="button primary" type="submit">Add source</button></div></form><div class="row-actions"><label class="button quiet" for="opml-file">Import OPML</label><input class="visually-hidden" id="opml-file" type="file" accept=".opml,.xml,text/xml" /><a class="text-button" href="/api/v1/sources.opml">Export OPML</a></div></section>
          </div>
          {#if rssSources.length}<ul class="source-list">{#each rssSources as source}<li><div><strong>{source.name}</strong><small>{source.url}</small></div><span>Refresh queued</span><button type="button" on:click={() => source.muted = !source.muted}>{source.muted ? "Unmute" : "Mute"}</button><button type="button" on:click={() => rssSources = rssSources.filter((item) => item !== source)}>Remove</button></li>{/each}</ul>{/if}
        </section>
      {:else if activeSurface === "garden"}
        <section class="management-surface" aria-labelledby="garden-title">
          <header><p class="eyebrow">TASTE, IN PLAIN SIGHT</p><h1 id="garden-title">Garden</h1><p>Interests you name outrank guesses. Suggestions wait for your say.</p></header>
          <div class="management-grid garden-grid">
            <section aria-labelledby="manual-title"><p class="section-number">ROOTED</p><h2 id="manual-title">Your interests</h2><ul class="tag-list">{#each manualInterests as interest}<li><span>{interest}</span><button type="button" aria-label={`Remove ${interest}`} on:click={() => manualInterests = manualInterests.filter((item) => item !== interest)}>×</button></li>{/each}</ul><form class="inline-field" on:submit|preventDefault={addInterest}><label class="visually-hidden" for="interest">New interest</label><input id="interest" name="interest" required placeholder="Add an interest" /><button class="button primary" type="submit">Add</button></form></section>
            <section aria-labelledby="suggestions-title"><p class="section-number">WAITING FOR YOU</p><h2 id="suggestions-title">Suggestions</h2>{#if suggestions.length}<ul class="suggestion-list">{#each suggestions as suggestion}<li><span><strong>{suggestion}</strong><small>Seen across 3 allowed sources</small></span><button type="button" aria-label={`Confirm ${suggestion}`} on:click={() => decideSuggestion(suggestion, true)}>Confirm</button><button type="button" aria-label={`Reject ${suggestion}`} on:click={() => decideSuggestion(suggestion, false)}>Dismiss</button></li>{/each}</ul>{:else}<p>Every suggestion has been decided.</p>{/if}</section>
          </div>
          <section class="learned" aria-labelledby="learned-title"><p class="section-number">DIRECTIONAL, NOT DEFINING</p><h2 id="learned-title">What your actions are changing</h2><dl><div><dt>Long-form essays</dt><dd><span style="--amount: 64%"></span>more often</dd></div><div><dt>Breaking news</dt><dd><span style="--amount: 28%"></span>less often</dd></div></dl></section>
        </section>
      {:else}
        <section class="management-surface settings" aria-labelledby="settings-title">
          <header><p class="eyebrow">BOUNDARIES &amp; PORTABILITY</p><h1 id="settings-title">Settings</h1><p>The guardrails stay explicit. Your private data stays portable.</p></header>
          <div class="settings-list">
            <section><div><p class="section-number">ALLOWANCES</p><h2>Content labels</h2><p>Excluded labels are hard gates, never ranking hints.</p></div><fieldset><legend class="visually-hidden">Excluded content labels</legend><label><input type="checkbox" checked /> Adult content</label><label><input type="checkbox" checked /> Graphic media</label><label><input type="checkbox" /> Political content</label></fieldset></section>
            <section><div><p class="section-number">OFFLINE</p><h2>Active edition only</h2><p>The shell and current edition can resume offline. OAuth, exports, and source data never enter the cache.</p></div><p class="connection"><span aria-hidden="true">●</span> Ready for offline resume</p></section>
            <section><div><p class="section-number">PORTABILITY</p><h2>Your private data</h2><p>Download a validated JSON copy whenever you want.</p></div><a class="button quiet" href="/api/v1/export" download>Export my data</a></section>
            <section class="danger-zone"><div><p class="section-number">RESET</p><h2>Start over carefully</h2><p>Reset learned taste while keeping manual interests, or explicitly erase everything.</p></div><div class="row-actions"><button class="button quiet" type="button">Reset learned taste</button><button class="text-button danger" type="button">Full reset…</button></div></section>
            <section><div><p class="section-number">SESSION</p><h2>Leave this device</h2></div><form method="post" action="/api/v1/logout"><button class="button primary" type="submit">Sign out</button></form></section>
          </div>
        </section>
      {/if}
    </main>
  </div>
{/if}
