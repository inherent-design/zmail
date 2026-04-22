import { z } from "zod";

export const uiIslandTargetSchema = z
	.object({
		type: z.literal("island"),
		id: z.string().min(1),
	})
	.strict();

export const uiNodeTargetSchema = z
	.object({
		type: z.literal("node"),
		islandId: z.string().min(1),
		nodeId: z.string().min(1),
		key: z.string().min(1),
	})
	.strict();

export const uiMainTargetSchema = z
	.object({
		type: z.literal("main"),
	})
	.strict();

export const uiRedirectTargetSchema = z
	.object({
		type: z.literal("redirect"),
		url: z.string().min(1),
		replace: z.boolean().optional(),
	})
	.strict();

export const uiTargetSchema = z.discriminatedUnion("type", [
	uiIslandTargetSchema,
	uiNodeTargetSchema,
	uiMainTargetSchema,
	uiRedirectTargetSchema,
]);

export const uiMutationToastSchema = z
	.object({
		tone: z.enum(["success", "warning", "error"]),
		text: z.string().min(1),
	})
	.strict();

export const uiMutationEnvelopeSchema = z
	.object({
		ok: z.literal(true),
		status: z.string().min(1),
		message: z.string().min(1).optional(),
		ui: z
			.object({
				targets: z.array(uiTargetSchema).optional(),
				toast: uiMutationToastSchema.optional(),
				jobs: z
					.array(
						z
							.object({
								jobId: z.string().min(1),
								kind: z.string().min(1),
								scopeId: z.string().min(1),
							})
							.strict(),
					)
					.optional(),
				events: z
					.array(
						z
							.object({
								topic: z.string().min(1),
								eventType: z.string().min(1),
								entityId: z.string().min(1),
							})
							.strict(),
					)
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type UiIslandTarget = z.infer<typeof uiIslandTargetSchema>;
export type UiNodeTarget = z.infer<typeof uiNodeTargetSchema>;
export type UiMainTarget = z.infer<typeof uiMainTargetSchema>;
export type UiRedirectTarget = z.infer<typeof uiRedirectTargetSchema>;
export type UiTarget = z.infer<typeof uiTargetSchema>;
export type UiMutationToast = z.infer<typeof uiMutationToastSchema>;
export type UiMutationEnvelope = z.infer<typeof uiMutationEnvelopeSchema>;

function targetDedupeKey(target: UiTarget) {
	switch (target.type) {
		case "redirect":
			return `redirect:${target.url}:${target.replace ? "1" : "0"}`;
		case "main":
			return "main";
		case "island":
			return `island:${target.id}`;
		case "node":
			return `node:${target.islandId}:${target.nodeId}:${target.key}`;
	}
}

function targetOrder(target: UiTarget) {
	switch (target.type) {
		case "redirect":
			return 0;
		case "main":
			return 1;
		case "island":
			return 2;
		case "node":
			return 3;
	}
}

export function normalizeUiTargets(targets: unknown): UiTarget[] {
	const parsed = z.array(uiTargetSchema).parse(targets ?? []);
	const seen = new Set<string>();
	const deduped: UiTarget[] = [];
	for (const target of parsed) {
		const key = targetDedupeKey(target);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(target);
	}
	return deduped.sort((left, right) => targetOrder(left) - targetOrder(right));
}

export function partitionUiTargets(targets: unknown) {
	const normalized = normalizeUiTargets(targets);
	return {
		redirects: normalized.filter(
			(target): target is UiRedirectTarget => target.type === "redirect",
		),
		main: normalized.filter(
			(target): target is UiMainTarget => target.type === "main",
		),
		islands: normalized.filter(
			(target): target is UiIslandTarget => target.type === "island",
		),
		nodes: normalized.filter(
			(target): target is UiNodeTarget => target.type === "node",
		),
	};
}

export function dropNodesCoveredByIslands(targets: unknown): UiTarget[] {
	const normalized = normalizeUiTargets(targets);
	const islandIds = new Set(
		normalized
			.filter((target): target is UiIslandTarget => target.type === "island")
			.map((target) => target.id),
	);
	return normalized.filter(
		(target) => target.type !== "node" || !islandIds.has(target.islandId),
	);
}

export function encodeUiNodeToken(input: { nodeId: string; key: string }) {
	return `${encodeURIComponent(input.nodeId)}:${encodeURIComponent(input.key)}`;
}

export function decodeUiNodeToken(token: string) {
	const separator = token.indexOf(":");
	if (separator < 1) {
		throw new Error("Invalid UI node token.");
	}
	const nodeId = decodeURIComponent(token.slice(0, separator));
	const key = decodeURIComponent(token.slice(separator + 1));
	if (!nodeId || !key) {
		throw new Error("Invalid UI node token.");
	}
	return { nodeId, key };
}
