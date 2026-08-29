<script lang="ts">
  import { onMount } from "svelte";

  import type { ContentEnvelope, KeepRecord, OwnerExport } from "../contracts";
  import {
    clearOfflineState,
    createIndexedDbOutbox,
    getOfflineEdition,
    getOfflineStatus,
    registerOfflineServiceWorker,
    replayOfflineMutations,
  } from "../modules/offline";
  import { discardFailedChanges, resetFailedChangesForRetry } from "./offline-resolution";
  import { createBrowserUiClient } from "./api-client";
  import type {
    ActiveEditionView,
    FadsUiClient,
    FeedbackKind,
    Surface,
  } from "./models";
  import { describeControlValue, describeDecisionFactor, moveReader } from "./reading";
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
  let keeps: KeepRecord[] = [];
  let keptContent: ContentEnvelope[] = [];
  let manualInterests: Awaited<ReturnType<FadsUiClient["listInterests"]>> = [];
  let suggestions: Awaited<ReturnType<FadsUiClient["listSuggestions"]>> = [];
  let rssSources: Awaited<ReturnType<FadsUiClient["listSources"]>> = [];
  let preferences = { blockedLabels: [] as string[], mutedSourceIds: [] as string[] };
  let rssUrl = "";
  let managementLoading = false;
  let surfaceLoadState: "idle" | "loading" | "ready" | "error" = "idle";
  let surfaceLoadError = "";
  let atprotoAdding = false;
  let preferencesSaving = false;
  let blockedLabelDraft = "";
  let offlineRegistration: ServiceWorkerRegistration | undefined;
  let offlineState: "checking" | "ready" | "unavailable" = "checking";
  let offlinePending = 0;
  let offlineFailed = 0;
  let offlineResolving = false;
  let ownerDid = "";
  let resetDialog: HTMLDialogElement;
  let resetConfirmButton: HTMLButtonElement;
  let offlineFailureDialog: HTMLDialogElement;
  let offlineDiscardButton: HTMLButtonElement;

  let offlineRegistrationPromise: Promise<ServiceWorkerRegistration | undefined> | undefined;
  function ensureOfflineRegistration() {
    offlineRegistrationPromise ??= registerOfflineServiceWorker().catch(() => undefined);
    return offlineRegistrationPromise;
  }

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
  $: atprotoSource = rssSources.find((source) => source.adapter === "atproto");

  async function refreshOfflineQueueStatus(): Promise<void> {
    try {
      const status = await getOfflineStatus();
      offlinePending = status.pending;
      offlineFailed = status.failed;
    } catch {
      offlinePending = 0;
      offlineFailed = 0;
    }
  }

  onMount(async () => {
    offlineRegistration = await ensureOfflineRegistration();
    offlineState = offlineRegistration ? "ready" : "unavailable";
    await refreshOfflineQueueStatus();
    const uiClient = client ?? createBrowserUiClient();
    client = uiClient;
    try {
      const inspected = await uiClient.session();
      session = inspected.authenticated ? "authenticated" : "signed-out";
      ownerDid = inspected.did ?? "";
      if (session === "authenticated" && activeSurface === "edition") {
        edition = await uiClient.activeEdition();
        atEnd = edition?.completed ?? false;
        const [sourceResult, keepResult] = await Promise.allSettled([
          uiClient.listSources(),
          uiClient.listKeeps(),
        ]);
        if (sourceResult.status === "fulfilled") rssSources = sourceResult.value;
        if (keepResult.status === "fulfilled") {
          keeps = keepResult.value.keeps;
          keptContent = keepResult.value.content;
        }
      } else if (session === "authenticated") {
        await loadSurface(uiClient);
      }
    } catch (error) {
      const cached =
        activeSurface === "edition"
          ? await getOfflineEdition<ActiveEditionView>().catch(() => undefined)
          : undefined;
      if (cached) {
        session = "authenticated";
        edition = cached;
        atEnd = cached.completed;
        statusMessage = "Offline edition resumed. Changes will sync when you reconnect.";
      } else {
        session = "signed-out";
        loadError =
          error instanceof Error && error.message === "Your session expired."
            ? error.message
            : "The private API could not be reached, and no offline edition is available.";
      }
    }
    window.addEventListener("online", () => {
      window.setTimeout(() => void refreshOfflineQueueStatus(), 500);
    });
  });

  async function loadSurface(uiClient: FadsUiClient) {
    managementLoading = true;
    surfaceLoadState = "loading";
    surfaceLoadError = "";
    try {
      if (activeSurface === "keeps") {
        const library = await uiClient.listKeeps();
        keeps = library.keeps;
        keptContent = library.content;
      }
      if (activeSurface === "sources") {
        [rssSources, preferences] = await Promise.all([
          uiClient.listSources(),
          uiClient.getPreferences(),
        ]);
      }
      if (activeSurface === "garden") {
        [manualInterests, suggestions] = await Promise.all([
          uiClient.listInterests(),
          uiClient.listSuggestions(),
        ]);
      }
      if (activeSurface === "settings") preferences = await uiClient.getPreferences();
      surfaceLoadState = "ready";
    } catch (error) {
      const surfaceName = activeSurface[0].toUpperCase() + activeSurface.slice(1);
      const detail = error instanceof Error ? error.message : "The private API could not be reached.";
      surfaceLoadState = "error";
      surfaceLoadError = `${surfaceName} could not be loaded. ${detail}`;
      statusMessage = surfaceLoadError;
    } finally {
      managementLoading = false;
    }
  }

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
    const previousPosition = edition.position;
    edition = { ...edition, position: next.position };
    statusMessage = `Item ${next.position + 1} of ${total}.`;
    try {
      await client.setProgress(edition.edition.id, next.position);
      await refreshOfflineQueueStatus();
      if (offlinePending > 0) {
        statusMessage = `Item ${next.position + 1} of ${total}. ${offlinePending} change${offlinePending === 1 ? " is" : "s are"} waiting to sync.`;
      }
    } catch (error) {
      edition = { ...edition, position: previousPosition };
      statusMessage = error instanceof Error ? error.message : "Progress will be saved when online.";
    }
  }

  async function react(kind: FeedbackKind) {
    if (!edition || !item || !client) return;
    const wasKept = keeps.some((keep) => keep.contentId === item.id);
    if (kind === "keep") {
      if (!wasKept) {
        keeps = [{ ownerId: "", contentId: item.id, keptAt: new Date().toISOString() }, ...keeps];
        keptContent = [item, ...keptContent.filter((content) => content.id !== item.id)];
      }
    }
    statusMessage = kind === "keep" ? "Kept for later." : "Noted. Your taste changed a little.";
    try {
      await client.interact({
        editionId: edition.edition.id,
        contentId: item.id,
        sourceId: item.sourceId,
        kind,
      });
      await refreshOfflineQueueStatus();
      if (offlinePending > 0) {
        statusMessage = `${offlinePending} change${offlinePending === 1 ? " is" : "s are"} waiting to sync.`;
      }
    } catch (error) {
      if (kind === "keep" && !wasKept) {
        keeps = keeps.filter((keep) => keep.contentId !== item.id);
        keptContent = keptContent.filter((content) => content.id !== item.id);
      }
      statusMessage = error instanceof Error ? error.message : "Feedback will be sent when online.";
    }
  }

  async function addSource() {
    if (!client) return;
    const value = rssUrl.trim();
    if (!value) return;
    try {
      const added = await client.addSource({ adapter: "rss", displayName: new URL(value).hostname, url: value });
      rssSources = [added, ...rssSources];
      rssUrl = "";
      statusMessage = "RSS source added.";
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The source could not be added.";
    }
  }

  async function addAtprotoHomeFeed() {
    if (!client || atprotoAdding || atprotoSource) return;
    atprotoAdding = true;
    try {
      const added = await client.addSource({
        adapter: "atproto",
        displayName: "ATProto home feed",
        config: {},
      });
      rssSources = [added, ...rssSources];
      try {
        const queued = await client.refreshSource(added.id);
        rssSources = rssSources.map((source) => (source.id === queued.id ? queued : source));
        statusMessage = "Source refresh queued.";
      } catch (error) {
        statusMessage =
          error instanceof Error
            ? `Home feed added, but refresh was not queued: ${error.message}`
            : "Home feed added, but refresh was not queued.";
      }
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The ATProto home feed could not be added.";
    } finally {
      atprotoAdding = false;
    }
  }

  async function addInterest(event: SubmitEvent) {
    if (!client) return;
    const form = event.currentTarget as HTMLFormElement;
    const input = new FormData(form).get("interest")?.toString().trim();
    if (!input || manualInterests.some((interest) => interest.value === input)) return;
    try {
      const added = await client.addInterest(input);
      manualInterests = [...manualInterests, added];
      form.reset();
      statusMessage = `${input} added to your garden.`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The interest could not be added.";
    }
  }

  async function decideSuggestion(suggestion: (typeof suggestions)[number], decision: "confirm" | "reject") {
    if (!client) return;
    suggestions = suggestions.filter((item) => item.id !== suggestion.id);
    try {
      await client.decideSuggestion(suggestion.id, decision);
      statusMessage = decision === "confirm" ? `${suggestion.value} confirmed.` : `${suggestion.value} dismissed.`;
    } catch (error) {
      suggestions = [...suggestions, suggestion];
      statusMessage = error instanceof Error ? error.message : "The suggestion could not be updated.";
    }
  }

  async function removeKeep(contentId: string) {
    if (!client) return;
    const previous = keeps;
    keeps = keeps.filter((keep) => keep.contentId !== contentId);
    const previousContent = keptContent;
    keptContent = keptContent.filter((content) => content.id !== contentId);
    try {
      await client.removeKeep(contentId);
      statusMessage = "Keep removed.";
    } catch (error) {
      keeps = previous;
      keptContent = previousContent;
      statusMessage = error instanceof Error ? error.message : "The keep could not be removed.";
    }
  }

  async function removeSource(sourceId: string) {
    if (!client) return;
    const previous = rssSources;
    rssSources = rssSources.filter((source) => source.id !== sourceId);
    try {
      await client.removeSource(sourceId);
      statusMessage = "Source removed.";
    } catch (error) {
      rssSources = previous;
      statusMessage = error instanceof Error ? error.message : "The source could not be removed.";
    }
  }

  async function refreshSource(sourceId: string) {
    if (!client) return;
    try {
      const refreshed = await client.refreshSource(sourceId);
      rssSources = rssSources.map((source) => source.id === sourceId ? refreshed : source);
      statusMessage = "Source refresh queued.";
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The source could not be refreshed.";
    }
  }

  async function toggleSourceMute(sourceId: string) {
    if (!client) return;
    const previous = preferences;
    const muted = preferences.mutedSourceIds.includes(sourceId);
    preferences = { ...preferences, mutedSourceIds: muted ? preferences.mutedSourceIds.filter((id) => id !== sourceId) : [...preferences.mutedSourceIds, sourceId] };
    try {
      preferences = await client.muteSource(sourceId, !muted, preferences);
      statusMessage = muted ? "Source unmuted." : "Source muted.";
    } catch (error) {
      preferences = previous;
      statusMessage = error instanceof Error ? error.message : "The source mute could not be saved.";
    }
  }

  async function saveBlockedLabels(blockedLabels: string[]) {
    if (!client || surfaceLoadState !== "ready" || preferencesSaving) return;
    const previous = preferences;
    preferencesSaving = true;
    try {
      preferences = await client.savePreferences({ ...preferences, blockedLabels });
      statusMessage = "Allowances saved.";
    } catch (error) {
      preferences = previous;
      statusMessage = error instanceof Error ? error.message : "Allowances could not be saved.";
    } finally {
      preferencesSaving = false;
    }
  }

  async function addBlockedLabel(event: SubmitEvent) {
    event.preventDefault();
    const value = blockedLabelDraft.trim();
    if (!value || preferences.blockedLabels.includes(value)) return;
    await saveBlockedLabels([...preferences.blockedLabels, value]);
    if (preferences.blockedLabels.includes(value)) blockedLabelDraft = "";
  }

  async function removeBlockedLabel(value: string) {
    await saveBlockedLabels(preferences.blockedLabels.filter((label) => label !== value));
  }

  async function removeInterest(id: string) {
    if (!client) return;
    const previous = manualInterests;
    manualInterests = manualInterests.filter((interest) => interest.id !== id);
    try {
      await client.removeInterest(id);
      statusMessage = "Interest removed.";
    } catch (error) {
      manualInterests = previous;
      statusMessage = error instanceof Error ? error.message : "The interest could not be removed.";
    }
  }

  async function importOpmlFile(event: Event) {
    if (!client) return;
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imported = await client.importOpml(await file.text());
      rssSources = [...imported.sources, ...rssSources];
      statusMessage = `${imported.sources.length} source${imported.sources.length === 1 ? "" : "s"} imported.`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The OPML file could not be imported.";
    } finally {
      input.value = "";
    }
  }

  async function downloadExport() {
    if (!client) return;
    try {
      const exported: OwnerExport = await client.exportData();
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "fads-private-export.json";
      anchor.click();
      URL.revokeObjectURL(url);
      statusMessage = "Private data exported.";
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "The export could not be downloaded.";
    }
  }

  async function resetLearnedTaste() {
    if (!client) return;
    try {
      await client.reset(false);
      statusMessage = "Learned taste reset. Your explicit interests remain.";
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "Learned taste could not be reset.";
    }
  }

  async function retryFailedOfflineChanges() {
    if (offlineResolving) return;
    offlineResolving = true;
    try {
      const store = createIndexedDbOutbox();
      const reset = await resetFailedChangesForRetry(store);
      const result = await replayOfflineMutations(store);
      await refreshOfflineQueueStatus();
      statusMessage = result.failed
        ? "The server still rejected an offline change. You can retry or discard it."
        : `${reset} failed offline change${reset === 1 ? "" : "s"} retried.`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "Offline changes could not be retried.";
    } finally {
      offlineResolving = false;
    }
  }

  function askToDiscardFailedChanges() {
    offlineFailureDialog.showModal();
    window.requestAnimationFrame(() => offlineDiscardButton.focus());
  }

  async function discardFailedOfflineChanges() {
    if (offlineResolving) return;
    offlineResolving = true;
    try {
      const discarded = await discardFailedChanges(createIndexedDbOutbox());
      await refreshOfflineQueueStatus();
      offlineFailureDialog.close();
      statusMessage = `${discarded} failed offline change${discarded === 1 ? "" : "s"} discarded.`;
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "Failed offline changes could not be discarded.";
    } finally {
      offlineResolving = false;
    }
  }

  function askForFullReset() {
    resetDialog.showModal();
    window.requestAnimationFrame(() => resetConfirmButton.focus());
  }

  function cancelFullReset() {
    resetDialog.close();
  }

  async function fullReset() {
    if (!client) return;
    try {
      await client.reset(true);
      await clearOfflineState(offlineRegistration);
      resetDialog.close();
      statusMessage = "All private data was erased.";
      window.location.assign("/");
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : "Full reset could not be completed.";
    }
  }

  async function signOut() {
    if (!client) return;
    const [remoteResult, localResult] = await Promise.allSettled([
      client.logout(),
      clearOfflineState(offlineRegistration),
    ]);
    const remoteError = remoteResult.status === "rejected" ? remoteResult.reason : undefined;
    if (localResult.status === "fulfilled") {
      session = "signed-out";
      ownerDid = "";
      edition = undefined;
      keeps = [];
      keptContent = [];
      statusMessage = "";
      loadError = remoteError
        ? "Private offline data was cleared, but server sign-out could not be confirmed. Reconnect and sign out again to end the server session."
        : "";
    } else {
      statusMessage = remoteError
        ? "Server sign-out and local private-data clearing both failed. Try again before leaving this device."
        : localResult.reason instanceof Error
          ? `Server sign-out succeeded, but local private data could not be cleared: ${localResult.reason.message}`
          : "Server sign-out succeeded, but local private data could not be cleared.";
    }
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
  }

  function contentTitle(content: ContentEnvelope): string {
    return content.blocks.find((block) => block.kind === "heading")?.text ?? "Untitled";
  }

  function contentPreview(content: ContentEnvelope): string {
    return content.blocks.find((block) => block.kind === "paragraph")?.text ?? "Saved for later.";
  }

  function formatOf(content: ContentEnvelope): string {
    if (
      content.blocks.some((block) => block.kind === "video") ||
      content.media.some((attachment) => attachment.kind === "video")
    ) return "VIDEO";
    if (
      content.blocks.some((block) => block.kind === "audio") ||
      content.media.some((attachment) => attachment.kind === "audio")
    ) return "AUDIO";
    return "READ";
  }

  function sourceDisplayName(
    sourceId: string,
    sources: typeof rssSources,
    canonicalUri?: string,
  ): string {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (source) return source.displayName;
    if (canonicalUri?.startsWith("at://")) return "ATProto";
    try {
      const url = new URL(canonicalUri ?? "");
      if (url.protocol === "http:" || url.protocol === "https:") return url.hostname;
    } catch {
      // Fall through to a truthful generic label.
    }
    return "Unknown source";
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

    {#if statusMessage}<p class="status-banner" aria-live="polite" role="status">{statusMessage}</p>{/if}

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
                <div><span>{formatOf(item)}</span><span>{sourceDisplayName(item.sourceId, rssSources, item.canonicalUri)}</span></div>
                <p><span>{position + 1} of {total}</span><progress value={position + 1} max={total}>Item {position + 1} of {total}</progress></p>
              </header>
              <div class="article-body">
                <p class="published">{formatDate(item.publishedAt)} · {frame.frame}</p>
                <h1 id="article-title">{title}</h1>
                <SafeBlocks blocks={item.blocks} media={item.media} skipFirstHeading={true} />
              </div>
              <div class="feedback" aria-label="Tune this kind of recommendation">
                <p>Teach the next edition</p>
                <div>
                  <button type="button" on:click={() => react("more_like_this")}>More like this</button>
                  <button type="button" on:click={() => react("less_like_this")}>Less like this</button>
                  <button type="button" on:click={() => react("good_surprise")}>Good surprise</button>
                  <button type="button" on:click={() => react("not_now")}>Not now</button>
                  <button type="button" on:click={() => react("mute_source")}>Mute source</button>
                  <button class:chosen={keeps.some((keep) => keep.contentId === item.id)} aria-pressed={keeps.some((keep) => keep.contentId === item.id)} type="button" on:click={() => react("keep")}>Keep</button>
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
                      <div><strong>{factor.factor}</strong><span>{describeDecisionFactor(factor)}</span></div>
                    </li>
                  {/each}
                </ol>
                <dl>
                  <div><dt>Curiosity</dt><dd>{edition.edition.curiosity}</dd></div>
                  <div><dt>Energy</dt><dd>{edition.edition.energy}</dd></div>
                  <div><dt>Source</dt><dd>{sourceDisplayName(item.sourceId, rssSources, item.canonicalUri)}</dd></div>
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
          {#if managementLoading}
            <p class="empty-note" role="status">Loading your keeps…</p>
          {:else if surfaceLoadState === "error"}
            <p class="empty-note notice" role="alert">{surfaceLoadError}</p>
          {:else if keeps.length === 0}
            <div class="empty-note"><p>Nothing kept yet.</p><a href="/">Open an edition and keep what stays with you.</a></div>
          {:else}
            <ol class="keep-list">{#each keeps as keep}{@const content = keptContent.find((item) => item.id === keep.contentId)}<li><span>{formatDate(keep.keptAt)}</span><div><h2>{content ? contentTitle(content) : "Unavailable item"}</h2>{#if content}<p>{contentPreview(content)}</p><small>{sourceDisplayName(content.sourceId, rssSources, content.canonicalUri)}</small><details class="keep-content"><summary>Read saved item</summary><SafeBlocks blocks={content.blocks} media={content.media} skipFirstHeading={true} /></details>{/if}</div><button type="button" on:click={() => removeKeep(keep.contentId)}>Remove</button></li>{/each}</ol>
          {/if}
        </section>
      {:else if activeSurface === "sources"}
        <section class="management-surface" aria-labelledby="sources-title">
          <header><p class="eyebrow">WHAT MAY ENTER</p><h1 id="sources-title">Sources</h1><p>Your source list is private. A source must be allowed before it can appear.</p></header>
          {#if surfaceLoadState === "loading"}<p role="status">Loading your sources…</p>{:else if surfaceLoadState === "error"}<p class="empty-note notice" role="alert">{surfaceLoadError}</p>{:else}
          <div class="management-grid">
            <section aria-labelledby="atproto-title"><p class="section-number">01 · SOCIAL</p><h2 id="atproto-title">ATProto</h2><p class="connection"><span aria-hidden="true">●</span> Signed in{ownerDid ? ` as ${ownerDid}` : ""}</p><p class="muted-note">Source sync uses the configured owner’s ATProto OAuth session.</p>{#if atprotoSource}<button class="button quiet" type="button" on:click={() => refreshSource(atprotoSource.id)}>Refresh home feed</button>{:else}<button class="button primary" type="button" disabled={atprotoAdding} on:click={addAtprotoHomeFeed}>Add ATProto home feed</button>{/if}</section>
            <section aria-labelledby="rss-title"><p class="section-number">02 · PUBLICATIONS</p><h2 id="rss-title">RSS</h2><form on:submit|preventDefault={addSource}><label for="rss-url">Feed URL</label><div class="inline-field"><input id="rss-url" type="url" required placeholder="https://example.com/feed.xml" bind:value={rssUrl} /><button class="button primary" type="submit">Add source</button></div></form><div class="row-actions"><label class="button quiet" for="opml-file">Import OPML</label><input class="visually-hidden" id="opml-file" type="file" accept=".opml,.xml,text/xml" on:change={importOpmlFile} /><button class="text-button" type="button" on:click={async () => { if (!client) return; try { const opml = await client.exportOpml(); const blob = new Blob([opml], { type: "text/x-opml" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "fads-sources.opml"; anchor.click(); URL.revokeObjectURL(url); statusMessage = "OPML exported."; } catch (error) { statusMessage = error instanceof Error ? error.message : "OPML export failed."; } }}>Export OPML</button></div></section>
          </div>
          {#if rssSources.length}<ul class="source-list">{#each rssSources as source}<li><div><strong>{source.displayName}</strong><small>{source.url ?? "ATProto"}</small></div><span>{source.status === "error" ? source.lastError : source.status}</span><button type="button" on:click={() => refreshSource(source.id)}>Refresh</button><button type="button" on:click={() => toggleSourceMute(source.id)}>{preferences.mutedSourceIds.includes(source.id) ? "Unmute" : "Mute"}</button><button type="button" on:click={() => removeSource(source.id)}>Remove</button></li>{/each}</ul>{:else if !managementLoading}<p class="empty-note">No sources yet. Add an ATProto home feed, RSS URL, or OPML file.</p>{/if}
          {/if}
        </section>
      {:else if activeSurface === "garden"}
        <section class="management-surface" aria-labelledby="garden-title">
          <header><p class="eyebrow">TASTE, IN PLAIN SIGHT</p><h1 id="garden-title">Garden</h1><p>Interests you name outrank guesses. Suggestions wait for your say.</p></header>
          {#if surfaceLoadState === "loading"}<p role="status">Loading your garden…</p>{:else if surfaceLoadState === "error"}<p class="empty-note notice" role="alert">{surfaceLoadError}</p>{:else}
          <div class="management-grid garden-grid">
            <section aria-labelledby="manual-title"><p class="section-number">ROOTED</p><h2 id="manual-title">Your interests</h2><ul class="tag-list">{#each manualInterests as interest}<li><span>{interest.value}</span><button type="button" aria-label={`Remove ${interest.value}`} on:click={() => removeInterest(interest.id)}>×</button></li>{/each}</ul><form class="inline-field" on:submit|preventDefault={addInterest}><label class="visually-hidden" for="interest">New interest</label><input id="interest" name="interest" required placeholder="Add an interest" /><button class="button primary" type="submit">Add</button></form></section>
            <section aria-labelledby="suggestions-title"><p class="section-number">WAITING FOR YOU</p><h2 id="suggestions-title">Suggestions</h2>{#if suggestions.length}<ul class="suggestion-list">{#each suggestions as suggestion}<li><span><strong>{suggestion.value}</strong><small>Seen across {suggestion.evidenceCount} allowed sources</small></span><button type="button" aria-label={`Confirm ${suggestion.value}`} on:click={() => decideSuggestion(suggestion, "confirm")}>Confirm</button><button type="button" aria-label={`Reject ${suggestion.value}`} on:click={() => decideSuggestion(suggestion, "reject")}>Dismiss</button></li>{/each}</ul>{:else}<p>Every suggestion has been decided.</p>{/if}</section>
          </div>
          <section class="learned" aria-labelledby="learned-title"><p class="section-number">DIRECTIONAL, NOT DEFINING</p><h2 id="learned-title">What your actions are changing</h2><p>Your edition reactions adjust future ranking. The exact stored adjustments are included in your private export; a live inspection view is not available yet.</p></section>
          {/if}
        </section>
      {:else}
        <section class="management-surface settings" aria-labelledby="settings-title">
          <header><p class="eyebrow">BOUNDARIES &amp; PORTABILITY</p><h1 id="settings-title">Settings</h1><p>The guardrails stay explicit. Your private data stays portable.</p></header>
          <div class="settings-list">
            <section><div><p class="section-number">ALLOWANCES</p><h2>Content labels</h2><p>Exact source labels are hard gates, never ranking hints.</p></div>{#if surfaceLoadState === "loading"}<p role="status">Loading your allowances…</p>{:else if surfaceLoadState === "error"}<p class="notice" role="alert">{surfaceLoadError}</p>{:else}<div><ul class="tag-list" aria-label="Blocked content labels">{#each preferences.blockedLabels as label}<li><span>{label}</span><button type="button" disabled={preferencesSaving} aria-label={`Allow ${label}`} on:click={() => removeBlockedLabel(label)}>×</button></li>{/each}</ul>{#if preferences.blockedLabels.length === 0}<p>No content labels are blocked.</p>{/if}<form class="inline-field" on:submit={addBlockedLabel}><label class="visually-hidden" for="blocked-label">Label to block</label><input id="blocked-label" maxlength="120" required placeholder="Exact label, e.g. graphic-media" bind:value={blockedLabelDraft} /><button class="button quiet" type="submit" disabled={preferencesSaving}>Block label</button></form></div>{/if}</section>
            <section><div><p class="section-number">OFFLINE</p><h2>Active edition only</h2><p>The shell and current edition can resume offline. OAuth, exports, and source data never enter the cache.</p></div><div><p class="connection"><span aria-hidden="true">●</span> {offlineState === "ready" ? "Offline cache active" : offlineState === "checking" ? "Checking offline cache" : "Offline cache unavailable"}</p>{#if offlinePending > 0}<p>{offlinePending} change{offlinePending === 1 ? " is" : "s are"} waiting to sync.</p>{/if}{#if offlineFailed > 0}<p class="notice" role="alert">{offlineFailed} offline change{offlineFailed === 1 ? " needs" : "s need"} attention after the server rejected it.</p><div class="row-actions"><button class="button quiet" type="button" disabled={offlineResolving} on:click={retryFailedOfflineChanges}>Retry failed changes</button><button class="text-button danger" type="button" disabled={offlineResolving} on:click={askToDiscardFailedChanges}>Discard failed changes…</button></div>{/if}</div></section>
            <section><div><p class="section-number">PORTABILITY</p><h2>Your private data</h2><p>Download a validated JSON copy whenever you want.</p></div><button class="button quiet" type="button" on:click={downloadExport}>Export my data</button></section>
            <section class="danger-zone"><div><p class="section-number">RESET</p><h2>Start over carefully</h2><p>Reset learned taste while keeping manual interests, or explicitly erase everything.</p></div><div class="row-actions"><button class="button quiet" type="button" on:click={resetLearnedTaste}>Reset learned taste</button><button class="text-button danger" type="button" on:click={askForFullReset}>Full reset…</button></div></section>
            <section><div><p class="section-number">SESSION</p><h2>Leave this device</h2></div><button class="button primary" type="button" on:click={signOut}>Sign out</button></section>
          </div>
        </section>
      {/if}
    </main>
    <dialog bind:this={resetDialog} aria-labelledby="reset-dialog-title" on:cancel={cancelFullReset}>
      <p class="section-number">IRREVERSIBLE RESET</p>
      <h2 id="reset-dialog-title">Erase all private data?</h2>
      <p>This removes sources, interests, editions, keeps, reactions, and cached private content. It cannot be undone.</p>
      <div class="row-actions">
        <button class="button quiet" type="button" on:click={cancelFullReset}>Cancel</button>
        <button bind:this={resetConfirmButton} class="button danger-button" type="button" on:click={fullReset}>Erase everything</button>
      </div>
    </dialog>
    <dialog bind:this={offlineFailureDialog} aria-labelledby="offline-failure-dialog-title">
      <p class="section-number">OFFLINE CHANGES</p>
      <h2 id="offline-failure-dialog-title">Discard failed changes?</h2>
      <p>This removes only changes the server rejected. Later pending changes will remain available to sync.</p>
      <div class="row-actions">
        <button class="button quiet" type="button" on:click={() => offlineFailureDialog.close()}>Cancel</button>
        <button bind:this={offlineDiscardButton} class="button danger-button" type="button" disabled={offlineResolving} on:click={discardFailedOfflineChanges}>Discard failed changes</button>
      </div>
    </dialog>
  </div>
{/if}
