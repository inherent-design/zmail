import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import * as yauzl from "yauzl";
import { z } from "zod";

import {
	APP_CONFIG,
	nowIso,
	operatorDir,
	PROMPTS_DIR,
	requireVoyageApiKey,
} from "#/lib/config";
import { getDb, jsonText, safeJsonParse } from "#/lib/db";
import { computeArtifactSha256 } from "#/lib/finance-imports";
import { queueJobIdempotent } from "#/lib/jobs";
import { type PiUserPart, piJsonParts } from "#/lib/pi";
import { currentOrgId } from "#/lib/runtime";
import {
	type FinanceImportSourceKind,
	type FinanceSourceImportV2,
	financeImportDocumentV2Schema,
	financeImportSourceKindSchema,
	financeImportTransactionV2Schema,
	normalizeFinanceImportSourceKind,
	registryFinancialAccountSuggestionSchema,
	registryIdentitySuggestionSchema,
	registryInstitutionSuggestionSchema,
	registrySenderRuleSuggestionSchema,
} from "#/lib/schemas";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const FINANCE_UPLOAD_EXTRACT_PROMPT_VERSION =
	"finance-upload-extract-v1";
export const FINANCE_UPLOAD_MERGE_PROMPT_VERSION = "finance-upload-merge-v1";
export const FINANCE_UPLOAD_VOYAGE_MODEL = "voyage-multimodal-3.5";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_EXPANDED_BYTES = 500 * 1024 * 1024;
const MAX_PDFS_PER_UPLOAD = 100;
const MAX_PAGES_PER_PDF = 250;
const MAX_SELECTED_LLM_PAGES = 120;
const TEXT_RICH_PAGE_LIMIT = 10;
const TEXT_PROBE_MAX_CHARS = 80_000;
const POSITIVE_SELECTION_THRESHOLD = 0.28;
const NEAR_DUPLICATE_SIMILARITY = 0.95;

const POSITIVE_QUERIES = [
	"bank or credit card statement page containing a transaction table with dates, descriptions, amounts, and balances",
	"receipt or invoice page containing merchant, transaction date, total, tax, and payment method",
	"financial account activity page with deposits, withdrawals, transfers, fees, or payments",
];

const NEGATIVE_QUERIES = [
	"cover page, legal disclosure, privacy notice, marketing page, blank page, or terms page",
];

export type FinanceUploadMode = "auto" | "direct_llm" | "voyage_gate";
export type FinanceUploadRetention = "org_file_ref";

const financeUploadModeSchema = z
	.enum(["auto", "direct_llm", "voyage_gate"])
	.default("auto");

const financeUploadRetentionSchema = z
	.enum(["org_file_ref"])
	.default("org_file_ref");

const financeUploadSourceKindHintSchema = z
	.preprocess(
		(value) =>
			value === null || value === undefined || value === ""
				? null
				: normalizeFinanceImportSourceKind(value),
		financeImportSourceKindSchema.nullable(),
	)
	.nullable()
	.default(null);

const financeUploadExtractionSchema = z.object({
	schemaVersion: z.literal("finance-upload-extraction.v1"),
	registrySuggestions: z
		.object({
			identities: z.array(registryIdentitySuggestionSchema).default([]),
			institutions: z.array(registryInstitutionSuggestionSchema).default([]),
			financialAccounts: z
				.array(registryFinancialAccountSuggestionSchema)
				.default([]),
			senderRules: z.array(registrySenderRuleSuggestionSchema).default([]),
		})
		.default({
			identities: [],
			institutions: [],
			financialAccounts: [],
			senderRules: [],
		}),
	documents: z.array(financeImportDocumentV2Schema).default([]),
	transactions: z.array(financeImportTransactionV2Schema).default([]),
	notes: z.array(z.string().min(1).max(500)).default([]),
});

type FinanceUploadExtraction = z.infer<typeof financeUploadExtractionSchema>;

type UploadRow = {
	id: string;
	org_id: string;
	status: string;
	mode: string;
	source_kind_hint: string | null;
	upload_sha256: string;
	original_filename: string;
	stored_path: string;
	total_bytes: number;
	artifact_sha256: string | null;
	import_run_id: string | null;
	error_json: string;
	created_at: string;
	updated_at: string;
};

type UploadFileRow = {
	id: string;
	upload_id: string;
	logical_path: string;
	stored_path: string;
	mime_type: string;
	sha256: string;
	size_bytes: number;
	page_count: number | null;
	status: string;
	created_at: string;
};

type PageProbe = {
	fileId: string;
	logicalPath: string;
	pageNumber: number;
	text: string;
	textProbeChars: number;
	imagePath: string | null;
	imageSha256: string | null;
	width: number | null;
	height: number | null;
	candidateScore: number | null;
	candidateReasons: string[];
	selectedForLlm: boolean;
	embedding: number[] | null;
	embeddingSha256: string | null;
};

type PreparedPdf = {
	file: UploadFileRow;
	pages: PageProbe[];
	route: "direct_text" | "direct_images" | "voyage_gate";
};

type VoyageContent =
	| { type: "text"; text: string }
	| { type: "image_base64"; imageBase64: string };

export interface FinanceUploadEmbeddingProvider {
	embedMultimodal(input: {
		inputType: "query" | "document";
		inputs: VoyageContent[][];
		model: string;
	}): Promise<{ embeddings: number[][]; usage: unknown | null }>;
}

export interface CreateFinanceUploadInput {
	file: File;
	mode?: string | null;
	sourceKindHint?: string | null;
	retention?: string | null;
}

class FinanceUploadNeedsReviewError extends Error {
	readonly reason: string;
	readonly details: Record<string, unknown>;

