import type { DecisionTrace } from "../contracts";

export type ReaderDirection = "previous" | "next";

export interface ReaderPosition {
  position: number;
  total: number;
}

const descriptions = {
  curiosity: ["familiar ground", "a little adjacent", "open to detours", "surprise me"],
  energy: ["easy company", "room to think", "up for some depth", "ready to concentrate"],
} as const;

export function describeControlValue(control: keyof typeof descriptions, value: number): string {
  const index = value <= 24 ? 0 : value <= 49 ? 1 : value <= 74 ? 2 : 3;
  return descriptions[control][index];
}

export function describeDecisionFactor(factor: DecisionTrace["factors"][number]): string {
  const sign = factor.weight < 0 ? "−" : "+";
  return `${sign}${Math.abs(factor.weight).toFixed(2)} score · ${factor.provenance.source}`;
}

export function moveReader(
  current: ReaderPosition,
  direction: ReaderDirection,
): { position: number; atEnd: boolean } {
  const finalPosition = Math.max(0, current.total - 1);
  if (direction === "previous") {
    return { position: Math.max(0, current.position - 1), atEnd: false };
  }
  if (current.position >= finalPosition) return { position: finalPosition, atEnd: true };
  return { position: current.position + 1, atEnd: false };
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export function safeExternalLinkAttributes(value: string):
  | {
      href: string;
      target: "_blank";
      rel: "noopener noreferrer";
    }
  | undefined {
  if (!isSafeExternalUrl(value)) return undefined;
  return { href: value, target: "_blank", rel: "noopener noreferrer" };
}
