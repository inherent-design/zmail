import { z } from "zod";

export const zmailInvalidationKeySchema = z.union([
	z.literal("zmail:home"),
	z.literal("zmail:accounts"),
	z.templateLiteral(["zmail:account:", z.string().min(1)]),
	z.literal("zmail:messages"),
	z.templateLiteral(["zmail:message:", z.string().min(1)]),
	z.literal("zmail:review"),
	z.literal("zmail:finance"),
	z.literal("zmail:runs"),
	z.templateLiteral(["zmail:profile:", z.string().min(1)]),
]);

export const clientMutationToastSchema = z
	.object({
		tone: z.enum(["success", "warning", "error"]),
		text: z.string().min(1),
	})
	.strict();

export const clientMutationJobSchema = z
	.object({
		jobId: z.string().min(1),
		kind: z.string().min(1),
		scopeId: z.string().min(1),
	})
	.strict();

export const clientMutationEventSchema = z
	.object({
		topic: z.string().min(1),
		eventType: z.string().min(1),
		entityId: z.string().min(1),
	})
	.strict();

export const clientMutationEnvelopeSchema = z
	.object({
		ok: z.literal(true),
		status: z.string().min(1),
		message: z.string().min(1).optional(),
		toast: clientMutationToastSchema.optional(),
		redirectTo: z.string().min(1).optional(),
		invalidate: z.array(zmailInvalidationKeySchema).optional(),
		jobs: z.array(clientMutationJobSchema).optional(),
		events: z.array(clientMutationEventSchema).optional(),
	})
	.strict();

export type ZmailInvalidationKey = z.infer<typeof zmailInvalidationKeySchema>;
export type ClientMutationEnvelope = z.infer<
	typeof clientMutationEnvelopeSchema
>;

export function parseClientMutationEnvelope(input: unknown) {
	return clientMutationEnvelopeSchema.parse(input);
}

export function normalizeInvalidationKeys(input: unknown) {
	return [...new Set(z.array(zmailInvalidationKeySchema).parse(input ?? []))];
}