	constructor(reason: string, details: Record<string, unknown> = {}) {
		super(String(details.message ?? reason));
		this.name = "FinanceUploadNeedsReviewError";
		this.reason = reason;
		this.details = details;
	}
}

function sha256Buffer(value: Buffer) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

async function financeUploadResultForExisting(existing: {
	id: string;
	status: string;
}) {
	const jobId =
		existing.status === "imported"
			? null
			: await queueProcessFinanceUpload(existing.id);
	return {
		uploadId: existing.id,
		jobId,
		status: existing.status === "imported" ? "already_imported" : "queued",
	};
}

function parseMode(value?: string | null) {
	return financeUploadModeSchema.parse(value || undefined);
}

function parseSourceKindHint(value?: string | null) {
	return financeUploadSourceKindHintSchema.parse(value || null);
}

export function financeUploadArtifactSourceKind(
	value?: string | null,
): FinanceImportSourceKind {
	return value ? normalizeFinanceImportSourceKind(value) : "pdf";
}

function parseRetention(value?: string | null) {
	return financeUploadRetentionSchema.parse(value || undefined);
}

function uploadRoot(uploadId: string) {
	return resolve(operatorDir(), "imports", "uploads", uploadId);
}

function extensionForUpload(filename: string, buffer: Buffer) {
	const lower = filename.toLowerCase();
	if (isPdfBuffer(buffer) && lower.endsWith(".pdf")) {
		return ".pdf";
	}
	if (isZipBuffer(buffer) && lower.endsWith(".zip")) {
		return ".zip";
	}
	throw new Error("Only PDF and ZIP finance uploads are supported.");
}

function mimeForStoredPath(path: string) {
	return path.toLowerCase().endsWith(".zip")
		? "application/zip"
		: "application/pdf";
}

function isPdfBuffer(buffer: Buffer) {
	return buffer.subarray(0, 4).toString("utf8") === "%PDF";
}

function isZipBuffer(buffer: Buffer) {
	if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
		return false;
	}
	const signature = buffer.subarray(0, 4).toString("hex");
	return signature === "504b0304" || signature === "504b0506";
}

function isPdfName(value: string) {
	return value.toLowerCase().endsWith(".pdf");
}

function isZipName(value: string) {
	return value.toLowerCase().endsWith(".zip");
}

export function sanitizeFinanceUploadLogicalPath(value: string) {
	const normalized = value.replaceAll("\\", "/");
	const parts = normalized.split("/").filter(Boolean);
	if (
		parts.length === 0 ||
		parts.some((part) => part === "." || part === "..") ||
		normalized.startsWith("/")
	) {
		throw new Error(`Unsafe ZIP entry path: ${value}`);
	}
	return parts
		.map((part) => part.replace(/[^A-Za-z0-9._ -]/g, "_").trim() || "file")
		.join("/");
}

async function ensureParent(path: string) {
	await mkdir(dirname(path), { recursive: true });
}

async function writeBuffer(path: string, buffer: Buffer) {
	await ensureParent(path);
	await writeFile(path, buffer);
}

async function updateUploadStatus(
	uploadId: string,
	status: string,
	error: Record<string, unknown> | null = null,
) {
	const db = getDb();
	await db
		.updateTable("finance_import_uploads")
		.set({
			status,
			error_json: jsonText(error ?? {}),
			updated_at: nowIso(),
		})
		.where("id", "=", uploadId)
		.execute();
}

async function clearUploadWorkRows(uploadId: string) {
	const db = getDb();
	const files = await db
		.selectFrom("finance_import_upload_files")
		.select(["id"])
		.where("upload_id", "=", uploadId)
		.execute();
	for (const file of files) {
		await db
			.deleteFrom("finance_import_upload_pages")
			.where("upload_file_id", "=", file.id)
			.execute();
	}
	await db
		.deleteFrom("finance_import_upload_extractions")
		.where("upload_id", "=", uploadId)
		.execute();
	await db
		.deleteFrom("finance_import_upload_files")
		.where("upload_id", "=", uploadId)
		.execute();
}

export async function createFinanceUpload(input: CreateFinanceUploadInput) {
	const mode = parseMode(input.mode);
	const sourceKindHint = parseSourceKindHint(input.sourceKindHint);
	parseRetention(input.retention);
	const originalFilename = basename(input.file.name || "finance-upload");
	const buffer = Buffer.from(await input.file.arrayBuffer());
	if (buffer.length === 0) {
		throw new Error("Upload file is empty.");
	}
	if (buffer.length > MAX_UPLOAD_BYTES) {
		throw new Error("Upload exceeds 100 MB limit.");
	}

	const ext = extensionForUpload(originalFilename, buffer);
	const uploadSha256 = sha256Buffer(buffer);
	const db = getDb();
	const orgId = currentOrgId();
	const readUploadBySha256 = () =>
		db
			.selectFrom("finance_import_uploads")
			.select(["id", "status"])
			.where("org_id", "=", orgId)
			.where("upload_sha256", "=", uploadSha256)
			.executeTakeFirst();
	const existing = await readUploadBySha256();
	if (existing) {
		return financeUploadResultForExisting(existing);
	}

	const uploadId = `finup_${randomUUID()}`;
	const root = uploadRoot(uploadId);
	const storedPath = resolve(root, "raw", `${uploadSha256}${ext}`);
	await writeBuffer(storedPath, buffer);
	const now = nowIso();
	await db
		.insertInto("finance_import_uploads")
		.values({
			id: uploadId,
			org_id: orgId,
			status: "queued",
			mode,
			source_kind_hint: sourceKindHint,
			upload_sha256: uploadSha256,
			original_filename: originalFilename,
			stored_path: storedPath,
			total_bytes: buffer.length,
			artifact_sha256: null,
			import_run_id: null,
			error_json: "{}",
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) => oc.columns(["org_id", "upload_sha256"]).doNothing())
		.execute();

	const upload = await readUploadBySha256();
	if (!upload) {
		throw new Error("Finance upload insert did not persist.");
	}
	if (upload.id !== uploadId) {
		await rm(root, { recursive: true, force: true });
		return financeUploadResultForExisting(upload);
	}

	return {
		uploadId,
		jobId: await queueProcessFinanceUpload(uploadId),
		status: "queued",
	};
}

