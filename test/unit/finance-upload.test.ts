import { describe, expect, it } from "vitest";

import { bootDb } from "#/test/helpers/db";
import { createTestRuntime } from "#/test/helpers/runtime";

describe("finance upload", () => {
	it("chooses direct text for short text-rich statements in auto mode", async () => {
		const { decideFinanceUploadRoute } = await import("#/lib/finance-upload");
		const text = [
			"Transaction Date Description Amount Balance",
			"2026-01-01 Coffee Shop $12.34 $100.00",
			"2026-01-02 Deposit $500.00 $600.00",
			"2026-01-03 Payment $45.67 $554.33",
			"2026-01-04 Purchase $89.10 $465.23",
			"debit credit balance transaction amount",
		].join("\n");

		expect(
			decideFinanceUploadRoute({
				mode: "auto",
				pages: [{ text: text.repeat(20) }],
			}),
		).toBe("direct_text");
	});

	it("uses Voyage gate for weak text in auto mode", async () => {
		const { decideFinanceUploadRoute } = await import("#/lib/finance-upload");

		expect(
			decideFinanceUploadRoute({
				mode: "auto",
				pages: [{ text: "legal disclosure privacy terms" }],
			}),
		).toBe("voyage_gate");
	});

	it("uses Voyage gate for ZIP batches in auto mode", async () => {
		const { decideFinanceUploadRoute } = await import("#/lib/finance-upload");
		const text = [
			"Transaction Date Description Amount Balance",
			"2026-01-01 Coffee Shop $12.34 $100.00",
			"2026-01-02 Deposit $500.00 $600.00",
			"2026-01-03 Payment $45.67 $554.33",
			"2026-01-04 Purchase $89.10 $465.23",
			"debit credit balance transaction amount",
		].join("\n");

		expect(
			decideFinanceUploadRoute({
				mode: "auto",
				pages: [{ text: text.repeat(20) }],
				forceVoyageGate: true,
			}),
		).toBe("voyage_gate");
	});

	it("rejects unsafe ZIP entry paths", async () => {
		const { sanitizeFinanceUploadLogicalPath } = await import(
			"#/lib/finance-upload"
		);

		expect(sanitizeFinanceUploadLogicalPath("bank/statement.pdf")).toBe(
			"bank/statement.pdf",
		);
		expect(() => sanitizeFinanceUploadLogicalPath("../statement.pdf")).toThrow(
			"Unsafe ZIP entry path",
		);
		expect(() => sanitizeFinanceUploadLogicalPath("/statement.pdf")).toThrow(
			"Unsafe ZIP entry path",
		);
	});

	it("rejects PDF uploads that only match by extension", async () => {
		await createTestRuntime();
		await bootDb();
		const { createFinanceUpload } = await import("#/lib/finance-upload");
		const file = new File([Buffer.from("not a pdf")], "statement.pdf", {
			type: "application/pdf",
		});

		await expect(
			createFinanceUpload({
				file,
				mode: "auto",
				sourceKindHint: "statement",
			}),
		).rejects.toThrow("Only PDF and ZIP finance uploads are supported.");
	});

	it("scores positive page evidence against negative page evidence", async () => {
		const { scoreFinanceUploadCandidate } = await import(
			"#/lib/finance-upload"
		);

		expect(
			scoreFinanceUploadCandidate({
				positiveSimilarity: 0.7,
				negativeSimilarity: 0.2,
			}),
		).toBeCloseTo(0.63);
		expect(
			scoreFinanceUploadCandidate({
				positiveSimilarity: 0.4,
				negativeSimilarity: 0.8,
			}),
		).toBeCloseTo(0.12);
	});

	it("persists a PDF upload and queues one processing job", async () => {
		await createTestRuntime();
		const { db } = await bootDb();
		const { createFinanceUpload } = await import("#/lib/finance-upload");
		const file = new File([Buffer.from("%PDF-1.4\n")], "statement.pdf", {
			type: "application/pdf",
		});

		const first = await createFinanceUpload({
			file,
			mode: "auto",
			sourceKindHint: "statement",
		});
		const second = await createFinanceUpload({
			file,
			mode: "auto",
			sourceKindHint: "statement",
		});

		expect(first.status).toBe("queued");
		expect(first.jobId).toEqual(expect.any(String));
		expect(second.uploadId).toBe(first.uploadId);

		const uploads = await db
			.selectFrom("finance_import_uploads")
			.selectAll()
			.execute();
		const jobs = await db
			.selectFrom("jobs")
			.select(["kind", "scope_id", "lane"])
			.execute();

		expect(uploads).toHaveLength(1);
		expect(uploads[0]).toMatchObject({
			id: first.uploadId,
			status: "queued",
			mode: "auto",
			source_kind_hint: "statement",
			original_filename: "statement.pdf",
		});
		expect(jobs).toContainEqual({
			kind: "process_finance_upload",
			scope_id: first.uploadId,
			lane: "finance_llm",
		});
	});
});
