import { z } from "zod";

import {
  ContentEnvelopeSchema,
  InteractionEventSchema,
  RecommendationSlateSchema,
} from "./base";

const IdSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.iso.datetime({ offset: true });
const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Expected an HTTP(S) URL");

export const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, "Use visible ASCII characters");

export const ProblemSchema = z
  .object({
    type: z.url(),
    title: z.string().trim().min(1).max(120),
    status: z.int().min(400).max(599),
    detail: z.string().trim().min(1).max(500).optional(),
    instance: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type Problem = z.infer<typeof ProblemSchema>;

export const SourceAdapterNameSchema = z.enum(["rss", "atproto"]);
export const SourceStatusSchema = z.enum(["idle", "queued", "syncing", "ready", "error"]);

export const SourceSchema = z
  .object({
    id: IdSchema,
    ownerId: IdSchema,
    adapter: SourceAdapterNameSchema,
    displayName: z.string().trim().min(1).max(160),
    url: HttpUrlSchema.optional(),
    config: z.record(z.string(), z.json()),
    status: SourceStatusSchema,
    lastError: z.string().trim().min(1).max(500).optional(),
    lastSyncedAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ApiSource = z.infer<typeof SourceSchema>;

export const SourceCreateSchema = z
  .object({
    adapter: SourceAdapterNameSchema,
    displayName: z.string().trim().min(1).max(160),
    url: HttpUrlSchema.optional(),
    config: z.record(z.string(), z.json()).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.adapter === "rss" && !value.url) {
      context.addIssue({ code: "custom", path: ["url"], message: "RSS sources require a URL" });
    }
  });

export const SourceStatusUpdateSchema = z
  .object({
    status: SourceStatusSchema,
    lastError: z.string().trim().min(1).max(500).nullable().optional(),
    lastSyncedAt: TimestampSchema.optional(),
  })
  .strict();

export const ManualInterestSchema = z
  .object({
    id: IdSchema,
    ownerId: IdSchema,
    value: z.string().trim().min(1).max(120),
    createdAt: TimestampSchema,
  })
  .strict();
export type ManualInterest = z.infer<typeof ManualInterestSchema>;

export const InterestCreateSchema = z.object({ value: z.string().trim().min(1).max(120) }).strict();

export const InterestSuggestionSchema = z
  .object({
    id: IdSchema,
    ownerId: IdSchema,
    value: z.string().trim().min(1).max(120),
    evidenceCount: z.int().min(1),
    provenance: z.json(),
    status: z.enum(["pending", "confirmed", "rejected"]),
    createdAt: TimestampSchema,
    decidedAt: TimestampSchema.optional(),
  })
  .strict();
export type InterestSuggestion = z.infer<typeof InterestSuggestionSchema>;

export const SuggestionDecisionSchema = z.object({ decision: z.enum(["confirm", "reject"]) }).strict();

export const OwnerPreferencesSchema = z
  .object({
    blockedLabels: z.array(z.string().trim().min(1).max(120)).max(100),
    mutedSourceIds: z.array(IdSchema).max(500),
  })
  .strict();
export type OwnerPreferences = z.infer<typeof OwnerPreferencesSchema>;

export const EditionCreateSchema = z
  .object({
    curiosity: z.int().min(0).max(100),
    energy: z.int().min(0).max(100),
    limit: z.int().min(1).max(12).default(12),
  })
  .strict();

export const EditionProgressUpdateSchema = z.object({ position: z.int().min(0).max(12) }).strict();
export const EditionResponseSchema = z
  .object({
    edition: RecommendationSlateSchema,
    content: z.array(ContentEnvelopeSchema).max(12),
    position: z.int().min(0).max(12),
    completed: z.boolean(),
  })
  .strict();

export const InteractionCreateSchema = z
  .object({
    editionId: IdSchema.optional(),
    contentId: IdSchema.optional(),
    sourceId: IdSchema.optional(),
    kind: InteractionEventSchema.shape.kind,
  })
  .strict();
export const KeepCreateSchema = z.object({ contentId: IdSchema }).strict();
export const ResetRequestSchema = z
  .object({ full: z.boolean().default(false), confirmation: z.literal("DELETE ALL PRIVATE DATA").optional() })
  .strict()
  .superRefine((value, context) => {
    if (value.full && value.confirmation !== "DELETE ALL PRIVATE DATA") {
      context.addIssue({ code: "custom", path: ["confirmation"], message: "Full reset confirmation is required" });
    }
  });

export const SyncSourceMessageSchema = z
  .object({ version: z.literal(1), kind: z.literal("sync_source"), ownerId: IdSchema, sourceId: IdSchema })
  .strict();