export async function queueProcessFinanceUpload(uploadId: string) {
	return queueJobIdempotent({
		kind: "process_finance_upload",
		scopeType: "finance_upload",
		scopeId: uploadId,
		lane: "finance_llm",
		meta: { uploadId },
	});
}

async function readUpload(uploadId: string): Promise<UploadRow> {
	return getDb()
		.selectFrom("finance_import_uploads")
		.selectAll()
		.where("id", "=", uploadId)
		.executeTakeFirstOrThrow();
}

async function insertUploadFile(input: {
	uploadId: string;
	logicalPath: string;
	storedPath: string;
	mimeType: string;
	sha256: string;
	sizeBytes: number;
}) {
	const id = `finfile_${randomUUID()}`;
	const now = nowIso();
	await getDb()
		.insertInto("finance_import_upload_files")
		.values({
			id,
			upload_id: input.uploadId,
			logical_path: input.logicalPath,
			stored_path: input.storedPath,
			mime_type: input.mimeType,
			sha256: input.sha256,
			size_bytes: input.sizeBytes,
			page_count: null,
			status: "queued",
			created_at: now,
		})
		.execute();
	return getDb()
		.selectFrom("finance_import_upload_files")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
}

function isSymlinkEntry(entry: yauzl.Entry) {
	const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
	return (mode & 0o170000) === 0o120000;
}

function openZip(path: string) {
	return new Promise<yauzl.ZipFile>((resolveZip, reject) => {
		yauzl.open(
			path,
			{ lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, zipFile) => {
				if (error) {
					reject(error);
					return;
				}
				if (!zipFile) {
					reject(new Error("ZIP open returned no file."));
					return;
				}
				resolveZip(zipFile);
			},
		);
	});
}

function readZipEntryBuffer(zipFile: yauzl.ZipFile, entry: yauzl.Entry) {
	return new Promise<Buffer>((resolveBuffer, reject) => {
		zipFile.openReadStream(entry, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}
			if (!stream) {
				reject(new Error("ZIP entry read stream unavailable."));
				return;
			}
			const chunks: Buffer[] = [];
			let total = 0;
			stream.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > MAX_ZIP_EXPANDED_BYTES) {
					stream.destroy(
						new FinanceUploadNeedsReviewError(
							"zip_expanded_byte_limit_exceeded",
							{ message: "ZIP expanded byte limit exceeded." },
						),
					);
					return;
				}
				chunks.push(chunk);
			});
			stream.on("error", reject);
			stream.on("end", () => resolveBuffer(Buffer.concat(chunks)));
		});
	});
}

async function materializeZipFiles(upload: UploadRow) {
	const zipFile = await openZip(upload.stored_path);
	const files: UploadFileRow[] = [];
	let entryCount = 0;
	let expandedBytes = 0;

	try {
		while (true) {
			const entry = await new Promise<yauzl.Entry | null>(
				(resolveEntry, reject) => {
					const onEntry = (nextEntry: yauzl.Entry) => {
						cleanup();
						resolveEntry(nextEntry);
					};
					const onEnd = () => {
						cleanup();
						resolveEntry(null);
					};
					const onError = (error: Error) => {
						cleanup();
						reject(error);
					};
					const cleanup = () => {
						zipFile.off("entry", onEntry);
						zipFile.off("end", onEnd);
						zipFile.off("error", onError);
					};
					zipFile.once("entry", onEntry);
					zipFile.once("end", onEnd);
					zipFile.once("error", onError);
					zipFile.readEntry();
				},
			);
			if (!entry) {
				break;
			}
			if (/\/$/.test(entry.fileName)) {
				continue;
			}
			entryCount += 1;
			if (entryCount > MAX_ZIP_ENTRIES) {
				throw new FinanceUploadNeedsReviewError("zip_entry_limit_exceeded", {
					message: "ZIP entry limit exceeded.",
					entries: entryCount,
					limit: MAX_ZIP_ENTRIES,
				});
			}
			if (isSymlinkEntry(entry)) {
				throw new Error(`ZIP symlink entry rejected: ${entry.fileName}`);
			}
			const logicalPath = sanitizeFinanceUploadLogicalPath(entry.fileName);
			if (entry.uncompressedSize === 0) {
				throw new Error(`ZIP empty file rejected: ${entry.fileName}`);
			}
			expandedBytes += entry.uncompressedSize;
			if (expandedBytes > MAX_ZIP_EXPANDED_BYTES) {
				throw new FinanceUploadNeedsReviewError(
					"zip_expanded_byte_limit_exceeded",
					{
						message: "ZIP expanded byte limit exceeded.",
						expandedBytes,
						limit: MAX_ZIP_EXPANDED_BYTES,
					},
				);
			}
			if (isZipName(logicalPath)) {
				throw new Error(`Nested ZIP entry rejected: ${entry.fileName}`);
			}
			if (!isPdfName(logicalPath)) {
				continue;
			}
			if (files.length >= MAX_PDFS_PER_UPLOAD) {
				throw new FinanceUploadNeedsReviewError("pdf_count_limit_exceeded", {
					message: "PDF count limit exceeded.",
					pdfs: files.length + 1,
					limit: MAX_PDFS_PER_UPLOAD,
				});
			}
			const buffer = await readZipEntryBuffer(zipFile, entry);
			if (!isPdfBuffer(buffer)) {
				throw new Error(`ZIP PDF candidate is not a PDF: ${entry.fileName}`);
			}
			const sha256 = sha256Buffer(buffer);
			const storedPath = resolve(uploadRoot(upload.id), "raw", `${sha256}.pdf`);
			await writeBuffer(storedPath, buffer);
			files.push(
				await insertUploadFile({
					uploadId: upload.id,
					logicalPath,
					storedPath,
					mimeType: "application/pdf",
					sha256,
					sizeBytes: buffer.length,
				}),
			);
		}
	} finally {
		zipFile.close();
	}

	return files;
}

