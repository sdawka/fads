import type { ContentEnvelope, ContentEnricher, ProvenancedTag } from "../../contracts";

export interface ManualTagSeed {
  contentId: string;
  value: string;
  provenance?: ProvenancedTag["provenance"];
}

function seedEntries(
  seeds: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>,
): ManualTagSeed[] {
  if (!seeds) return [];
  if (seeds instanceof Map) {
    const entries = [...(seeds as ReadonlyMap<string, readonly string[]>).entries()];
    return entries.flatMap(([contentId, values]) =>
      values.map((value: string) => ({ contentId, value })),
    );
  }
  const entries = Object.entries(seeds) as Array<[string, readonly string[]]>;
  return entries.flatMap(([contentId, values]) =>
    values.map((value: string) => ({ contentId, value })),
  );
}

function isManualTagSeedList(value: unknown): value is readonly ManualTagSeed[] {
  return Array.isArray(value);
}

/** A safe default for callers that do not have enrichment configured. */
export class NoopContentEnricher implements ContentEnricher {
  enrich(): Promise<[]> {
    return Promise.resolve([]);
  }
}

/**
 * Applies only tags explicitly supplied by the owner. It never derives tags
 * from body text, calls a model, or treats bootstrap evidence as consent.
 */
export class ManualContentEnricher implements ContentEnricher {
  private readonly seeds: ManualTagSeed[];

  constructor(
    confirmedTags?:
      | ReadonlyMap<string, readonly string[]>
      | Readonly<Record<string, readonly string[]>>
      | readonly ManualTagSeed[],
  ) {
    this.seeds = !confirmedTags
      ? []
      : isManualTagSeedList(confirmedTags)
        ? [...confirmedTags]
        : seedEntries(confirmedTags);
  }

  enrich(
    items: ContentEnvelope[],
    context: { ownerId: string; requestedAt: string },
  ): Promise<Array<{ contentId: string; tags?: ProvenancedTag[] }>> {
    const byContent = new Map<string, ManualTagSeed[]>();
    for (const seed of this.seeds) {
      const values = byContent.get(seed.contentId) ?? [];
      values.push(seed);
      byContent.set(seed.contentId, values);
    }

    const patches = items.flatMap((item) => {
      const values = byContent.get(item.id) ?? [];
      const tags = values
        .map((seed) => ({ ...seed, value: seed.value.trim() }))
        .filter((seed) => seed.value.length > 0)
        .map((seed) => ({
          value: seed.value,
          provenance: seed.provenance ?? {
            source: "owner",
            observedAt: context.requestedAt,
            reference:
              item.canonicalUri.match(/^https?:\/\//) || item.canonicalUri.startsWith("at://")
                ? item.canonicalUri
                : undefined,
          },
        }));
      return tags.length ? [{ contentId: item.id, tags }] : [];
    });

    return Promise.resolve(patches);
  }
}

export function createNoopContentEnricher(): ContentEnricher {
  return new NoopContentEnricher();
}

export function createManualContentEnricher(
  confirmedTags:
    | ReadonlyMap<string, readonly string[]>
    | Readonly<Record<string, readonly string[]>>
    | readonly ManualTagSeed[] = [],
): ContentEnricher {
  return new ManualContentEnricher(confirmedTags);
}

/** Merge a manual enricher's patches without replacing source-provided tags. */
export async function applyContentEnrichment(
  items: readonly ContentEnvelope[],
  enricher: ContentEnricher,
  context: { ownerId: string; requestedAt: string },
): Promise<ContentEnvelope[]> {
  const patches = await enricher.enrich([...items], context);
  const byContent = new Map(patches.map((patch) => [patch.contentId, patch]));
  return items.map((item) => {
    const patch = byContent.get(item.id);
    if (!patch) return item;
    const existing = new Set(item.tags.map((tag) => tag.value.toLowerCase()));
    const additions = (patch.tags ?? []).filter((tag) => !existing.has(tag.value.toLowerCase()));
    return additions.length ? { ...item, tags: [...item.tags, ...additions] } : item;
  });
}
