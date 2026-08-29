import { z } from "zod";

const NonEmptyIdSchema = z.string().trim().min(1);
const TimestampSchema = z.iso.datetime({ offset: true });
const PercentSchema = z.int().min(0).max(100);
const HttpUrlSchema = z.url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Expected an HTTP(S) URL");
const AtUriSchema = z
  .string()
  .regex(
    /^at:\/\/did:[a-z0-9]+:[a-zA-Z0-9._:%-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._~-]+$/,
    "Expected a canonical AT URI",
  );
const ProvenanceReferenceSchema = z.union([HttpUrlSchema, AtUriSchema]);

export const ProvenanceSchema = z.object({
  source: NonEmptyIdSchema,
  observedAt: TimestampSchema,
  reference: ProvenanceReferenceSchema.optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ProvenancedTagSchema = z.object({
  value: NonEmptyIdSchema,
  provenance: ProvenanceSchema,
});
export type ProvenancedTag = z.infer<typeof ProvenancedTagSchema>;

export const SafetyLabelSchema = z.object({
  value: NonEmptyIdSchema,
  provenance: ProvenanceSchema,
});
export type SafetyLabel = z.infer<typeof SafetyLabelSchema>;

export const SafeBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("heading"),
      text: NonEmptyIdSchema,
      level: z.int().min(1).max(6).default(2),
    })
    .strict(),
  z.object({ kind: z.literal("paragraph"), text: NonEmptyIdSchema }).strict(),
  z
    .object({
      kind: z.literal("quote"),
      text: NonEmptyIdSchema,
      attribution: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("code"),
      code: z.string(),
      language: z.string().trim().min(1).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("image"), src: HttpUrlSchema, alt: z.string() }).strict(),
  z
    .object({ kind: z.literal("audio"), src: HttpUrlSchema, transcript: z.string().optional() })
    .strict(),
  z
    .object({ kind: z.literal("video"), src: HttpUrlSchema, transcript: z.string().optional() })
    .strict(),
  z.object({ kind: z.literal("link"), href: HttpUrlSchema, text: NonEmptyIdSchema }).strict(),
]);
export type SafeBlock = z.infer<typeof SafeBlockSchema>;

export const MediaAttachmentSchema = z
  .object({
    id: NonEmptyIdSchema,
    kind: z.enum(["image", "audio", "video"]),
    url: HttpUrlSchema,
    alt: z.string().optional(),
    provenance: ProvenanceSchema,
  })
  .strict();
export type MediaAttachment = z.infer<typeof MediaAttachmentSchema>;

export const ContentEnvelopeSchema = z.object({
  id: NonEmptyIdSchema,
  canonicalUri: NonEmptyIdSchema,
  sourceId: NonEmptyIdSchema,
  publishedAt: TimestampSchema,
  capturedAt: TimestampSchema,
  blocks: z.array(SafeBlockSchema),
  media: z.array(MediaAttachmentSchema).default([]),
  tags: z.array(ProvenancedTagSchema),
  labels: z.array(SafetyLabelSchema),
});
export type ContentEnvelope = z.infer<typeof ContentEnvelopeSchema>;

export const DecisionFactorSchema = z.object({
  factor: NonEmptyIdSchema,
  weight: z.number().finite(),
  provenance: ProvenanceSchema,
});

export const DecisionTraceSchema = z.object({
  factors: z.array(DecisionFactorSchema),
  generatedAt: TimestampSchema.optional(),
});
export type DecisionTrace = z.infer<typeof DecisionTraceSchema>;

export const FramedRecommendationSchema = z.object({
  id: NonEmptyIdSchema,
  contentId: NonEmptyIdSchema,
  frame: NonEmptyIdSchema,
  position: z.int().min(0),
  decisionTrace: DecisionTraceSchema,
});
export type FramedRecommendation = z.infer<typeof FramedRecommendationSchema>;

export const RecommendationSlateSchema = z.object({
  id: NonEmptyIdSchema,
  ownerId: NonEmptyIdSchema,
  createdAt: TimestampSchema,
  curiosity: PercentSchema,
  energy: PercentSchema,
  items: z.array(FramedRecommendationSchema).max(12),
  decisionTrace: DecisionTraceSchema,
});
export type RecommendationSlate = z.infer<typeof RecommendationSlateSchema>;

export const EditionRequestSchema = z.object({
  ownerId: NonEmptyIdSchema,
  requestedAt: TimestampSchema,
  curiosity: PercentSchema,
  energy: PercentSchema,
  limit: z.int().min(0).max(12).default(12),
});
export type EditionRequest = z.infer<typeof EditionRequestSchema>;

export const InteractionKindSchema = z.enum([
  "more_like_this",
  "less_like_this",
  "good_surprise",
  "not_now",
  "mute_source",
  "keep",
]);

export const InteractionEventSchema = z.object({
  id: NonEmptyIdSchema,
  ownerId: NonEmptyIdSchema,
  contentId: NonEmptyIdSchema.optional(),
  sourceId: NonEmptyIdSchema.optional(),
  kind: InteractionKindSchema,
  occurredAt: TimestampSchema,
  provenance: ProvenanceSchema,
});
export type InteractionEvent = z.infer<typeof InteractionEventSchema>;

export const QueueMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("sync_source"),
    sourceId: NonEmptyIdSchema,
    cursor: z.string().optional(),
  }),
  z.object({ version: z.literal(1), kind: z.literal("sync_all") }),
]);
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

export const EvidenceSchema = z.object({
  sourceId: NonEmptyIdSchema,
  subjectUri: NonEmptyIdSchema,
  observedAt: TimestampSchema,
  tags: z.array(ProvenancedTagSchema),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export interface SourceAdapter {
  sync(cursor?: string): Promise<{ items: ContentEnvelope[]; nextCursor?: string }>;
  hydrate(ref: string): Promise<ContentEnvelope>;
}

export interface ContentEnricher {
  enrich(
    items: ContentEnvelope[],
    context: { ownerId: string; requestedAt: string },
  ): Promise<Array<{ contentId: string; tags?: ProvenancedTag[]; labels?: SafetyLabel[] }>>;
}

export interface BootstrapEvidenceProvider {
  evidenceFor(ownerId: string): Promise<Evidence[]>;
}
