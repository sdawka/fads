import type { Evidence } from "../../contracts";
import type { BootstrapSuggestion } from "./types";

/** Turns source evidence into owner-reviewable proposals, never active interests. */
export function deriveBootstrapSuggestions(evidence: readonly Evidence[]): BootstrapSuggestion[] {
  const grouped = new Map<
    string,
    { value: string; count: number; provenance: Evidence["tags"][number]["provenance"] }
  >();
  for (const item of evidence) {
    for (const tag of item.tags) {
      const value = tag.value.trim();
      if (!value) continue;
      const key = value.toLowerCase();
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.set(key, { value, count: 1, provenance: tag.provenance });
      }
    }
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => ({
      value: group.value,
      confirmed: false,
      evidenceCount: group.count,
      provenance: group.provenance,
    }));
}

export function confirmBootstrapSuggestion(suggestion: BootstrapSuggestion): BootstrapSuggestion {
  return { ...suggestion, confirmed: true };
}

export function confirmedBootstrapInterests(suggestions: readonly BootstrapSuggestion[]): string[] {
  return suggestions
    .filter((suggestion) => suggestion.confirmed)
    .map((suggestion) => suggestion.value);
}
