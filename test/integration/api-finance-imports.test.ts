import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#/test/helpers/runtime";

function buildActionsServerMock(
	queueImportFinanceArtifactCommand: ReturnType<typeof vi.fn>,
) {
	const unused = vi.fn(async () => {
		throw new Error("not used in this test");
	});
	return {
		beginGoogleConnectCommand: unused,
		beginGoogleReconnectCommand: unused,
		classifyOneNowCommand: unused,
		completeGoogleConnectCommand: unused,
		disconnectAccountCommand: unused,
		loadAccountDeleteData: unused,
		loadAccountDetailData: unused,
		loadAccountNewData: unused,
		loadAccountReconnectData: unused,
		loadAccountsData: unused,
		loadFinanceData: unused,
		loadHomeData: unused,
		loadMessageDetailData: unused,
		loadMessagesData: unused,
		loadProfileData: unused,
		loadReviewData: unused,
		loadRunsData: unused,
		pauseAccountSyncCommand: unused,
		purgeAccountCommand: unused,
		queueAccountClassifyBacklogCommand: unused,
		queueAccountDeltaSyncCommand: unused,
		queueAccountFinanceBacklogCommand: unused,
		queueAccountFullSyncCommand: unused,
		queueAccountReconcileCommand: unused,
		queueImportFinanceArtifactCommand,
		queueImportOperatorRegistryCommand: unused,
		queueRebuildFinanceKnowledgeCommand: unused,
		queueRebuildFinanceRollupsCommand: unused,
		queueReconcileRegistrySuggestionsCommand: unused,
		resolveReviewCommand: unused,
		resumeAccountSyncCommand: unused,
	};
}

function buildArtifact(artifactSha256: string) {
	return {
		schemaVersion: "finance-source-import.v1",
		sourceKind: "pdf",
		sourceFile: {
			absolutePath: "/tmp/statement.pdf",
			sha256: "statement-sha",
			filename: "statement.pdf",
			importedAt: "2026-04-15T00:00:00.000Z",
		},
		artifactSha256,
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
	};
}

