import { z } from "zod";

import { ContentEnvelopeSchema, InteractionEventSchema, RecommendationSlateSchema } from "./base";

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

export const SuggestionDecisionSchema = z
  .object({ decision: z.enum(["confirm", "reject"]) })
  .strict();

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

const ContentInteractionCreateSchema = z
  .object({
    editionId: IdSchema,
    contentId: IdSchema,
    sourceId: IdSchema.optional(),
    kind: z.enum(["more_like_this", "less_like_this", "good_surprise", "not_now", "keep"]),
  })
  .strict();
const MuteSourceInteractionCreateSchema = z
  .object({
    editionId: IdSchema.optional(),
    contentId: IdSchema.optional(),
    sourceId: IdSchema,
    kind: z.literal("mute_source"),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.editionId) !== Boolean(value.contentId)) {
      context.addIssue({
        code: "custom",
        path: [value.editionId ? "contentId" : "editionId"],
        message: "Edition and content identifiers must be supplied together",
      });
    }
  });
export const InteractionCreateSchema = z.union([
  ContentInteractionCreateSchema,
  MuteSourceInteractionCreateSchema,
]);
export const KeepCreateSchema = z.object({ contentId: IdSchema }).strict();
export const ResetRequestSchema = z
  .object({
    full: z.boolean().default(false),
    confirmation: z.literal("DELETE ALL PRIVATE DATA").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.full && value.confirmation !== "DELETE ALL PRIVATE DATA") {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Full reset confirmation is required",
      });
    }
  });

export const SyncSourceMessageSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("sync_source"),
    ownerId: IdSchema,
    sourceId: IdSchema,
    workId: IdSchema,
  })
  .strict();

export const SessionResponseSchema = z.union([
  z.object({ authenticated: z.literal(false) }).strict(),
  z.object({ authenticated: z.literal(true), did: IdSchema }).strict(),
]);
export const SourcesResponseSchema = z.object({ sources: z.array(SourceSchema) }).strict();
export const SourceResponseSchema = z.object({ source: SourceSchema }).strict();
export const InterestsResponseSchema = z
  .object({ interests: z.array(ManualInterestSchema) })
  .strict();
export const InterestResponseSchema = z.object({ interest: ManualInterestSchema }).strict();
export const SuggestionsResponseSchema = z
  .object({ suggestions: z.array(InterestSuggestionSchema) })
  .strict();
export const SuggestionResponseSchema = z.object({ suggestion: InterestSuggestionSchema }).strict();
export const PreferencesResponseSchema = z.object({ preferences: OwnerPreferencesSchema }).strict();

export const EditionProgressSchema = z
  .object({
    editionId: IdSchema,
    ownerId: IdSchema,
    position: z.int().min(0).max(12),
    completed: z.boolean(),
  })
  .strict();
export const EditionProgressResponseSchema = z.object({ progress: EditionProgressSchema }).strict();
export const InteractionResponseSchema = z.object({ interaction: InteractionEventSchema }).strict();

export const KeepRecordSchema = z
  .object({ ownerId: IdSchema, contentId: IdSchema, keptAt: TimestampSchema })
  .strict();
export type KeepRecord = z.infer<typeof KeepRecordSchema>;
export const KeepsResponseSchema = z
  .object({ keeps: z.array(KeepRecordSchema), content: z.array(ContentEnvelopeSchema) })
  .strict();
export const KeepResponseSchema = z.object({ keep: KeepRecordSchema }).strict();

export const OpmlImportResponseSchema = z
  .object({
    sources: z.array(SourceSchema),
    rejected: z.array(
      z.object({ url: z.string().trim().max(2048), reason: z.string().trim().min(1) }).strict(),
    ),
  })
  .strict();

const SyncCursorExportSchema = z
  .object({ sourceId: IdSchema, cursor: z.string().nullable(), syncedAt: TimestampSchema })
  .strict();
const LearnedAdjustmentExportSchema = z
  .object({
    factor: IdSchema,
    adjustment: z.number().finite(),
    provenance: z.json(),
    updatedAt: TimestampSchema,
  })
  .strict();
const SuppressionExportSchema = z
  .object({
    contentId: IdSchema.nullable(),
    canonicalUri: z.string().trim().min(1).nullable(),
    until: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .strict();
const EditionExportSchema = z
  .object({
    id: IdSchema,
    requestedAt: TimestampSchema,
    curiosity: z.int(),
    energy: z.int(),
    trace: z.json(),
    position: z.int(),
    completed: z.boolean(),
    createdAt: TimestampSchema,
  })
  .strict();
const EditionItemExportSchema = z
  .object({
    editionId: IdSchema,
    contentId: IdSchema,
    position: z.int(),
    recommendation: z.json(),
  })
  .strict();
const EditionDecisionExportSchema = z
  .object({
    editionId: IdSchema,
    decisionKey: IdSchema,
    contentId: IdSchema,
    canonicalUri: z.string().nullable(),
    selected: z.boolean(),
    reason: z.string().nullable(),
    trace: z.json(),
  })
  .strict();

export const OwnerExportSchema = z
  .object({
    ownerId: IdSchema,
    exportedAt: TimestampSchema,
    data: z
      .object({
        sources: z.array(SourceSchema),
        syncCursors: z.array(SyncCursorExportSchema),
        content: z.array(ContentEnvelopeSchema),
        interests: z.array(ManualInterestSchema),
        suggestions: z.array(InterestSuggestionSchema),
        preferences: OwnerPreferencesSchema,
        learnedAdjustments: z.array(LearnedAdjustmentExportSchema),
        suppressions: z.array(SuppressionExportSchema),
        interactions: z.array(InteractionEventSchema),
        keeps: z.array(KeepRecordSchema),
        editions: z.array(EditionExportSchema),
        editionItems: z.array(EditionItemExportSchema),
        editionDecisions: z.array(EditionDecisionExportSchema),
        progress: z.array(EditionProgressSchema.omit({ ownerId: true })),
      })
      .strict(),
  })
  .strict();
export type OwnerExport = z.infer<typeof OwnerExportSchema>;