async function materializeUploadFiles(upload: UploadRow) {
	await clearUploadWorkRows(upload.id);
	if (upload.stored_path.toLowerCase().endsWith(".zip")) {
		return materializeZipFiles(upload);
	}
	const stats = await stat(upload.stored_path);
	return [
		await insertUploadFile({
			uploadId: upload.id,
			logicalPath: upload.original_filename,
			storedPath: upload.stored_path,
			mimeType: mimeForStoredPath(upload.stored_path),
			sha256: upload.upload_sha256,
			sizeBytes: stats.size,
		}),
	];
}

async function runTool(
	command: string,
	args: string[],
	options?: { maxBuffer?: number },
) {
	const result = await execFileAsync(command, args, {
		timeout: 60_000,
		maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
	});
	return result.stdout;
}

async function pdfPageCount(path: string) {
	const output = await runTool("pdfinfo", [path]);
	const match = /^Pages:\s+(\d+)/m.exec(output);
	if (!match) {
		throw new Error("Could not read PDF page count.");
	}
	return Number.parseInt(match[1], 10);
}

async function pdfPageText(path: string, pageNumber: number) {
	const output = await runTool(
		"pdftotext",
		["-layout", "-f", String(pageNumber), "-l", String(pageNumber), path, "-"],
		{ maxBuffer: 5 * 1024 * 1024 },
	);
	return output.slice(0, TEXT_PROBE_MAX_CHARS);
}

async function renderPdfPage(input: {
	file: UploadFileRow;
	pageNumber: number;
	uploadId: string;
}) {
	const dir = resolve(uploadRoot(input.uploadId), "extracted", input.file.id);
	await mkdir(dir, { recursive: true });
	const prefix = resolve(dir, String(input.pageNumber).padStart(4, "0"));
	const imagePath = `${prefix}.jpg`;
	await rm(imagePath, { force: true });
	await runTool("pdftoppm", [
		"-f",
		String(input.pageNumber),
		"-l",
		String(input.pageNumber),
		"-r",
		"150",
		"-jpeg",
		"-singlefile",
		input.file.stored_path,
		prefix,
	]);
	const buffer = await readFile(imagePath);
	const dimensions = await imageDimensions(imagePath).catch(() => ({
		width: null,
		height: null,
	}));
	return {
		imagePath,
		imageSha256: sha256Buffer(buffer),
		width: dimensions.width,
		height: dimensions.height,
	};
}

async function imageDimensions(path: string) {
	const output = await runTool("magick", [
		"identify",
		"-format",
		"%w %h",
		path,
	]);
	const [widthText, heightText] = output.trim().split(/\s+/);
	const width = widthText ? Number.parseInt(widthText, 10) : Number.NaN;
	const height = heightText ? Number.parseInt(heightText, 10) : Number.NaN;
	return {
		width: Number.isFinite(width) ? width : null,
		height: Number.isFinite(height) ? height : null,
	};
}

