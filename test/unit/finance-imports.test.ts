import { describe, expect, it } from "vitest";

import { computeArtifactSha256 } from "#/lib/finance-imports";
import { financeSourceImportV2Schema } from "#/lib/schemas";

function artifact(artifactSha256 = "") {
	return financeSourceImportV2Schema.parse({
		schemaVersion: "finance-source-import.v2",
		sourceKind: "text",
		sourceFile: {
			absolutePath: "/tmp/source.txt",
			sha256: "source-sha",
			filename: "source.txt",
			importedAt: "2026-01-05T00:00:00.000Z",
		},
		artifactSha256,
		extractor: {
			runner: "test",
			model: "test",
			promptVersion: "test",
			extractedTextHash: null,
		},
		registrySuggestions: {
			identities: [],
			institutions: [],
			financialAccounts: [],
			senderRules: [],
		},
		documents: [],
		transactions: [],
		provenance: {},
	});
}

describe("finance imports", () => {
	it("preserves a non-empty submitted artifact hash", () => {
		expect(computeArtifactSha256(artifact("submitted"))).toBe("submitted");
	});

	it("computes a deterministic hash for missing or empty artifact hashes", () => {
		expect(computeArtifactSha256(artifact())).toBe(
			computeArtifactSha256(artifact()),
		);
		expect(computeArtifactSha256(artifact())).toMatch(/^[a-f0-9]{64}$/);
	});
});