describe("POST /api/finance/imports", () => {
	beforeEach(async () => {
		await createTestRuntime();
		process.env.NODE_ENV = "test";
		process.env.ZMAIL_TEST_AUTH_BYPASS = "true";
		process.env.ZMAIL_TEST_AUTH_ORG_ID = "org-test";
		process.env.ZMAIL_TEST_AUTH_ROLE = "org_admin";
		delete process.env.ZMAIL_BASE_PATH;
		vi.resetModules();
	});

	for (const role of ["org_admin", "org_operator"] as const) {
		it(`returns 202 and queues a finance import job for ${role} browser sessions`, async () => {
			process.env.ZMAIL_TEST_AUTH_ROLE = role;
			const queueImportFinanceArtifactCommand = vi.fn(
				async () => `job-import-${role}`,
			);

			vi.doMock("#/server/actions", () =>
				buildActionsServerMock(queueImportFinanceArtifactCommand),
			);

			const { app } = await import("#/server/index");
			const artifactSha256 = `artifact-sha-${role}`;
			const response = await app.fetch(
				new Request("http://localhost/api/finance/imports", {
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify(buildArtifact(artifactSha256)),
				}),
			);

			expect(response.status).toBe(202);
			await expect(response.json()).resolves.toEqual({
				ok: true,
				status: "queued",
				jobId: `job-import-${role}`,
				artifactSha256,
			});
			expect(queueImportFinanceArtifactCommand).toHaveBeenCalledWith({
				artifact: expect.objectContaining({
					schemaVersion: "finance-source-import.v1",
					sourceKind: "pdf",
				}),
			});
		});
	}

	it("returns 403 for org_viewer browser sessions", async () => {
		process.env.ZMAIL_TEST_AUTH_ROLE = "org_viewer";
		const queueImportFinanceArtifactCommand = vi.fn(async () => "job-import-1");

		vi.doMock("#/server/actions", () =>
			buildActionsServerMock(queueImportFinanceArtifactCommand),
		);

		const { app } = await import("#/server/index");
		const response = await app.fetch(
			new Request("http://localhost/api/finance/imports", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(buildArtifact("artifact-sha-viewer")),
			}),
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "forbidden",
		});
		expect(queueImportFinanceArtifactCommand).not.toHaveBeenCalled();
	});

	it("returns 400 for invalid JSON", async () => {
		const queueImportFinanceArtifactCommand = vi.fn(async () => "job-import-1");
		vi.doMock("#/server/actions", () =>
			buildActionsServerMock(queueImportFinanceArtifactCommand),
		);

		const { app } = await import("#/server/index");
		const response = await app.fetch(
			new Request("http://localhost/api/finance/imports", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: "{",
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "invalid_json",
		});
		expect(queueImportFinanceArtifactCommand).not.toHaveBeenCalled();
	});

	it("runs finance API migrations once per module", async () => {
		process.env.ZMAIL_TEST_AUTH_ROLE = "org_operator";
		const queueImportFinanceArtifactCommand = vi.fn(async () => "job-import-1");
		vi.doMock("#/server/actions", () =>
			buildActionsServerMock(queueImportFinanceArtifactCommand),
		);
		const dbModule = await import("#/lib/db");
		const runMigrations = vi.spyOn(dbModule, "runMigrations");

		const { app } = await import("#/server/index");
		const importResponse = await app.fetch(
			new Request("http://localhost/api/finance/imports", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: "{",
			}),
		);
		const uploadForm = new FormData();
		const uploadResponse = await app.fetch(
			new Request("http://localhost/api/finance/uploads", {
				method: "POST",
				body: uploadForm,
			}),
		);

		expect(importResponse.status).toBe(400);
		expect(uploadResponse.status).toBe(422);
		expect(runMigrations).toHaveBeenCalledTimes(1);
	});

	it("accepts a validated machine principal on the finance import route", async () => {
		const queueImportFinanceArtifactCommand = vi.fn(
			async () => "job-import-m2m",
		);

		vi.doMock("#/server/actions", () =>
			buildActionsServerMock(queueImportFinanceArtifactCommand),
		);
		vi.doMock("#/server/machine-auth", () => ({
			bearerTokenFromRequest: vi.fn(() => "machine-token"),
			authenticateMachineToken: vi.fn(async () => ({
				kind: "machine" as const,
				sub: "machine-user",
				orgId: "org-machine",
				authMode: "workos_m2m" as const,
			})),
		}));

		const { app } = await import("#/server/index");
		const response = await app.fetch(
			new Request("http://localhost/api/finance/imports", {
				method: "POST",
				headers: {
					authorization: "Bearer machine-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(buildArtifact("artifact-sha-machine")),
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			status: "queued",
			jobId: "job-import-m2m",
			artifactSha256: "artifact-sha-machine",
		});
	});

	it("rejects bearer tokens on browser-only rpc routes", async () => {
		const queueImportFinanceArtifactCommand = vi.fn(async () => "job-import-1");

		vi.doMock("#/server/actions", () =>
			buildActionsServerMock(queueImportFinanceArtifactCommand),
		);

		const { app } = await import("#/server/index");
		const response = await app.fetch(
			new Request("http://localhost/rpc/finance/registry/import", {
				method: "POST",
				headers: {
					authorization: "Bearer machine-token",
				},
			}),
		);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "machine_tokens_not_allowed",
		});
	});

	it("accepts a PDF multipart upload and queues processing", async () => {
		vi.doUnmock("#/server/actions");
		vi.doUnmock("#/server/machine-auth");
		process.env.ZMAIL_TEST_AUTH_ROLE = "org_operator";
		const { app } = await import("#/server/index");
		const form = new FormData();
		form.set(
			"file",
			new File([Buffer.from("%PDF-1.4\n")], "statement.pdf", {
				type: "application/pdf",
			}),
		);
		form.set("mode", "auto");
		form.set("sourceKindHint", "statement");

		const response = await app.fetch(
			new Request("http://localhost/api/finance/uploads", {
				method: "POST",
				body: form,
			}),
		);
		const payload = (await response.json()) as {
			ok: boolean;
			status: string;
			uploadId: string;
			jobId: string;
		};

		expect(response.status).toBe(202);
		expect(payload).toMatchObject({
			ok: true,
			status: "queued",
			uploadId: expect.stringMatching(/^finup_/),
			jobId: expect.any(String),
		});

		const { getDb } = await import("#/lib/db");
		const db = getDb("org-test");
		await expect(
			db
				.selectFrom("finance_import_uploads")
				.select(["id", "status", "mode", "source_kind_hint"])
				.where("id", "=", payload.uploadId)
				.executeTakeFirstOrThrow(),
		).resolves.toMatchObject({
			status: "queued",
			mode: "auto",
			source_kind_hint: "statement",
		});
		await expect(
			db
				.selectFrom("jobs")
				.select(["kind", "scope_id", "lane"])
				.where("id", "=", payload.jobId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({
			kind: "process_finance_upload",
			scope_id: payload.uploadId,
			lane: "finance_llm",
		});
	});

	it("rejects oversized finance uploads before multipart parsing", async () => {
		vi.doUnmock("#/server/actions");
		vi.doUnmock("#/server/machine-auth");
		const { app } = await import("#/server/index");

		const response = await app.fetch(
			new Request("http://localhost/api/finance/uploads", {
				method: "POST",
				headers: {
					"content-length": String(110 * 1024 * 1024 + 1),
					"content-type": "multipart/form-data; boundary=zmail-test",
				},
				body: "--zmail-test--\r\n",
			}),
		);

		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "payload_too_large",
			message: "Upload exceeds 100 MB limit.",
		});
	});

	it("serves the finance import api under the configured base path", async () => {
		process.env.ZMAIL_BASE_PATH = "/zmail";
		const queueImportFinanceArtifactCommand = vi.fn(async () => "job-import-2");

		vi.doMock("#/server/actions", () =>
			buildActionsServerMock(queueImportFinanceArtifactCommand),
		);

		const { app } = await import("#/server/index");
		const response = await app.fetch(
			new Request("http://localhost/zmail/api/finance/imports", {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(buildArtifact("artifact-sha-zmail")),
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			ok: true,
			status: "queued",
			jobId: "job-import-2",
			artifactSha256: "artifact-sha-zmail",
		});
	});
});
