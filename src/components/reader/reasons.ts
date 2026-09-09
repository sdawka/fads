import type { DecisionTrace } from "../../contracts";

export function describeReasons(trace: DecisionTrace): string[] {
  const reasons: string[] = [];
  for (const { factor, weight } of trace.factors) {
    if (weight <= 0) continue;
    if (factor.startsWith("interest:"))
      reasons.push(`Matches your interest in ${factor.slice(9)}.`);
    else if (factor === "exploration")
      reasons.push("A deliberate detour within your allowed sources and content.");
    else if (factor === "energy-fit") reasons.push("Fits the reading energy you chose.");
    else if (factor === "freshness") reasons.push("Recent enough to be useful in this edition.");
    else if (factor.startsWith("learned:"))
      reasons.push("Your earlier feedback helped bring this into the edition.");
  }
  return [...new Set(reasons)].slice(0, 4);
}
