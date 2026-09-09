<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import type { ContentEnvelope, KeepRecord, OwnerExport } from "../contracts";
  import {
    clearOfflineState,
    createIndexedDbOutbox,
    getOfflineEdition,
    getOfflineSession,
    getOfflineStatus,
    registerOfflineServiceWorker,
    replayOfflineMutations,
    setOfflineSession,
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
  import Reader from "./reader/Reader.svelte";
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
  let learnedPreferences: Record<string, number> = {};
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
  let sourceRemovalDialog: HTMLDialogElement;
  let sourcePendingRemoval: (typeof rssSources)[number] | undefined;
  let sessionExpiryTimer: number | undefined;
  let onlineListener: (() => void) | undefined;
  let sessionExpiredListener: (() => void) | undefined;
  let sessionGeneration = 0;

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
  $: readerSourceName = createSourceResolver(rssSources);
  let sourcePollTimer: ReturnType<typeof setTimeout> | undefined;
  let sourcePollActive = false;
  let destroyed = false;
  $: scheduleSourceStatus(session, rssSources);

  function scheduleSourceStatus(currentSession: typeof session, sources: typeof rssSources) {
    if (typeof window === "undefined" || destroyed) return;
    if (currentSession !== "authenticated" || activeSurface !== "sources" || !sources.some((source) => ["queued", "syncing"].includes(source.status))) {
      if (sourcePollTimer) clearTimeout(sourcePollTimer);
      sourcePollTimer = undefined;
      return;
    }
    if (sourcePollTimer || sourcePollActive) return;
    sourcePollTimer = setTimeout(async () => {
      sourcePollTimer = undefined;
      if (!client || destroyed || session !== "authenticated") return;
      sourcePollActive = true;
      const snapshot = rssSources;
      const generation = sessionGeneration;
      try {
        const updated = await client.listSources();
        if (!destroyed && session === "authenticated" && sessionGeneration === generation && rssSources === snapshot) rssSources = updated;
      } catch {
        // Keep the last known status; another bounded poll can recover a transient failure.
      } finally {
        sourcePollActive = false;
        scheduleSourceStatus(session, rssSources);
      }
    }, 2_000);
  }

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

  function clearVisibleSession(message = "") {
    sessionGeneration += 1;
    if (sessionExpiryTimer !== undefined) window.clearTimeout(sessionExpiryTimer);
    sessionExpiryTimer = undefined;
    session = "signed-out";
    ownerDid = "";
    edition = undefined;
    atEnd = false;
    keeps = [];
    keptContent = [];
    manualInterests = [];
    suggestions = [];
    learnedPreferences = {};
    rssSources = [];
    preferences = { blockedLabels: [], mutedSourceIds: [] };
    sourcePendingRemoval = undefined;
    managementLoading = false;
    surfaceLoadState = "idle";
    surfaceLoadError = "";
    offlinePending = 0;
    offlineFailed = 0;
    statusMessage = "";
    loadError = message;
  }

  async function expireVisibleSession(message = "Your session expired.") {
    clearVisibleSession(message);
    await clearOfflineState(offlineRegistration).catch(() => undefined);
  }

  function scheduleSessionExpiry(expiresAt: string) {
    if (sessionExpiryTimer !== undefined) window.clearTimeout(sessionExpiryTimer);
    const deadline = Date.parse(expiresAt);
    const remaining = deadline - Date.now();
    if (!Number.isFinite(deadline) || remaining <= 0) {
      void expireVisibleSession();
      return;
    }
    sessionExpiryTimer = window.setTimeout(() => void expireVisibleSession(), remaining);
  }

  onMount(async () => {
    offlineRegistration = await ensureOfflineRegistration();
    offlineState = offlineRegistration ? "ready" : "unavailable";
    onlineListener = () => {
      window.setTimeout(() => void refreshOfflineQueueStatus(), 500);
    };
    sessionExpiredListener = () => void expireVisibleSession();
    window.addEventListener("online", onlineListener);
    window.addEventListener("fads:session-expired", sessionExpiredListener);
    const uiClient = client ?? createBrowserUiClient();
    client = uiClient;
    const startupGeneration = sessionGeneration;
    try {
      const inspected = await uiClient.session();
      if (!inspected.authenticated) {
        clearVisibleSession();
        await clearOfflineState(offlineRegistration).catch(() => undefined);
        return;
      }
      if (!inspected.did || !inspected.expiresAt) throw new Error("Invalid session response.");
      session = "authenticated";
      ownerDid = inspected.did;
      try {
        await setOfflineSession(
          { did: inspected.did, expiresAt: inspected.expiresAt },
          offlineRegistration,
        );
      } catch {
        offlineState = "unavailable";
      }
      scheduleSessionExpiry(inspected.expiresAt);
      await refreshOfflineQueueStatus();
      if (sessionGeneration !== startupGeneration || session !== "authenticated") return;
      if (activeSurface === "edition") {
        const loadedEdition = await uiClient.activeEdition();
        if (sessionGeneration !== startupGeneration || session !== "authenticated") return;
        edition = loadedEdition;
        atEnd = edition?.completed ?? false;
        const [sourceResult, keepResult] = await Promise.allSettled([
          uiClient.listSources(),
          uiClient.listKeeps(),
        ]);
        if (sessionGeneration !== startupGeneration || session !== "authenticated") return;
        if (sourceResult.status === "fulfilled") rssSources = sourceResult.value;
        if (keepResult.status === "fulfilled") {
          keeps = keepResult.value.keeps;
          keptContent = keepResult.value.content;
        }
      } else {
        await loadSurface(uiClient, startupGeneration);
      }
    } catch (error) {
      if (sessionGeneration !== startupGeneration) return;
      if (error instanceof Error && error.message === "Your session expired.") {
        await expireVisibleSession(error.message);
        return;
      }
      const [cached, storedSession] = await Promise.all([
        activeSurface === "edition"
          ? getOfflineEdition<ActiveEditionView>().catch(() => undefined)
          : Promise.resolve(undefined),
        getOfflineSession().catch(() => undefined),
      ]);
      if (sessionGeneration !== startupGeneration) return;
      if (cached && storedSession) {
        session = "authenticated";
        ownerDid = storedSession.did;
        edition = cached;
        atEnd = cached.completed;
        scheduleSessionExpiry(storedSession.expiresAt);
        await refreshOfflineQueueStatus();
        if (sessionGeneration !== startupGeneration || session !== "authenticated") return;
        statusMessage = "Offline edition resumed. Changes will sync when you reconnect.";
      } else {
        clearVisibleSession(
          "The private API could not be reached, and no offline edition is available.",
        );
      }
    }
  });

  onDestroy(() => {
    destroyed = true;
    sessionGeneration += 1;
    if (sourcePollTimer) clearTimeout(sourcePollTimer);
    if (sessionExpiryTimer !== undefined) window.clearTimeout(sessionExpiryTimer);
    if (onlineListener) window.removeEventListener("online", onlineListener);
    if (sessionExpiredListener)
      window.removeEventListener("fads:session-expired", sessionExpiredListener);
  });

  async function loadSurface(uiClient: FadsUiClient, expectedGeneration = sessionGeneration) {
    managementLoading = true;
    surfaceLoadState = "loading";
    surfaceLoadError = "";
    try {
      if (activeSurface === "keeps") {
        const library = await uiClient.listKeeps();
        if (sessionGeneration !== expectedGeneration || session !== "authenticated") return;
        keeps = library.keeps;
        keptContent = library.content;
      }
      if (activeSurface === "sources") {
        const [loadedSources, loadedPreferences] = await Promise.all([
          uiClient.listSources(),
          uiClient.getPreferences(),
        ]);
        if (sessionGeneration !== expectedGeneration || session !== "authenticated") return;
        rssSources = loadedSources;
        preferences = loadedPreferences;
      }
      if (activeSurface === "garden") {
        const [loadedInterests, loadedSuggestions, loadedPreferences, loadedSources] =
          await Promise.all([
          uiClient.listInterests(),
          uiClient.listSuggestions(),
          uiClient.listLearnedPreferences(),
          uiClient.listSources(),
          ]);
        if (sessionGeneration !== expectedGeneration || session !== "authenticated") return;
        manualInterests = loadedInterests;
        suggestions = loadedSuggestions;
        learnedPreferences = loadedPreferences;
        rssSources = loadedSources;
      }
      if (activeSurface === "settings") {
        const loadedPreferences = await uiClient.getPreferences();
        if (sessionGeneration !== expectedGeneration || session !== "authenticated") return;
        preferences = loadedPreferences;
      }
      if (sessionGeneration !== expectedGeneration || session !== "authenticated") return;
      surfaceLoadState = "ready";
    } catch (error) {
      if (sessionGeneration !== expectedGeneration) return;
      const surfaceName = activeSurface[0].toUpperCase() + activeSurface.slice(1);
      const detail = error instanceof Error ? error.message : "The private API could not be reached.";
      surfaceLoadState = "error";
      surfaceLoadError = `${surfaceName} could not be loaded. ${detail}`;
      statusMessage = surfaceLoadError;
    } finally {
      if (sessionGeneration === expectedGeneration) managementLoading = false;
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

  async function setReaderPosition(nextPosition: number) {
    if (!edition || !client) return;
    const previousPosition = edition.position;
    edition = { ...edition, position: nextPosition };
    try {
      await client.setProgress(edition.edition.id, nextPosition);
      await refreshOfflineQueueStatus();
    } catch (error) {
      edition = { ...edition, position: previousPosition };
      throw error;
    }
  }

  async function completeReaderEdition() {
    if (!edition || !client) return;
    try {
      await client.complete(edition.edition.id);
      atEnd = true;
      edition = { ...edition, completed: true };
      statusMessage = "Edition complete.";
    } catch (error) {
      throw error;
    }
  }

  async function readerFeedback(kind: FeedbackKind, contentId: string, sourceId: string) {
    if (!edition || !client) return;
    const content = edition.content.find((candidate) => candidate.id === contentId);
    const wasKept = keeps.some((keep) => keep.contentId === contentId);
    if (kind === "keep" && content && !wasKept) {
      keeps = [{ ownerId: "", contentId, keptAt: new Date().toISOString() }, ...keeps];
      keptContent = [content, ...keptContent.filter((candidate) => candidate.id !== contentId)];
    }
    try {
      await client.interact({ editionId: edition.edition.id, contentId, sourceId, kind });
      await refreshOfflineQueueStatus();
    } catch (error) {
      if (kind === "keep" && !wasKept) {
        keeps = keeps.filter((keep) => keep.contentId !== contentId);
        keptContent = keptContent.filter((content) => content.id !== contentId);
      }
      throw error;
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

  function askToRemoveSource(source: (typeof rssSources)[number]) {
    sourcePendingRemoval = source;
    sourceRemovalDialog.showModal();
  }

  async function confirmSourceRemoval() {
    if (!sourcePendingRemoval) return;
    const sourceId = sourcePendingRemoval.id;
    sourcePendingRemoval = undefined;
    sourceRemovalDialog.close();
    await removeSource(sourceId);
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
      clearVisibleSession(
        remoteError
        ? "Private offline data was cleared, but server sign-out could not be confirmed. Reconnect and sign out again to end the server session."
          : "",
      );
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

  function createSourceResolver(sources: typeof rssSources) {
    const snapshot = [...sources];
    return (sourceId: string) => sourceDisplayName(sourceId, snapshot);
  }

  function learnedPreferenceDescription(key: string, adjustment: number): string {
    const direction = adjustment > 0 ? "more" : "less";
    const [kind, ...value] = key.split(":");
    const detail = value.join(":");
    if (kind === "source") return `${sourceDisplayName(detail, rssSources)} has been showing up ${direction} often.`;
    if (kind === "tag") return `${detail || "This topic"} has been showing up ${direction} often.`;
    if (kind === "format") return `${detail || "This format"} has been showing up ${direction} often.`;
    return "Your reactions are adjusting what appears in later editions.";
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
              <p>{rssSources.length ? "Set the shape. The edition will stop after twelve items, often sooner." : "Add a source first, then make a finite edition from what you allow."}</p>
              {#if rssSources.length === 0}<a href="/sources/">Choose sources</a>{/if}
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
          <Reader
            view={edition}
            keptIds={keeps.map((keep) => keep.contentId)}
            onPosition={setReaderPosition}
            onComplete={completeReaderEdition}
            onFeedback={readerFeedback}
            onKeep={(contentId) => readerFeedback("keep", contentId, edition?.content.find((content) => content.id === contentId)?.sourceId ?? "")}
            sourceName={readerSourceName}
          />
        {:else}
          <section class="empty-state"><h1>This edition has no eligible items.</h1>
            <p>{rssSources.length ? "Check that your sources have finished syncing, or review your allowances." : "Add your first source and let it sync before making an edition."}</p>
            <a href="/sources/">{rssSources.length ? "Check sources" : "Choose sources"}</a>
            {#if rssSources.length}<a href="/settings/">Review allowances</a>{/if}
            <button class="button quiet" type="button" on:click={() => { edition = undefined; }}>Set another edition</button>
          </section>
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
          {#if rssSources.length}<ul class="source-list">{#each rssSources as source}<li><div><strong>{source.displayName}</strong><small>{source.url ?? "ATProto"}</small><small>{source.lastSyncedAt ? `Last synced ${formatDate(source.lastSyncedAt)}` : "Waiting for first sync"}</small></div><span>{source.status === "error" ? source.lastError : source.status === "queued" ? "Refresh pending" : source.status}</span><button type="button" on:click={() => refreshSource(source.id)}>Refresh</button><button type="button" on:click={() => toggleSourceMute(source.id)}>{preferences.mutedSourceIds.includes(source.id) ? "Unmute" : "Mute"}</button><button type="button" on:click={() => askToRemoveSource(source)}>Remove</button></li>{/each}</ul>{:else if !managementLoading}<p class="empty-note">No sources yet. Add an ATProto home feed, RSS URL, or OPML file.</p>{/if}
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
          <section class="learned" aria-labelledby="learned-title"><p class="section-number">DIRECTIONAL, NOT DEFINING</p><h2 id="learned-title">What your actions are changing</h2>{#if Object.keys(learnedPreferences).length}<ul>{#each Object.entries(learnedPreferences) as [key, adjustment]}<li>{learnedPreferenceDescription(key, adjustment)}</li>{/each}</ul>{:else}<p>Your reactions will shape a later edition after you use its feedback controls.</p>{/if}</section>
          {/if}
        </section>
      {:else}
        <section class="management-surface settings" aria-labelledby="settings-title">
          <header><p class="eyebrow">BOUNDARIES &amp; PORTABILITY</p><h1 id="settings-title">Settings</h1><p>The guardrails stay explicit. Your private data stays portable.</p></header>
          <div class="settings-list">
            <section><div><p class="section-number">ALLOWANCES</p><h2>Content labels</h2><p>Exact source labels are hard gates, never ranking hints.</p></div>{#if surfaceLoadState === "loading"}<p role="status">Loading your allowances…</p>{:else if surfaceLoadState === "error"}<p class="notice" role="alert">{surfaceLoadError}</p>{:else}<div><ul class="tag-list" aria-label="Blocked content labels">{#each preferences.blockedLabels as label}<li><span>{label}</span><button type="button" disabled={preferencesSaving} aria-label={`Allow ${label}`} on:click={() => removeBlockedLabel(label)}>×</button></li>{/each}</ul>{#if preferences.blockedLabels.length === 0}<p>No content labels are blocked.</p>{/if}<form class="inline-field" on:submit={addBlockedLabel}><label class="visually-hidden" for="blocked-label">Label to block</label><input id="blocked-label" maxlength="120" required placeholder="Exact label, e.g. graphic-media" bind:value={blockedLabelDraft} /><button class="button quiet" type="submit" disabled={preferencesSaving}>Block label</button></form></div>{/if}</section>
            <section><div><p class="section-number">OFFLINE</p><h2>Active edition only</h2><p>The shell and current edition can resume offline. OAuth, exports, and source data never enter the cache. The current edition and pending changes remain only until the original sign-in expires, for at most 7 days. Confirmed sign-out or full reset clears them immediately.</p></div><div><p class="connection"><span aria-hidden="true">●</span> {offlineState === "ready" ? "Offline cache active" : offlineState === "checking" ? "Checking offline cache" : "Offline cache unavailable"}</p>{#if offlinePending > 0}<p>{offlinePending} change{offlinePending === 1 ? " is" : "s are"} waiting to sync.</p>{/if}{#if offlineFailed > 0}<p class="notice" role="alert">{offlineFailed} offline change{offlineFailed === 1 ? " needs" : "s need"} attention after the server rejected it.</p><div class="row-actions"><button class="button quiet" type="button" disabled={offlineResolving} on:click={retryFailedOfflineChanges}>Retry failed changes</button><button class="text-button danger" type="button" disabled={offlineResolving} on:click={askToDiscardFailedChanges}>Discard failed changes…</button></div>{/if}</div></section>
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
    <dialog bind:this={sourceRemovalDialog} aria-labelledby="source-removal-title">
      <h2 id="source-removal-title">Remove {sourcePendingRemoval?.displayName ?? "this source"}?</h2>
      <p>Future editions will no longer use this source.</p>
      <div class="row-actions"><button class="button quiet" type="button" on:click={() => sourceRemovalDialog.close()}>Cancel</button><button class="button danger-button" type="button" on:click={confirmSourceRemoval}>Remove source</button></div>
    </dialog>
  </div>
{/if}