function textLooksTransactionRich(pages: Array<{ text: string }>) {
	const combined = pages
		.map((page) => page.text)
		.join("\n")
		.slice(0, 60_000);
	const moneyMatches =
		combined.match(/[$€£]?\s*-?\d{1,3}(?:,\d{3})*\.\d{2}/g)?.length ?? 0;
	const dateMatches =
		combined.match(
			/\b(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\b/g,
		)?.length ?? 0;
	const rowishMatches =
		combined.match(
			/\b(?:debit|credit|payment|deposit|withdrawal|purchase|balance|amount|transaction)\b/gi,
		)?.length ?? 0;
	return (
		pages.length <= TEXT_RICH_PAGE_LIMIT &&
		combined.length >= 1500 &&
		moneyMatches >= 4 &&
		dateMatches >= 4 &&
		rowishMatches >= 2
	);
}

export function decideFinanceUploadRoute(input: {
	mode: FinanceUploadMode;
	pages: Array<{ text: string }>;
	forceVoyageGate?: boolean;
}) {
	const textRich = textLooksTransactionRich(input.pages);
	if (input.mode === "voyage_gate") {
		return "voyage_gate" as const;
	}
	if (input.mode === "direct_llm") {
		return textRich ? ("direct_text" as const) : ("direct_images" as const);
	}
	if (input.forceVoyageGate) {
		return "voyage_gate" as const;
	}
	return textRich ? ("direct_text" as const) : ("voyage_gate" as const);
}

export function scoreFinanceUploadCandidate(input: {
	positiveSimilarity: number;
	negativeSimilarity: number;
}) {
	return input.positiveSimilarity - 0.35 * input.negativeSimilarity;
}

async function createVoyageEmbeddingProvider(): Promise<FinanceUploadEmbeddingProvider> {
	const { VoyageAIClient } = require("voyageai") as {
		VoyageAIClient: new (input: {
			apiKey: string;
		}) => {
			multimodalEmbed(input: {
				inputs: Array<{ content: VoyageContent[] }>;
				inputType: "query" | "document";
				model: string;
				truncation: boolean;
			}): Promise<{
				data?: Array<{ embedding?: number[] | null }> | null;
				usage?: unknown | null;
			}>;
		};
	};
	const client = new VoyageAIClient({ apiKey: requireVoyageApiKey() });
	return {
		async embedMultimodal(input) {
			const response = await client.multimodalEmbed({
				inputs: input.inputs.map((content) => ({ content })),
				inputType: input.inputType,
				model: input.model,
				truncation: true,
			});
			return {
				embeddings:
					response.data
						?.map((item) => item.embedding ?? [])
						.filter((embedding) => embedding.length > 0) ?? [],
				usage: response.usage ?? null,
			};
		},
	};
}

function dataUrlForImage(path: string, buffer: Buffer) {
	const lower = path.toLowerCase();
	const mimeType = lower.endsWith(".webp")
		? "image/webp"
		: lower.endsWith(".png")
			? "image/png"
			: "image/jpeg";
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function cosineSimilarity(left: number[], right: number[]) {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dot += leftValue * rightValue;
		leftNorm += leftValue * leftValue;
		rightNorm += rightValue * rightValue;
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function embeddingHash(embedding: number[]) {
	return sha256Text(
		JSON.stringify(embedding.map((value) => Number(value.toFixed(8)))),
	);
}

async function applyVoyageGate(
	pages: PageProbe[],
	provider: FinanceUploadEmbeddingProvider,
) {
	const queryEmbeddings = await provider.embedMultimodal({
		inputType: "query",
		model: FINANCE_UPLOAD_VOYAGE_MODEL,
		inputs: [...POSITIVE_QUERIES, ...NEGATIVE_QUERIES].map((text) => [
			{ type: "text", text },
		]),
	});
	const positiveEmbeddings = queryEmbeddings.embeddings.slice(
		0,
		POSITIVE_QUERIES.length,
	);
	const negativeEmbeddings = queryEmbeddings.embeddings.slice(
		POSITIVE_QUERIES.length,
	);
	const renderedPages = pages.filter((page) => page.imagePath);
	const imageInputs = await Promise.all(
		renderedPages.map(async (page) => {
			const imagePath = page.imagePath;
			if (!imagePath) {
				throw new Error("Rendered page missing image path.");
			}
			const buffer = await readFile(imagePath);
			return [
				{
					type: "image_base64" as const,
					imageBase64: dataUrlForImage(imagePath, buffer),
				},
			];
		}),
	);
	const pageEmbeddings = await provider.embedMultimodal({
		inputType: "document",
		model: FINANCE_UPLOAD_VOYAGE_MODEL,
		inputs: imageInputs,
	});

	for (const [index, page] of renderedPages.entries()) {
		const embedding = pageEmbeddings.embeddings[index] ?? null;
		if (!embedding) {
			continue;
		}
		const positive = Math.max(
			0,
			...positiveEmbeddings.map((query) => cosineSimilarity(query, embedding)),
		);
		const negative = Math.max(
			0,
			...negativeEmbeddings.map((query) => cosineSimilarity(query, embedding)),
		);
		page.embedding = embedding;
		page.embeddingSha256 = embeddingHash(embedding);
		page.candidateScore = scoreFinanceUploadCandidate({
			positiveSimilarity: positive,
			negativeSimilarity: negative,
		});
		page.candidateReasons = [
			`positive=${positive.toFixed(3)}`,
			`negative=${negative.toFixed(3)}`,
		];
	}

	const selected = new Set<number>();
	for (const [index, page] of pages.entries()) {
		if ((page.candidateScore ?? 0) >= POSITIVE_SELECTION_THRESHOLD) {
			selected.add(index);
			selected.add(index - 1);
			selected.add(index + 1);
		}
	}
	if (selected.size === 0) {
		pages
			.map((page, index) => ({ page, index }))
			.sort(
				(left, right) =>
					(right.page.candidateScore ?? -1) - (left.page.candidateScore ?? -1),
			)
			.slice(0, 3)
			.forEach(({ index }) => {
				selected.add(index);
			});
	}
	for (const [index, page] of pages.entries()) {
		page.selectedForLlm = selected.has(index);
		if (page.selectedForLlm) {
			page.candidateReasons.push("selected_for_llm");
		}
	}

	const seenImageHashes = new Set<string>();
	const seenEmbeddings: number[][] = [];
	for (const page of pages.filter((candidate) => candidate.selectedForLlm)) {
		if (page.imageSha256) {
			if (seenImageHashes.has(page.imageSha256)) {
				page.selectedForLlm = false;
				page.candidateReasons.push("duplicate_image_sha");
				continue;
			}
			seenImageHashes.add(page.imageSha256);
		}
		if (
			page.embedding &&
			seenEmbeddings.some(
				(existing) =>
					cosineSimilarity(existing, page.embedding ?? []) >
					NEAR_DUPLICATE_SIMILARITY,
			)
		) {
			page.selectedForLlm = false;
			page.candidateReasons.push("near_duplicate_embedding");
			continue;
		}
		if (page.embedding) {
			seenEmbeddings.push(page.embedding);
		}
	}
}

async function persistPageRows(pages: PageProbe[]) {
	const db = getDb();
	const now = nowIso();
	if (pages.length === 0) {
		return;
	}
	await db
		.insertInto("finance_import_upload_pages")
		.values(
			pages.map((page) => ({
				id: `finpage_${randomUUID()}`,
				upload_file_id: page.fileId,
				page_number: page.pageNumber,
				image_path: page.imagePath,
				image_sha256: page.imageSha256,
				width: page.width,
				height: page.height,
				text_probe_chars: page.textProbeChars,
				voyage_model: page.embeddingSha256 ? FINANCE_UPLOAD_VOYAGE_MODEL : null,
				embedding_dimension: page.embedding ? page.embedding.length : null,
				embedding_sha256: page.embeddingSha256,
				candidate_score: page.candidateScore,
				candidate_reasons_json: jsonText(page.candidateReasons),
				selected_for_llm: page.selectedForLlm ? 1 : 0,
				created_at: now,
			})),
		)
		.execute();
}

async function preparePdf(input: {
	upload: UploadRow;
	file: UploadFileRow;
	provider?: FinanceUploadEmbeddingProvider;
	forceVoyageGate?: boolean;
}) {
	const pageCount = await pdfPageCount(input.file.stored_path);
	if (pageCount > MAX_PAGES_PER_PDF) {
		throw new FinanceUploadNeedsReviewError("pdf_page_limit_exceeded", {
			message: `PDF page limit exceeded for ${input.file.logical_path}: ${pageCount}`,
			logicalPath: input.file.logical_path,
			pages: pageCount,
			limit: MAX_PAGES_PER_PDF,
		});
	}
	await getDb()
		.updateTable("finance_import_upload_files")
		.set({ page_count: pageCount, status: "processing" })
		.where("id", "=", input.file.id)
		.execute();

	const pages: PageProbe[] = [];
	for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
		const text = await pdfPageText(input.file.stored_path, pageNumber).catch(
			() => "",
		);
		pages.push({
			fileId: input.file.id,
			logicalPath: input.file.logical_path,
			pageNumber,
			text,
			textProbeChars: text.length,
			imagePath: null,
			imageSha256: null,
			width: null,
			height: null,
			candidateScore: null,
			candidateReasons: [],
			selectedForLlm: false,
			embedding: null,
			embeddingSha256: null,
		});
	}

	const mode = parseMode(input.upload.mode);
	const route = decideFinanceUploadRoute({
		mode,
		pages,
		forceVoyageGate: input.forceVoyageGate,
	});

	if (route === "direct_text") {
		for (const page of pages) {
			page.selectedForLlm = true;
			page.candidateReasons.push("text_rich_direct_llm");
		}
	} else {
		for (const page of pages) {
			const rendered = await renderPdfPage({
				file: input.file,
				pageNumber: page.pageNumber,
				uploadId: input.upload.id,
			});
			Object.assign(page, rendered);
		}
		if (route === "voyage_gate") {
			if (!input.provider) {
				if (mode === "voyage_gate") {
					throw new Error("Voyage provider unavailable for voyage_gate mode.");
				}
				pages.slice(0, Math.min(3, pages.length)).forEach((page) => {
					page.selectedForLlm = true;
					page.candidateReasons.push("voyage_unavailable_auto_fallback");
				});
			} else {
				await applyVoyageGate(pages, input.provider);
			}
		} else {
			for (const page of pages) {
				page.selectedForLlm = true;
				page.candidateReasons.push("direct_image_llm");
			}
		}
	}

	await persistPageRows(pages);
	await getDb()
		.updateTable("finance_import_upload_files")
		.set({ status: "processed" })
		.where("id", "=", input.file.id)
		.execute();
	return { file: input.file, pages, route } satisfies PreparedPdf;
}

function buildPageGroups(prepared: PreparedPdf[]) {
	const groups: PageProbe[][] = [];
	for (const pdf of prepared) {
		const selected = pdf.pages
			.filter((page) => page.selectedForLlm)
			.sort((left, right) => left.pageNumber - right.pageNumber);
		let run: PageProbe[] = [];
		const flush = () => {
			for (let index = 0; index < run.length; index += 6) {
				groups.push(run.slice(index, index + 6));
			}
			run = [];
		};
		for (const page of selected) {
			const previous = run.at(-1);
			if (previous && page.pageNumber !== previous.pageNumber + 1) {
				flush();
			}
			run.push(page);
		}
		flush();
	}
	return groups.slice(0, Math.ceil(MAX_SELECTED_LLM_PAGES / 6));
}

function pageRef(page: PageProbe) {
	return `${page.logicalPath}#page=${String(page.pageNumber)}`;
}

async function loadPrompt(name: string) {
	return readFile(resolve(PROMPTS_DIR, `${name}.md`), "utf8");
}

function textPart(text: string): PiUserPart {
	return { type: "text", text };
}

async function imagePart(path: string): Promise<PiUserPart> {
	const data = (await readFile(path)).toString("base64");
	const lower = path.toLowerCase();
	const mimeType = lower.endsWith(".webp")
		? "image/webp"
		: lower.endsWith(".png")
			? "image/png"
			: "image/jpeg";
	return { type: "image", data, mimeType };
}

async function extractGroup(group: PageProbe[]) {
	const prompt = await loadPrompt(FINANCE_UPLOAD_EXTRACT_PROMPT_VERSION);
	const parts: PiUserPart[] = [
		textPart(
			[
				"Extract finance transactions from these upload pages.",
				"Return only JSON matching schemaVersion finance-upload-extraction.v1.",
				"Page refs:",
				...group.map((page) => `- ${pageRef(page)}`),
			].join("\n"),
		),
	];
	for (const page of group) {
		const text = page.text.trim();
		parts.push(
			textPart(
				[
					`Page ${pageRef(page)}`,
					text ? text.slice(0, 10_000) : "(no embedded text)",
				].join("\n"),
			),
		);
		if (page.imagePath) {
			parts.push(await imagePart(page.imagePath));
		}
	}
	const result = await piJsonParts({
		schema: financeUploadExtractionSchema,
		modelId: APP_CONFIG.fallbackModel,
		systemPrompt: prompt,
		userParts: parts,
	});
	return {
		...result,
		pageRefs: group.map(pageRef),
	};
}

function mergeRegistrySuggestions(results: FinanceUploadExtraction[]) {
	return {
		identities: results.flatMap(
			(result) => result.registrySuggestions.identities,
		),
		institutions: results.flatMap(
			(result) => result.registrySuggestions.institutions,
		),
		financialAccounts: results.flatMap(
			(result) => result.registrySuggestions.financialAccounts,
		),
		senderRules: results.flatMap(
			(result) => result.registrySuggestions.senderRules,
		),
	};
}

async function mergeExtractions(results: FinanceUploadExtraction[]) {
	if (results.length <= 1) {
		return {
			parsed: results[0] ?? {
				schemaVersion: "finance-upload-extraction.v1",
				registrySuggestions: {
					identities: [],
					institutions: [],
					financialAccounts: [],
					senderRules: [],
				},
				documents: [],
				transactions: [],
				notes: [],
			},
			modelId: "local",
			usage: null,
			usedLlm: false,
		};
	}
	const prompt = await loadPrompt(FINANCE_UPLOAD_MERGE_PROMPT_VERSION);
	const result = await piJsonParts({
		schema: financeUploadExtractionSchema,
		modelId: APP_CONFIG.fallbackModel,
		systemPrompt: prompt,
		userParts: [
			textPart(
				[
					"Merge these extraction batches into one deduped upload extraction.",
					"Return only JSON matching schemaVersion finance-upload-extraction.v1.",
					JSON.stringify(results),
				].join("\n\n"),
			),
		],
	});
	return {
		parsed: result.parsed,
		modelId: result.modelId,
		usage: result.usage,
		usedLlm: true,
	};
}

function normalizeExtractedRows(extraction: FinanceUploadExtraction) {
	return {
		...extraction,
		documents: extraction.documents.map((document, index) => ({
			...document,
			sourceDocumentRef:
				document.sourceDocumentRef ?? `uploaded-document:${index + 1}`,
			evidenceText: document.evidenceText.slice(0, 2000),
		})),
		transactions: extraction.transactions.map((transaction, index) => ({
			...transaction,
			statementRowId:
				transaction.statementRowId ??
				`uploaded-row:${String(index + 1).padStart(6, "0")}`,
			rowIndex: transaction.rowIndex ?? index,
			evidenceText: transaction.evidenceText.slice(0, 2000),
			extractionConfidence: transaction.extractionConfidence || 0.6,
			rowProvenance: {
				...transaction.rowProvenance,
				uploadRowIndex: index,
			},
		})),
	};
}

function buildArtifact(input: {
	upload: UploadRow;
	extraction: FinanceUploadExtraction;
	prepared: PreparedPdf[];
	modelIds: string[];
}) {
	const normalized = normalizeExtractedRows(input.extraction);
	const selectedPages = input.prepared.flatMap((pdf) =>
		pdf.pages
			.filter((page) => page.selectedForLlm)
			.map((page) => ({
				fileId: page.fileId,
				pageNumber: page.pageNumber,
				pageRef: pageRef(page),
				candidateScore: page.candidateScore,
				reasons: page.candidateReasons,
			})),
	);
	const sourceKind = financeUploadArtifactSourceKind(
		input.upload.source_kind_hint,
	);
	const baseArtifact: FinanceSourceImportV2 = {
		schemaVersion: "finance-source-import.v2",
		sourceKind,
		sourceFile: {
			absolutePath: input.upload.stored_path,
			sha256: input.upload.upload_sha256,
			filename: input.upload.original_filename,
			importedAt: input.upload.created_at,
		},
		artifactSha256: "",
		extractor: {
			runner: "zmail-finance-upload",
			model:
				Array.from(new Set(input.modelIds)).join("+") ||
				APP_CONFIG.fallbackModel,
			promptVersion: `${FINANCE_UPLOAD_EXTRACT_PROMPT_VERSION}+${FINANCE_UPLOAD_MERGE_PROMPT_VERSION}`,
			extractedTextHash:
				sha256Text(
					input.prepared
						.flatMap((pdf) => pdf.pages.map((page) => page.text))
						.join("\n"),
				) || null,
		},
		registrySuggestions: mergeRegistrySuggestions([normalized]),
		documents: normalized.documents,
		transactions: normalized.transactions,
		provenance: {
			uploadId: input.upload.id,
			mode: input.upload.mode,
			selectedPages,
			routes: input.prepared.map((pdf) => ({
				fileId: pdf.file.id,
				logicalPath: pdf.file.logical_path,
				route: pdf.route,
			})),
		},
	};
	return {
		...baseArtifact,
		artifactSha256: computeArtifactSha256(baseArtifact),
	};
}

async function writeArtifact(
	uploadId: string,
	artifact: FinanceSourceImportV2,
) {
	const path = resolve(
		uploadRoot(uploadId),
		"artifacts",
		`${artifact.artifactSha256}.json`,
	);
	await writeBuffer(path, Buffer.from(JSON.stringify(artifact, null, 2)));
	return path;
}

async function queueArtifactImport(input: {
	uploadId: string;
	artifact: FinanceSourceImportV2;
}) {
	return queueJobIdempotent({
		kind: "import_finance_artifact",
		scopeType: "system",
		scopeId: input.artifact.artifactSha256,
		meta: { artifact: input.artifact, uploadId: input.uploadId },
	});
}

async function writeSelectionDiagnostics(
	uploadId: string,
	prepared: PreparedPdf[],
) {
	const diagnostics = {
		uploadId,
		voyageModel: FINANCE_UPLOAD_VOYAGE_MODEL,
		selectedPageLimit: MAX_SELECTED_LLM_PAGES,
		positiveSelectionThreshold: POSITIVE_SELECTION_THRESHOLD,
		files: prepared.map((pdf) => ({
			fileId: pdf.file.id,
			logicalPath: pdf.file.logical_path,
			route: pdf.route,
			pageCount: pdf.pages.length,
			selectedPages: pdf.pages.filter((page) => page.selectedForLlm).length,
			pages: pdf.pages.map((page) => ({
				pageNumber: page.pageNumber,
				imageSha256: page.imageSha256,
				textProbeChars: page.textProbeChars,
				candidateScore: page.candidateScore,
				candidateReasons: page.candidateReasons,
				selectedForLlm: page.selectedForLlm,
			})),
		})),
	};
	await writeBuffer(
		resolve(uploadRoot(uploadId), "diagnostics", "selection.json"),
		Buffer.from(JSON.stringify(diagnostics, null, 2)),
	);
}

export async function markFinanceUploadImported(input: {
	uploadId: string;
	artifactSha256: string;
	importRunId: string;
}) {
	await getDb()
		.updateTable("finance_import_uploads")
		.set({
			status: "imported",
			artifact_sha256: input.artifactSha256,
			import_run_id: input.importRunId,
			error_json: "{}",
			updated_at: nowIso(),
		})
		.where("id", "=", input.uploadId)
		.execute();
}

export async function processFinanceUpload(input: {
	uploadId: string;
	embeddingProvider?: FinanceUploadEmbeddingProvider | null;
}) {
	const upload = await readUpload(input.uploadId);
	await updateUploadStatus(upload.id, "processing");
	let files: UploadFileRow[] = [];
	let selectedPageCount = 0;
	try {
		files = await materializeUploadFiles(upload);
		if (files.length === 0) {
			await updateUploadStatus(upload.id, "needs_review", {
				reason: "no_pdf_candidates",
			});
			return { status: "needs_review", files: 0, selectedPages: 0 };
		}
		let provider = input.embeddingProvider ?? null;
		if (!provider && parseMode(upload.mode) !== "direct_llm") {
			provider = await createVoyageEmbeddingProvider().catch(() => null);
		}
		const prepared: PreparedPdf[] = [];
		const forceVoyageGate =
			parseMode(upload.mode) === "auto" &&
			upload.stored_path.toLowerCase().endsWith(".zip");
		for (const file of files) {
			prepared.push(
				await preparePdf({
					upload,
					file,
					provider: provider ?? undefined,
					forceVoyageGate,
				}),
			);
		}
		const selectedPages = prepared.flatMap((pdf) =>
			pdf.pages.filter((page) => page.selectedForLlm),
		);
		selectedPageCount = selectedPages.length;
		await writeSelectionDiagnostics(upload.id, prepared);
		if (selectedPages.length > MAX_SELECTED_LLM_PAGES) {
			await updateUploadStatus(upload.id, "needs_review", {
				reason: "selected_page_limit_exceeded",
				selectedPages: selectedPages.length,
			});
			return {
				status: "needs_review",
				files: files.length,
				selectedPages: selectedPages.length,
			};
		}
		const groups = buildPageGroups(prepared);
		const groupResults = [];
		const modelIds: string[] = [];
		for (const group of groups) {
			const result = await extractGroup(group);
			groupResults.push(result.parsed);
			modelIds.push(result.modelId);
			await getDb()
				.insertInto("finance_import_upload_extractions")
				.values({
					id: `finextract_${randomUUID()}`,
					upload_id: upload.id,
					model: result.modelId,
					prompt_version: FINANCE_UPLOAD_EXTRACT_PROMPT_VERSION,
					input_page_refs_json: jsonText(result.pageRefs),
					output_artifact_sha256: null,
					usage_json: result.usage ? jsonText(result.usage) : null,
					error_json: null,
					created_at: nowIso(),
				})
				.execute();
		}
		const mergedCall = await mergeExtractions(groupResults);
		modelIds.push(mergedCall.modelId);
		const merged = mergedCall.parsed;
		if (mergedCall.usedLlm) {
			await getDb()
				.insertInto("finance_import_upload_extractions")
				.values({
					id: `finextract_${randomUUID()}`,
					upload_id: upload.id,
					model: mergedCall.modelId,
					prompt_version: FINANCE_UPLOAD_MERGE_PROMPT_VERSION,
					input_page_refs_json: jsonText(
						groups.map((group) => group.map(pageRef)),
					),
					output_artifact_sha256: null,
					usage_json: mergedCall.usage ? jsonText(mergedCall.usage) : null,
					error_json: null,
					created_at: nowIso(),
				})
				.execute();
		}
		if (merged.documents.length === 0 && merged.transactions.length === 0) {
			await updateUploadStatus(upload.id, "needs_review", {
				reason: "no_finance_rows_extracted",
			});
			return {
				status: "needs_review",
				files: files.length,
				selectedPages: selectedPages.length,
			};
		}
		const artifact = buildArtifact({
			upload,
			extraction: merged,
			prepared,
			modelIds,
		});
		await writeArtifact(upload.id, artifact);
		await getDb()
			.updateTable("finance_import_upload_extractions")
			.set({ output_artifact_sha256: artifact.artifactSha256 })
			.where("upload_id", "=", upload.id)
			.execute();
		await getDb()
			.updateTable("finance_import_uploads")
			.set({
				status: "extracted",
				artifact_sha256: artifact.artifactSha256,
				error_json: "{}",
				updated_at: nowIso(),
			})
			.where("id", "=", upload.id)
			.execute();
		const importJobId = await queueArtifactImport({
			uploadId: upload.id,
			artifact,
		});
		return {
			status: "extracted",
			files: files.length,
			selectedPages: selectedPages.length,
			artifactSha256: artifact.artifactSha256,
			importJobId,
		};
	} catch (error) {
		if (error instanceof FinanceUploadNeedsReviewError) {
			await updateUploadStatus(upload.id, "needs_review", {
				reason: error.reason,
				...error.details,
			});
			return {
				status: "needs_review",
				files: files.length,
				selectedPages: selectedPageCount,
			};
		}
		await updateUploadStatus(upload.id, "failed", {
			message: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export function parseFinanceUploadError(row: { error_json: string }) {
	return safeJsonParse<Record<string, unknown>>(row.error_json, {});
}
