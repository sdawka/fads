import { z } from "zod";
import { DecisionTraceSchema, MediaAttachmentSchema, SafeBlockSchema } from "../contracts";

export function serializeBlocks(value: unknown): string {
  return JSON.stringify(z.array(SafeBlockSchema).parse(value));
}

export function serializeMedia(value: unknown): string {
  return JSON.stringify(z.array(MediaAttachmentSchema).parse(value));
}

export function serializeDecisionTrace(value: unknown): string {
  return JSON.stringify(DecisionTraceSchema.parse(value));
}
