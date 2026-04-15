import { describe, expect, it, vi } from "vitest";

describe("POST /api/finance/imports", () => {
	it("returns 202 and queues a finance import job", async () => {
		const queueImportFinanceArtifactCommand = vi.fn(async () => "job-import-1");

		vi.doMock("@tanstack/react-router", () => ({
			createFileRoute: () => (config: Record<string, unknown>) => config,
		}));
		vi.doMock("#/app/server/actions.server", () => ({
			queueImportFinanceArtifactCommand,
		}));

		const route = await import("#/app/routes/api.finance.imports");
		const response = await (
			route.Route as unknown as {
				server: {
					handlers: {
						POST: (input: { request: Request }) => Promise<Response>;
					};
				};
			}
		).server.handlers.POST({
			request: new Request("http://localhost/api/finance/imports", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: "finance-source-import.v1",
					sourceKind: "pdf",
					sourceFile: {
						absolutePath: "/tmp/statement.pdf",
						fileSha256: "statement-sha",
						filename: "statement.pdf",
						importedAt: "2026-04-15T00:00:00.000Z",
					},
					artifactSha256: "artifact-sha",
					extractor: {
						runner: "pytest",
						model: "claude-opus",
						promptVersion: "finance-source-import.v1",
						extractedTextHash: "text-sha",
					},
					registrySuggestions: {},
					documents: [],
					transactions: [],
					provenance: {},
				}),
			}),
		});

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			jobId: "job-import-1",
		});
		expect(queueImportFinanceArtifactCommand).toHaveBeenCalledWith({
			artifact: expect.objectContaining({
				schemaVersion: "finance-source-import.v1",
				sourceKind: "pdf",
			}),
		});
	});
});
