/** @vitest-environment jsdom */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function mockRouteRuntime(
	loaderData: unknown,
	options?: {
		invalidate?: ReturnType<typeof vi.fn>;
		serverFnMap?: Map<unknown, ReturnType<typeof vi.fn>>;
	},
) {
	const invalidate = options?.invalidate ?? vi.fn(async () => undefined);
	const serverFnMap = options?.serverFnMap ?? new Map();

	vi.doMock("@tanstack/react-router", () => ({
		createFileRoute: () => (config: Record<string, unknown>) => ({
			...config,
			useLoaderData: () => loaderData,
		}),
		createRootRoute: (config: unknown) => config,
		redirect: (options: unknown) => options,
		Link: ({ children, to }: Record<string, unknown>) => (
			<a href={String(to ?? "#")}>{children as ReactNode}</a>
		),
		Outlet: () => <div data-testid="outlet" />,
		HeadContent: () => <title>head</title>,
		Scripts: () => null,
		useRouter: () => ({
			invalidate,
		}),
	}));

	vi.doMock("@tanstack/react-start", () => ({
		createServerFn: () => {
			const chain = {
				inputValidator: () => chain,
				middleware: () => chain,
				handler: (fn: unknown) => fn,
			};
			return chain;
		},
		useServerFn: (serverFn: unknown) =>
			serverFnMap.get(serverFn) ?? vi.fn(async () => undefined),
	}));

	vi.doMock("@tanstack/react-router-devtools", () => ({
		TanStackRouterDevtoolsPanel: () => (
			<div data-testid="router-devtools-panel" />
		),
	}));

	vi.doMock("@tanstack/react-devtools", () => ({
		TanStackDevtools: () => <div data-testid="tanstack-devtools" />,
	}));

	return {
		invalidate,
		serverFnMap,
	};
}

function renderRouteComponent(routeModule: { Route: unknown }) {
	const route = routeModule as { Route: { component?: unknown } };
	const Component = route.Route.component as (() => ReactNode) | undefined;
	if (!Component) {
		throw new Error("Route component missing");
	}
	return render(<Component />);
}

describe("route components", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doUnmock("#/app/server/actions");
		cleanup();
	});

	it("renders the root shell and navigation", async () => {
		mockRouteRuntime(null);
		const route = await import("#/app/routes/__root");
		const routeConfig = route.Route as unknown as {
			head?: () => {
				meta: Array<Record<string, string>>;
				links: Array<{ rel: string; href: string }>;
			};
		};

		expect(routeConfig.head?.().links[0]).toMatchObject({ rel: "stylesheet" });
		expect(routeConfig.head?.().meta[2]).toEqual({ title: "zmail" });
		render(<route.RootComponent />);

		expect(screen.getByText("zmail")).toBeTruthy();
		expect(screen.getByText("Accounts")).toBeTruthy();
		expect(screen.getByText("Finance")).toBeTruthy();
		expect(screen.getByTestId("outlet")).toBeTruthy();
	});

	it("renders a reset-required root error state", async () => {
		mockRouteRuntime(null);
		const route = await import("#/app/routes/__root");
		const ErrorComponent = (
			route.Route as unknown as {
				errorComponent: (input: { error: Error }) => ReactNode;
			}
		).errorComponent;
		const error = new Error(
			"This local database predates the rewritten zmail baseline and must be reset before continuing.",
		);
		error.name = "SchemaResetRequiredError";

		render(ErrorComponent({ error }));

		expect(screen.getByText("Local DB reset required")).toBeTruthy();
		expect(screen.getByText(/rewritten zmail baseline/)).toBeTruthy();
		expect(screen.getByText("pnpm db:reset:messages")).toBeTruthy();
		expect(screen.getByText("pnpm db:reset")).toBeTruthy();
		expect(screen.getByText("pnpm db:migrate")).toBeTruthy();
		expect(
			screen.getByText("Reconnect Gmail accounts if you used the full reset."),
		).toBeTruthy();
	});

	it("renders the generic root error state and falls back when the message is empty", async () => {
		mockRouteRuntime(null);
		const route = await import("#/app/routes/__root");
		const ErrorComponent = (
			route.Route as unknown as {
				errorComponent: (input: { error: Error }) => ReactNode;
			}
		).errorComponent;

		render(ErrorComponent({ error: new Error("Unexpected failure") }));
		expect(screen.getByText("Application error")).toBeTruthy();
		expect(screen.getByText("Unexpected failure")).toBeTruthy();

		cleanup();
		const emptyMessageError = new Error("");
		render(ErrorComponent({ error: emptyMessageError }));
		expect(
			screen.getByText("The application could not complete this request."),
		).toBeTruthy();

		cleanup();
		render(ErrorComponent({ error: "" as never }));
		expect(screen.getByText("Application error")).toBeTruthy();
	});

	it("renders the home route", async () => {
		const loaderData = {
			messages: 3,
			openReviews: 2,
			jobs: 4,
			accounts: 1,
		};
		mockRouteRuntime(loaderData);
		vi.doMock("#/app/server/actions", () => ({
			getHomeData: vi.fn(async () => loaderData),
		}));
		const route = await import("#/app/routes/index");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		expect(
			screen.getByText("Gmail live-sync analysis workspace."),
		).toBeTruthy();
		expect(screen.getByText("Connect Gmail")).toBeTruthy();
		expect(screen.getByText("3")).toBeTruthy();
	});

	it("renders the accounts route", async () => {
		const loaderData = {
			accounts: [
				{
					id: "account-1",
					label: "Personal Gmail",
					email_address: "user@example.com",
					provider_kind: "gmail",
					sync_enabled: 1,
					sync_status: "idle",
					last_synced_at: null,
					last_error: null,
					message_count: 12,
					tombstone_count: 2,
				},
				{
					id: "account-2",
					label: "Paused Gmail",
					email_address: "paused@example.com",
					provider_kind: "gmail",
					sync_enabled: 0,
					sync_status: "paused",
					last_synced_at: "2026-01-01",
					last_error: "oauth expired",
					message_count: 1,
					tombstone_count: 0,
				},
			],
		};

		mockRouteRuntime(loaderData);
		vi.doMock("#/app/server/actions", () => ({
			getAccountsData: vi.fn(async () => loaderData),
		}));
		const route = await import("#/app/routes/accounts.index");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		expect(
			screen.getByText("Connected email accounts and their sync status."),
		).toBeTruthy();
		expect(screen.getByText("Personal Gmail")).toBeTruthy();
		expect(screen.getByText("12")).toBeTruthy();
		expect(screen.getByText("disabled")).toBeTruthy();
		expect(screen.getByText("oauth expired")).toBeTruthy();
	});

	it("renders the accounts layout outlet", async () => {
		mockRouteRuntime(null);
		const route = await import("#/app/routes/accounts");
		renderRouteComponent(route);

		expect(screen.getByTestId("outlet")).toBeTruthy();
	});

	it("renders the account-new route and redirects to Google on connect", async () => {
		const beginGoogleConnect = Symbol("beginGoogleConnect");
		const startConnect = vi.fn(async () => ({
			url: "https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state",
			state: "oauth-state",
		}));

		vi.doMock("#/app/server/actions", () => ({
			getAccountNewData: vi.fn(),
			beginGoogleConnect,
		}));
		const fakeWindow = Object.create(window) as Window & typeof globalThis;
		Object.assign(fakeWindow, {
			document: window.document,
			location: {
				href: "http://localhost:3000/accounts/new",
			},
		});
		vi.stubGlobal("window", fakeWindow);

		const loaderData = {
			oauthReady: true,
			missingVars: [],
			redirectUrl: "http://127.0.0.1:3000/oauth/google/callback",
		};
		mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[beginGoogleConnect, startConnect],
			]),
		});

		const route = await import("#/app/routes/accounts.new");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		expect(
			screen.getByText(
				"Expected callback: http://127.0.0.1:3000/oauth/google/callback",
			),
		).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Account label"), {
			target: { value: "Personal Gmail" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

		await waitFor(() => {
			expect(startConnect).toHaveBeenCalledWith({
				data: { label: "Personal Gmail" },
			});
			expect(window.location.href).toBe(
				"https://accounts.google.com/o/oauth2/v2/auth?state=oauth-state",
			);
		});
	});

	it("renders account-new readiness fallbacks", async () => {
		const beginGoogleConnect = Symbol("beginGoogleConnect");

		vi.doMock("#/app/server/actions", () => ({
			getAccountNewData: vi.fn(),
			beginGoogleConnect,
		}));

		const loaderData = {
			oauthReady: false,
			missingVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
			redirectUrl: "http://127.0.0.1:3000/oauth/google/callback",
		};
		mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[beginGoogleConnect, vi.fn(async () => undefined)],
			]),
		});

		const route = await import("#/app/routes/accounts.new");
		renderRouteComponent(route);

		expect(screen.getByText("Missing environment variables:")).toBeTruthy();
		expect(
			screen.getAllByText("GOOGLE_OAUTH_CLIENT_ID").length,
		).toBeGreaterThan(0);
		expect(
			screen.getByText(
				"Expected callback: http://127.0.0.1:3000/oauth/google/callback",
			),
		).toBeTruthy();
		expect(screen.getByText(/mise run dev/)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Connect Gmail" }),
		).toHaveProperty("disabled", true);
	});

	it("surfaces account-new connect errors inline", async () => {
		const beginGoogleConnect = Symbol("beginGoogleConnect");
		const startConnect = vi.fn(async () => {
			throw new Error("oauth start failed");
		});

		vi.doMock("#/app/server/actions", () => ({
			getAccountNewData: vi.fn(),
			beginGoogleConnect,
		}));

		const loaderData = {
			oauthReady: true,
			missingVars: [],
			redirectUrl: "http://127.0.0.1:3000/oauth/google/callback",
		};
		mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[beginGoogleConnect, startConnect],
			]),
		});

		const route = await import("#/app/routes/accounts.new");
		renderRouteComponent(route);

		fireEvent.change(screen.getByLabelText("Account label"), {
			target: { value: "Work Gmail" },
		});

		fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

		await waitFor(() => {
			expect(screen.getByText("error: oauth start failed")).toBeTruthy();
		});
	});

	it("surfaces non-Error account-new connect failures inline", async () => {
		const beginGoogleConnect = Symbol("beginGoogleConnect");
		const startConnect = vi.fn(async () => {
			throw "oauth start failed as string";
		});

		vi.doMock("#/app/server/actions", () => ({
			getAccountNewData: vi.fn(),
			beginGoogleConnect,
		}));

		mockRouteRuntime(
			{
				oauthReady: true,
				missingVars: [],
				redirectUrl: "http://127.0.0.1:3000/oauth/google/callback",
			},
			{
				serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
					[beginGoogleConnect, startConnect],
				]),
			},
		);

		const route = await import("#/app/routes/accounts.new");
		renderRouteComponent(route);

		fireEvent.change(screen.getByLabelText("Account label"), {
			target: { value: "String Gmail" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

		await waitFor(() => {
			expect(
				screen.getByText("error: oauth start failed as string"),
			).toBeTruthy();
		});
	});

	it("renders the messages route", async () => {
		const getMessagesData = vi.fn(async () => []);
		vi.doMock("#/app/server/actions", () => ({
			getMessagesData,
		}));
		const loaderData = [
			{
				id: "message-1",
				received_at: "2026-01-01",
				conversation_id: "conversation-1",
				remote_thread_id: "170000000000000001999",
				body_extraction_strategy: "forwarded_split",
				parse_status: "error",
				has_forwarded: true,
				account_label: "Primary Gmail",
				sender_address: "billing@example.com",
				subject: "Receipt",
				primary_bucket: "finance",
				nsfw: 1,
				low_confidence: 1,
			},
			{
				id: "message-1b",
				received_at: "2026-01-02",
				conversation_id: "conversation-short",
				remote_thread_id: "thread-short",
				body_extraction_strategy: "plain_text",
				parse_status: "parsed",
				has_forwarded: false,
				account_label: "Primary Gmail",
				sender_address: "friend@example.com",
				subject: "Short thread",
				primary_bucket: "social",
				nsfw: 0,
				low_confidence: 0,
			},
		];
		mockRouteRuntime(loaderData);
		const route = await import("#/app/routes/messages.index");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		expect(getMessagesData).toHaveBeenCalled();
		expect(screen.getByText("Receipt")).toBeTruthy();
		expect(screen.getByText("1700000000...001999")).toBeTruthy();
		expect(screen.getByText("thread-short")).toBeTruthy();
		expect(screen.getByText("forwarded_split")).toBeTruthy();
		expect(screen.getByText("Forwarded")).toBeTruthy();
		expect(screen.getByText("Parse error")).toBeTruthy();
		expect(screen.getByText("NSFW")).toBeTruthy();
		expect(screen.getByText("Low confidence")).toBeTruthy();
	});

	it("renders message list fallbacks when label data is missing", async () => {
		const loaderData = [
			{
				id: "message-2",
				received_at: null,
				conversation_id: null,
				remote_thread_id: null,
				body_extraction_strategy: "plain_text",
				parse_status: "parsed",
				has_forwarded: false,
				account_label: "Primary Gmail",
				sender_address: null,
				subject: null,
				primary_bucket: null,
				nsfw: 0,
				low_confidence: 0,
			},
		];
		mockRouteRuntime(loaderData);
		const route = await import("#/app/routes/messages.index");
		renderRouteComponent(route);

		expect(screen.getAllByText("unknown")).toHaveLength(2);
		expect(screen.getByText("(no subject)")).toBeTruthy();
		expect(screen.getByText("unlabeled")).toBeTruthy();
		expect(screen.getByText("none")).toBeTruthy();
		expect(screen.getByText("plain_text")).toBeTruthy();
		expect(screen.queryByText("NSFW")).toBeNull();
		expect(screen.queryByText("Low confidence")).toBeNull();
	});

	it("renders the messages layout outlet", async () => {
		mockRouteRuntime(null);
		const route = await import("#/app/routes/messages");
		renderRouteComponent(route);

		expect(screen.getByTestId("outlet")).toBeTruthy();
	});

	it("renders message detail and classifies on click", async () => {
		const classifyOneNow = Symbol("classifyOneNow");
		const classifyNow = vi.fn(async () => undefined);
		vi.doMock("#/app/server/actions", () => ({
			getMessageDetailData: vi.fn(),
			classifyOneNow,
		}));

		const loaderData = {
			message: {
				id: "message-1",
				subject: "Receipt",
				account_label: "Primary Gmail",
				received_at: "2026-01-01",
				ingested_at: "2026-01-02",
				sender_address: "billing@example.com",
				body_text_primary: "primary body",
				body_text_forwarded: "forwarded body",
				body_text_normalized: "body",
				to: [],
				cc: [],
				in_reply_to: null,
				thread_key: "thread-1",
				conversation_id: "conversation-1",
				remote_thread_id: "170000000000000001",
				parse_status: "parsed",
				body_extraction_strategy: "forwarded_split",
				parse_error_reason: null,
				token_estimate: 3,
				content_sha256: "content-sha",
				raw_rfc822_path: "/tmp/raw.eml",
				raw_sha256: "raw-sha",
			},
			attachments: [],
			moderation: { nsfw_flag: 0 },
			classifications: [],
			currentLabel: { label: null },
			latestProfile: null,
			financeIntel: {
				head: {
					status: "ready",
					lowConfidence: 1,
					contentSha256: "content-sha",
					registrySha256: "registry-sha",
					updatedAt: "2026-01-03",
				},
				current: {
					id: "secondary-1",
					schemaVersion: "finance-intel.v1",
					model: "gpt-5.4-mini",
					promptVersion: "finance-intel-v1",
					source: "model",
					createdAt: "2026-01-03",
					result: {
						messageKind: "receipt",
					},
					rawResponse: { assistantText: "{}" },
					usage: { totalTokens: 10 },
				},
				history: [
					{
						id: "secondary-history-1",
						schemaVersion: "finance-intel.v1",
						model: "gpt-5.4-mini",
						promptVersion: "finance-intel-v1",
						source: "model",
						createdAt: "2026-01-02",
						result: { messageKind: "receipt" },
						rawResponse: { assistantText: "{}" },
						usage: { totalTokens: 8 },
					},
				],
				evidence: [
					{
						id: "finance-evidence-1",
						eventCandidateId: "event-1",
						documentCandidateId: "document-1",
						transactionIndex: 0,
						documentIndex: 0,
						eventCanonicalKey: "tx:1",
						eventStatus: "candidate",
						documentCanonicalKey: "doc:1",
						documentStatus: "candidate",
						evidenceJson: '{"type":"transaction"}',
					},
					{
						id: "finance-evidence-2",
						eventCandidateId: null,
						documentCandidateId: null,
						transactionIndex: null,
						documentIndex: null,
						eventCanonicalKey: null,
						eventStatus: null,
						documentCanonicalKey: null,
						documentStatus: null,
						evidenceJson: '{"type":"orphan"}',
					},
				],
			},
		};
		const runtime = mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[classifyOneNow, classifyNow],
			]),
		});

		const route = await import("#/app/routes/messages.$messageId");
		await (
			route.Route as unknown as {
				loader: (input: { params: { messageId: string } }) => Promise<unknown>;
			}
		).loader({
			params: {
				messageId: "message-1",
			},
		});
		renderRouteComponent(route);

		fireEvent.click(screen.getByRole("button", { name: "Classify now" }));

		await waitFor(() => {
			expect(classifyNow).toHaveBeenCalled();
			expect(runtime.invalidate).toHaveBeenCalled();
		});
		expect(screen.getByText("Primary body")).toBeTruthy();
		expect(screen.getByText("Forwarded body")).toBeTruthy();
		expect(screen.getByText("Classifier/search body")).toBeTruthy();
		expect(screen.getByText("Finance intel")).toBeTruthy();
		expect(screen.getByText("Low confidence")).toBeTruthy();
		expect(screen.getByText("Candidate links")).toBeTruthy();
		expect(screen.getByText("Finance-intel history")).toBeTruthy();
	});

	it("renders message detail fallbacks and classification history", async () => {
		const loaderData = {
			message: {
				id: "message-2",
				subject: null,
				account_label: "Primary Gmail",
				received_at: null,
				ingested_at: "2026-01-02",
				sender_address: null,
				body_text_primary: "",
				body_text_forwarded: "",
				body_text_normalized: "",
				to: [],
				cc: [],
				in_reply_to: null,
				thread_key: "thread-2",
				conversation_id: null,
				remote_thread_id: null,
				parse_status: "partial",
				body_extraction_strategy: "plain_text",
				parse_error_reason: "parser warning",
				token_estimate: 0,
				content_sha256: "content-sha",
				raw_rfc822_path: null,
				raw_sha256: null,
			},
			attachments: [],
			moderation: null,
			classifications: [
				{
					id: "classification-1",
					source: "model",
					model: "gpt-5.4-mini",
					created_at: "2026-01-01",
					result: { ok: true },
				},
			],
			currentLabel: null,
			latestProfile: null,
		};
		mockRouteRuntime(loaderData);
		const route = await import("#/app/routes/messages.$messageId");
		renderRouteComponent(route);

		expect(screen.getByText("(no subject)")).toBeTruthy();
		expect(screen.getByText("unknown date")).toBeTruthy();
		expect(screen.getByText("unknown sender")).toBeTruthy();
		expect(screen.getByText("Classification history")).toBeTruthy();
		expect(screen.getByText("gpt-5.4-mini")).toBeTruthy();
		expect(screen.getAllByText("(empty)").length).toBeGreaterThanOrEqual(2);
		expect(screen.getByText("Metadata")).toBeTruthy();
	});

	it("renders a finance-intel head without a current result", async () => {
		const loaderData = {
			message: {
				id: "message-3",
				subject: "Statement",
				account_label: "Primary Gmail",
				received_at: "2026-01-04",
				ingested_at: "2026-01-05",
				sender_address: "alerts@example.com",
				body_text_primary: "statement ready",
				body_text_forwarded: "",
				body_text_normalized: "statement ready",
				to: [],
				cc: [],
				in_reply_to: null,
				thread_key: "thread-3",
				conversation_id: "conversation-3",
				remote_thread_id: "thread-remote-3",
				parse_status: "parsed",
				body_extraction_strategy: "plain_text",
				parse_error_reason: null,
				token_estimate: 2,
				content_sha256: "content-sha-3",
				raw_rfc822_path: null,
				raw_sha256: null,
			},
			attachments: [],
			moderation: null,
			classifications: [],
			currentLabel: { label: null },
			latestProfile: null,
			financeIntel: {
				head: {
					status: "stale",
					lowConfidence: 0,
					contentSha256: "content-sha-3",
					registrySha256: "registry-sha-3",
					updatedAt: "2026-01-05",
				},
				current: null,
				history: [],
				evidence: [],
			},
		};
		mockRouteRuntime(loaderData);
		const route = await import("#/app/routes/messages.$messageId");
		renderRouteComponent(route);

		expect(
			screen.getByText(
				"No finance-intel result is stored for the current head.",
			),
		).toBeTruthy();
		expect(screen.queryByText("Candidate links")).toBeNull();
		expect(screen.queryByText("Finance-intel history")).toBeNull();
	});

	it("renders review route and accepts or overrides", async () => {
		const resolveReview = Symbol("resolveReview");
		const resolve = vi.fn(async () => undefined);
		vi.doMock("#/app/server/actions", () => ({
			getReviewData: vi.fn(),
			resolveReview,
		}));

		const loaderData = [
			{
				id: "review-1",
				subject: "Receipt",
				sender_address: "billing@example.com",
				snippet: "snippet",
				body_extraction_strategy: "forwarded_split",
				has_forwarded: true,
				parse_status: "error",
				parse_error_reason: "parse failure",
				result: { ok: true },
			},
		];
		const runtime = mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[resolveReview, resolve],
			]),
		});

		const route = await import("#/app/routes/review");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		expect(screen.getByText("forwarded_split")).toBeTruthy();
		expect(screen.getByText("Forwarded")).toBeTruthy();
		expect(screen.getByText("Parse error")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Accept" }));
		fireEvent.click(screen.getByRole("button", { name: "Override" }));

		await waitFor(() => {
			expect(resolve).toHaveBeenCalledTimes(2);
			expect(runtime.invalidate).toHaveBeenCalledTimes(2);
		});
	});

	it("renders review fallbacks, blocks invalid JSON, and updates override drafts", async () => {
		const resolveReview = Symbol("resolveReview");
		const resolve = vi.fn(async () => undefined);
		vi.doMock("#/app/server/actions", () => ({
			getReviewData: vi.fn(),
			resolveReview,
		}));

		const loaderData = [
			{
				id: "review-2",
				subject: null,
				sender_address: null,
				snippet: "snippet",
				body_extraction_strategy: "plain_text",
				has_forwarded: false,
				parse_status: "parsed",
				parse_error_reason: null,
				result: undefined,
			},
		];
		const runtime = mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[resolveReview, resolve],
			]),
		});

		const route = await import("#/app/routes/review");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		const textbox = screen.getByLabelText("Override JSON");
		fireEvent.click(screen.getByRole("button", { name: "Override" }));
		await waitFor(() => {
			expect(resolve).toHaveBeenCalledTimes(1);
			expect(runtime.invalidate).toHaveBeenCalledTimes(1);
		});

		fireEvent.change(textbox, {
			target: { value: '{"bad"' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Override" }));
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(
			screen.getByText("Override error: Override JSON must be valid JSON."),
		).toBeTruthy();
		fireEvent.change(textbox, {
			target: { value: '{"schemaVersion":"message-label.v1"}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Override" }));

		await waitFor(() => {
			expect(resolve).toHaveBeenCalledTimes(2);
			expect(runtime.invalidate).toHaveBeenCalledTimes(2);
		});
		expect(screen.getByText("(no subject)")).toBeTruthy();
		expect(screen.getByText("unknown sender")).toBeTruthy();
	});

	it("renders review override errors returned by the server action", async () => {
		const resolveReview = Symbol("resolveReview");
		const resolve = vi.fn(async () => {
			throw new Error("Invalid override shape");
		});
		vi.doMock("#/app/server/actions", () => ({
			getReviewData: vi.fn(),
			resolveReview,
		}));

		const loaderData = [
			{
				id: "review-3",
				subject: "Receipt",
				sender_address: "billing@example.com",
				snippet: "snippet",
				body_extraction_strategy: "plain_text",
				has_forwarded: false,
				parse_status: "parsed",
				parse_error_reason: null,
				result: { ok: true },
			},
		];
		const runtime = mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[resolveReview, resolve],
			]),
		});

		const route = await import("#/app/routes/review");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		fireEvent.click(screen.getByRole("button", { name: "Override" }));

		await waitFor(() => {
			expect(resolve).toHaveBeenCalledTimes(1);
		});
		expect(runtime.invalidate).not.toHaveBeenCalled();
		expect(
			screen.getByText("Override error: Invalid override shape"),
		).toBeTruthy();
	});

	it("renders review override errors thrown as non-Error values", async () => {
		const resolveReview = Symbol("resolveReview");
		const resolve = vi.fn(async () => {
			throw "Invalid override payload";
		});
		vi.doMock("#/app/server/actions", () => ({
			getReviewData: vi.fn(),
			resolveReview,
		}));

		const loaderData = [
			{
				id: "review-4",
				subject: "Receipt",
				sender_address: "billing@example.com",
				snippet: "snippet",
				body_extraction_strategy: "plain_text",
				has_forwarded: false,
				parse_status: "parsed",
				parse_error_reason: null,
				result: { ok: true },
			},
		];
		mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[resolveReview, resolve],
			]),
		});

		const route = await import("#/app/routes/review");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		fireEvent.click(screen.getByRole("button", { name: "Override" }));

		await waitFor(() => {
			expect(resolve).toHaveBeenCalledTimes(1);
		});
		expect(
			screen.getByText("Override error: Invalid override payload"),
		).toBeTruthy();
	});

	it("callback route redirects to the connected account on success", async () => {
		const completeGoogleConnect = vi.fn(async () => ({
			accountId: "account-1",
		}));

		vi.doMock("#/app/server/actions", () => ({
			completeGoogleConnect,
		}));

		mockRouteRuntime(null);
		const route = await import("#/app/routes/oauth.google.callback");
		const routeConfig = route.Route as unknown as {
			validateSearch: (search: unknown) => unknown;
			loaderDeps: (input: {
				search: { code: string; state: string };
			}) => unknown;
			component: () => ReactNode;
			loader: (input: {
				deps: { code: string; state: string };
			}) => Promise<unknown>;
		};

		expect(
			routeConfig.validateSearch({ code: "auth-code", state: "oauth-state" }),
		).toEqual({
			code: "auth-code",
			state: "oauth-state",
		});
		expect(
			routeConfig.loaderDeps({
				search: { code: "auth-code", state: "oauth-state" },
			}),
		).toEqual({
			code: "auth-code",
			state: "oauth-state",
		});
		render(<routeConfig.component />);
		expect(screen.getByText("Processing Gmail connection...")).toBeTruthy();

		await expect(
			routeConfig.loader({
				deps: {
					code: "auth-code",
					state: "oauth-state",
				},
			}),
		).rejects.toMatchObject({
			to: "/accounts/$accountId",
			params: {
				accountId: "account-1",
			},
		});
		expect(completeGoogleConnect).toHaveBeenCalledWith({
			data: {
				code: "auth-code",
				state: "oauth-state",
			},
		});
	});

	it("callback route renders a recovery error state", async () => {
		mockRouteRuntime(null);
		const route = await import("#/app/routes/oauth.google.callback");

		const ErrorComponent = (
			route.Route as unknown as {
				errorComponent: (input: { error: Error }) => ReactNode;
			}
		).errorComponent;

		render(ErrorComponent({ error: new Error("Invalid OAuth state") }));

		expect(screen.getByText("Gmail connection failed")).toBeTruthy();
		expect(screen.getByText("Invalid OAuth state")).toBeTruthy();
		expect(screen.getByText("Back to Connect Gmail")).toBeTruthy();

		cleanup();
		render(ErrorComponent({ error: "" as never }));
		expect(
			screen.getByText("The OAuth callback could not be completed."),
		).toBeTruthy();
	});

	it("renders the account detail route and dispatches account controls", async () => {
		const actions = {
			queueAccountFullSync: Symbol("queueAccountFullSync"),
			queueAccountDeltaSync: Symbol("queueAccountDeltaSync"),
			queueAccountReconcile: Symbol("queueAccountReconcile"),
			queueAccountClassifyBacklog: Symbol("queueAccountClassifyBacklog"),
			queueAccountFinanceBacklog: Symbol("queueAccountFinanceBacklog"),
			pauseAccountSync: Symbol("pauseAccountSync"),
			resumeAccountSync: Symbol("resumeAccountSync"),
			disconnectAccount: Symbol("disconnectAccount"),
		};
		const fullSync = vi.fn(async () => undefined);
		const deltaSync = vi.fn(async () => undefined);
		const reconcile = vi.fn(async () => undefined);
		const classifyBacklog = vi.fn(async () => undefined);
		const classifyFinanceBacklog = vi.fn(async () => undefined);
		const pause = vi.fn(async () => undefined);
		const resume = vi.fn(async () => undefined);
		const disconnect = vi.fn(async () => undefined);

		vi.doMock("#/app/server/actions", () => ({
			getAccountDetailData: vi.fn(),
			queueAccountFullSync: actions.queueAccountFullSync,
			queueAccountDeltaSync: actions.queueAccountDeltaSync,
			queueAccountReconcile: actions.queueAccountReconcile,
			queueAccountClassifyBacklog: actions.queueAccountClassifyBacklog,
			queueAccountFinanceBacklog: actions.queueAccountFinanceBacklog,
			pauseAccountSync: actions.pauseAccountSync,
			resumeAccountSync: actions.resumeAccountSync,
			disconnectAccount: actions.disconnectAccount,
		}));

		const loaderData = {
			account: {
				id: "account-1",
				label: "Personal Gmail",
				email_address: "user@example.com",
				provider_kind: "gmail",
				sync_enabled: 1,
				sync_status: "idle",
				selected_mailbox: "[Gmail]/All Mail",
				last_synced_at: "2026-01-01",
				last_error: "temporary imap error",
				created_at: "2026-01-01",
				updated_at: "2026-01-02",
			},
			syncState: {
				uidvalidity: 123,
				latest_uid_cursor: 456,
				earliest_uid_cursor: 207,
				backfill_snapshot_uid: 456,
				backfill_next_uid: 206,
				last_bootstrap_started_at: "2026-01-01",
				last_bootstrap_completed_at: "2026-01-01",
				last_delta_sync_at: "2026-01-02",
				last_reconcile_at: "2026-01-03",
				last_backfill_sync_at: "2026-01-03",
				backfill_completed_at: null,
				watcher_status: "idle",
				consecutive_failures: 2,
				backoff_until: "2026-01-04",
			},
			recentJobs: [
				{
					id: "job-1",
					kind: "sync_account_full",
					status: "complete",
					created_at: "2026-01-01",
					last_error: null,
				},
			],
			messageCount: 12,
			tombstoneCount: 3,
			financeCoverage: {
				rootFinanceRelevantCount: 4,
				totalHeads: 3,
				readyCount: 2,
				reviewCount: 1,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 2,
				documentCandidateCount: 1,
			},
		};
		const runtime = mockRouteRuntime(loaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[actions.queueAccountFullSync, fullSync],
				[actions.queueAccountDeltaSync, deltaSync],
				[actions.queueAccountReconcile, reconcile],
				[actions.queueAccountClassifyBacklog, classifyBacklog],
				[actions.queueAccountFinanceBacklog, classifyFinanceBacklog],
				[actions.pauseAccountSync, pause],
				[actions.resumeAccountSync, resume],
				[actions.disconnectAccount, disconnect],
			]),
		});

		const route = await import("#/app/routes/accounts.$accountId");
		await (
			route.Route as unknown as {
				loader: (input: { params: { accountId: string } }) => Promise<unknown>;
			}
		).loader({
			params: {
				accountId: "account-1",
			},
		});
		renderRouteComponent(route);

		for (const label of [
			"Full sync",
			"Delta sync",
			"Reconcile",
			"Classify backlog",
			"Classify finance backlog",
			"Pause",
			"Resume",
			"Disconnect",
		]) {
			fireEvent.click(screen.getByRole("button", { name: label }));
		}

		await waitFor(() => {
			expect(fullSync).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(deltaSync).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(reconcile).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(classifyBacklog).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(classifyFinanceBacklog).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(pause).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(resume).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(disconnect).toHaveBeenCalledWith({
				data: { accountId: "account-1" },
			});
			expect(runtime.invalidate).toHaveBeenCalledTimes(8);
		});

		expect(
			screen.getByText(
				(_, element) =>
					element?.textContent === "Last error: temporary imap error",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("link", {
				name: "Open overseer",
			}),
		).toBeTruthy();
		expect(
			screen.getByText(
				(_, element) => element?.textContent === "Backoff until: 2026-01-04",
			),
		).toBeTruthy();
		expect(screen.getByText("12")).toBeTruthy();
		expect(screen.getByText("Tombstones")).toBeTruthy();
		expect(screen.getByText("Finance intel heads")).toBeTruthy();
	});

	it("renders account detail fallbacks without sync state or recent jobs", async () => {
		const actions = {
			queueAccountFullSync: Symbol("queueAccountFullSync"),
			queueAccountDeltaSync: Symbol("queueAccountDeltaSync"),
			queueAccountReconcile: Symbol("queueAccountReconcile"),
			queueAccountClassifyBacklog: Symbol("queueAccountClassifyBacklog"),
			queueAccountFinanceBacklog: Symbol("queueAccountFinanceBacklog"),
			pauseAccountSync: Symbol("pauseAccountSync"),
			resumeAccountSync: Symbol("resumeAccountSync"),
			disconnectAccount: Symbol("disconnectAccount"),
		};

		vi.doMock("#/app/server/actions", () => ({
			getAccountDetailData: vi.fn(),
			queueAccountFullSync: actions.queueAccountFullSync,
			queueAccountDeltaSync: actions.queueAccountDeltaSync,
			queueAccountReconcile: actions.queueAccountReconcile,
			queueAccountClassifyBacklog: actions.queueAccountClassifyBacklog,
			queueAccountFinanceBacklog: actions.queueAccountFinanceBacklog,
			pauseAccountSync: actions.pauseAccountSync,
			resumeAccountSync: actions.resumeAccountSync,
			disconnectAccount: actions.disconnectAccount,
		}));

		mockRouteRuntime({
			account: {
				id: "account-2",
				label: "Paused Gmail",
				email_address: "paused@example.com",
				provider_kind: "gmail",
				sync_enabled: 0,
				sync_status: "paused",
				selected_mailbox: "[Gmail]/All Mail",
				last_synced_at: null,
				last_error: null,
				created_at: "2026-01-01",
				updated_at: "2026-01-02",
			},
			syncState: null,
			recentJobs: [],
			messageCount: 0,
			tombstoneCount: 0,
			financeCoverage: {
				rootFinanceRelevantCount: 0,
				totalHeads: 0,
				readyCount: 0,
				reviewCount: 0,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 0,
				documentCandidateCount: 0,
			},
		});

		const route = await import("#/app/routes/accounts.$accountId");
		renderRouteComponent(route);

		expect(screen.getByText("sync: disabled")).toBeTruthy();
		expect(screen.getByText("Last synced: never")).toBeTruthy();
		expect(screen.getByText("No recent jobs.")).toBeTruthy();
		expect(screen.queryByText(/Last error:/)).toBeNull();
		expect(screen.queryByText("Cursor state")).toBeNull();
	});

	it("renders account detail cursor fallbacks when sync values are unknown", async () => {
		const actions = {
			queueAccountFullSync: Symbol("queueAccountFullSync"),
			queueAccountDeltaSync: Symbol("queueAccountDeltaSync"),
			queueAccountReconcile: Symbol("queueAccountReconcile"),
			queueAccountClassifyBacklog: Symbol("queueAccountClassifyBacklog"),
			queueAccountFinanceBacklog: Symbol("queueAccountFinanceBacklog"),
			pauseAccountSync: Symbol("pauseAccountSync"),
			resumeAccountSync: Symbol("resumeAccountSync"),
			disconnectAccount: Symbol("disconnectAccount"),
		};

		vi.doMock("#/app/server/actions", () => ({
			getAccountDetailData: vi.fn(),
			queueAccountFullSync: actions.queueAccountFullSync,
			queueAccountDeltaSync: actions.queueAccountDeltaSync,
			queueAccountReconcile: actions.queueAccountReconcile,
			queueAccountClassifyBacklog: actions.queueAccountClassifyBacklog,
			queueAccountFinanceBacklog: actions.queueAccountFinanceBacklog,
			pauseAccountSync: actions.pauseAccountSync,
			resumeAccountSync: actions.resumeAccountSync,
			disconnectAccount: actions.disconnectAccount,
		}));

		mockRouteRuntime({
			account: {
				id: "account-3",
				label: "Unknown Gmail",
				email_address: "unknown@example.com",
				provider_kind: "gmail",
				sync_enabled: 1,
				sync_status: "idle",
				selected_mailbox: "[Gmail]/All Mail",
				last_synced_at: null,
				last_error: null,
				created_at: "2026-01-01",
				updated_at: "2026-01-02",
			},
			syncState: {
				uidvalidity: null,
				latest_uid_cursor: null,
				earliest_uid_cursor: null,
				backfill_snapshot_uid: null,
				backfill_next_uid: null,
				last_bootstrap_started_at: null,
				last_bootstrap_completed_at: null,
				last_delta_sync_at: null,
				last_reconcile_at: null,
				last_backfill_sync_at: null,
				backfill_completed_at: null,
				watcher_status: "stopped",
				consecutive_failures: 0,
				backoff_until: null,
			},
			recentJobs: [],
			messageCount: 0,
			tombstoneCount: 0,
			financeCoverage: {
				rootFinanceRelevantCount: 0,
				totalHeads: 0,
				readyCount: 0,
				reviewCount: 0,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 0,
				documentCandidateCount: 0,
			},
		});

		const route = await import("#/app/routes/accounts.$accountId");
		renderRouteComponent(route);

		expect(screen.getByText("uidvalidity: unknown")).toBeTruthy();
		expect(screen.getByText("latest uid: unknown")).toBeTruthy();
		expect(screen.getByText("earliest uid: unknown")).toBeTruthy();
		expect(screen.getByText("backfill next: complete")).toBeTruthy();
		expect(
			screen.getByText(
				(_, element) => element?.textContent === "Bootstrap started: never",
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				(_, element) => element?.textContent === "Bootstrap completed: never",
			),
		).toBeTruthy();
		expect(screen.getByText("Delta sync: never")).toBeTruthy();
		expect(screen.getByText("Reconcile: never")).toBeTruthy();
		expect(screen.getByText("Backfill sync: never")).toBeTruthy();
		expect(screen.getByText("Backfill completed: never")).toBeTruthy();
		expect(
			screen.queryByText(
				(_, element) =>
					element?.textContent?.startsWith("Backoff until:") ?? false,
			),
		).toBeNull();
	});

	it("renders runs route and profile route", async () => {
		const runsLoaderData = {
			jobs: [
				{
					id: "job-1",
					kind: "classify_account_backlog",
					status: "complete",
					scope_type: "account",
					scope_id: "acct-1",
					model: "gpt-5.4-mini",
					request_count: 3,
					success_count: 3,
					error_count: 0,
					last_error: null,
					meta_json: JSON.stringify({
						processed: 3,
						total: 3,
						backendUsed: "openai-subscription",
					}),
				},
			],
			runtime: {
				preferredBackend: "auto",
				resolvedBackend: "openai-subscription",
			},
		};
		mockRouteRuntime(runsLoaderData);
		vi.doMock("#/app/server/actions", () => ({
			getRunsData: vi.fn(async () => runsLoaderData),
		}));
		const runsRoute = await import("#/app/routes/runs");
		await (
			runsRoute.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(runsRoute);

		expect(screen.getByText("classify_account_backlog")).toBeTruthy();
		expect(screen.getByText(/backend: openai-subscription/)).toBeTruthy();

		vi.resetModules();

		const enqueueOverseer = Symbol("enqueueOverseer");
		const queue = vi.fn(async () => undefined);
		vi.doMock("#/app/server/actions", () => ({
			getProfileData: vi.fn(),
			enqueueOverseer,
		}));

		const profileLoaderData = {
			account: {
				id: "acct-1",
				label: "Personal Gmail",
				email_address: "you@example.com",
			},
			financeCoverage: {
				rootFinanceRelevantCount: 2,
				totalHeads: 2,
				readyCount: 1,
				reviewCount: 1,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 1,
				documentCandidateCount: 1,
			},
			profiles: [
				{
					id: "profile-1",
					created_at: "2026-01-01",
					built_from_messages: 3,
					profile: { promptPreamble: "known sender" },
				},
			],
		};
		const runtime = mockRouteRuntime(profileLoaderData, {
			serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
				[enqueueOverseer, queue],
			]),
		});

		const profileRoute = await import("#/app/routes/profiles.$accountId");
		await (
			profileRoute.Route as unknown as {
				loader: (input: { params: { accountId: string } }) => Promise<unknown>;
			}
		).loader({
			params: {
				accountId: "acct-1",
			},
		});
		renderRouteComponent(profileRoute);

		fireEvent.click(
			screen.getByRole("button", { name: "Queue overseer rebuild" }),
		);

		await waitFor(() => {
			expect(queue).toHaveBeenCalledWith({
				data: {
					accountId: "acct-1",
				},
			});
			expect(runtime.invalidate).toHaveBeenCalled();
		});
		expect(
			screen.getByRole("heading", { name: "Personal Gmail" }),
		).toBeTruthy();
	});

	it("renders the profile empty state", async () => {
		const enqueueOverseer = Symbol("enqueueOverseer");
		vi.doMock("#/app/server/actions", () => ({
			getProfileData: vi.fn(),
			enqueueOverseer,
		}));

		mockRouteRuntime({
			account: {
				id: "acct-empty",
				label: "Empty Gmail",
				email_address: "empty@example.com",
			},
			financeCoverage: {
				rootFinanceRelevantCount: 0,
				totalHeads: 0,
				readyCount: 0,
				reviewCount: 0,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 0,
				documentCandidateCount: 0,
			},
			profiles: [],
		});

		const profileRoute = await import("#/app/routes/profiles.$accountId");
		await (
			profileRoute.Route as unknown as {
				loader: (input: { params: { accountId: string } }) => Promise<unknown>;
			}
		).loader({
			params: {
				accountId: "acct-empty",
			},
		});
		renderRouteComponent(profileRoute);

		expect(screen.getByText("No overseer profile yet")).toBeTruthy();
		expect(
			screen.getByText(
				"Queue a rebuild to generate the first profile for this account.",
			),
		).toBeTruthy();
	});

	it("renders the finance route and dispatches finance actions", async () => {
		const queueImportOperatorRegistry = Symbol("queueImportOperatorRegistry");
		const queueRebuildFinanceKnowledge = Symbol("queueRebuildFinanceKnowledge");
		const queueRebuildFinanceRollups = Symbol("queueRebuildFinanceRollups");
		const queueReconcileRegistrySuggestions = Symbol(
			"queueReconcileRegistrySuggestions",
		);
		const importRegistry = vi.fn(async () => undefined);
		const rebuildKnowledge = vi.fn(async () => undefined);
		const rebuildRollups = vi.fn(async () => undefined);
		const reconcileSuggestions = vi.fn(async () => undefined);

		vi.doMock("#/app/server/actions", () => ({
			getFinanceData: vi.fn(),
			queueImportOperatorRegistry,
			queueRebuildFinanceKnowledge,
			queueRebuildFinanceRollups,
			queueReconcileRegistrySuggestions,
		}));

		const runtime = mockRouteRuntime(
			{
				registry: {
					sha256: "registry-sha",
					importedAt: "2026-01-01",
					sourceDir: "/tmp/registry",
					counts: {
						identities: 1,
						institutions: 1,
						financialAccounts: 1,
						senderRules: 1,
					},
				},
				coverage: {
					rootFinanceRelevantCount: 3,
					totalHeads: 2,
					readyCount: 1,
					reviewCount: 1,
					staleCount: 0,
					blockedParseErrorCount: 0,
					eventCandidateCount: 1,
					documentCandidateCount: 1,
				},
				eventCandidates: [
					{
						id: "event-1",
						canonicalKey: "tx:1",
						status: "candidate",
						eventKind: "card_charge",
						direction: "expense",
						amountValue: "42.00",
						currency: "USD",
						occurredAt: "2026-01-09",
						merchantOrCounterparty: "Acme Software",
						ownerIdentityId: null,
						financialAccountId: null,
						institutionId: null,
						categoryHint: "software",
						taxRelevanceHint: "business expense",
						evidenceCount: 1,
						firstMessageReceivedAt: "2026-01-10",
						lastMessageReceivedAt: "2026-01-10",
						updatedAt: "2026-01-10",
						evidence: [
							{
								id: "evidence-1",
								messageId: "message-1",
								accountLabel: "Work",
								subject: "Receipt",
								receivedAt: "2026-01-10",
								transactionIndex: 0,
								documentIndex: null,
							},
						],
					},
				],
				documentCandidates: [
					{
						id: "document-1",
						canonicalKey: "doc:1",
						status: "candidate",
						documentType: "receipt",
						issuer: "Acme Software",
						externalId: "receipt-123",
						statementPeriodStart: null,
						statementPeriodEnd: null,
						dueAt: null,
						taxYear: 2026,
						ownerIdentityId: null,
						financialAccountId: null,
						institutionId: null,
						evidenceCount: 1,
						firstMessageReceivedAt: "2026-01-10",
						lastMessageReceivedAt: "2026-01-10",
						updatedAt: "2026-01-10",
						evidence: [
							{
								id: "evidence-2",
								messageId: "message-1",
								accountLabel: "Work",
								subject: "Receipt",
								receivedAt: "2026-01-10",
								transactionIndex: null,
								documentIndex: 0,
							},
						],
					},
				],
			},
			{
				serverFnMap: new Map<unknown, ReturnType<typeof vi.fn>>([
					[queueImportOperatorRegistry, importRegistry],
					[queueRebuildFinanceKnowledge, rebuildKnowledge],
					[queueRebuildFinanceRollups, rebuildRollups],
					[queueReconcileRegistrySuggestions, reconcileSuggestions],
				]),
			},
		);

		const route = await import("#/app/routes/finance");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		fireEvent.click(screen.getByRole("button", { name: "Import registry" }));
		fireEvent.click(screen.getByRole("button", { name: "Rebuild knowledge" }));

		await waitFor(() => {
			expect(importRegistry).toHaveBeenCalled();
			expect(rebuildKnowledge).toHaveBeenCalled();
			expect(runtime.invalidate).toHaveBeenCalledTimes(2);
		});

		expect(screen.getByText("Finance knowledge")).toBeTruthy();
		expect(screen.getAllByText("Acme Software").length).toBeGreaterThan(0);
		expect(screen.getByText("card_charge")).toBeTruthy();
		expect(screen.getByText("receipt")).toBeTruthy();
	});

	it("renders finance route empty states and event fallbacks", async () => {
		const queueImportOperatorRegistry = Symbol("queueImportOperatorRegistry");
		const queueRebuildFinanceKnowledge = Symbol("queueRebuildFinanceKnowledge");
		const queueRebuildFinanceRollups = Symbol("queueRebuildFinanceRollups");
		const queueReconcileRegistrySuggestions = Symbol(
			"queueReconcileRegistrySuggestions",
		);

		vi.doMock("#/app/server/actions", () => ({
			getFinanceData: vi.fn(),
			queueImportOperatorRegistry,
			queueRebuildFinanceKnowledge,
			queueRebuildFinanceRollups,
			queueReconcileRegistrySuggestions,
		}));

		mockRouteRuntime({
			registry: {
				sha256: null,
				importedAt: null,
				sourceDir: "/tmp/registry",
				counts: {
					identities: 0,
					institutions: 0,
					financialAccounts: 0,
					senderRules: 0,
				},
			},
			coverage: {
				rootFinanceRelevantCount: 0,
				totalHeads: 0,
				readyCount: 0,
				reviewCount: 0,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 0,
				documentCandidateCount: 0,
			},
			eventCandidates: [
				{
					id: "event-fallback",
					canonicalKey: "tx:fallback",
					status: "candidate",
					eventKind: "bank_fee",
					direction: null,
					amountValue: null,
					currency: null,
					occurredAt: null,
					merchantOrCounterparty: null,
					ownerIdentityId: null,
					financialAccountId: null,
					institutionId: null,
					categoryHint: null,
					taxRelevanceHint: null,
					evidenceCount: 1,
					firstMessageReceivedAt: null,
					lastMessageReceivedAt: null,
					updatedAt: "2026-01-10",
					evidence: [
						{
							id: "event-evidence-fallback",
							messageId: "message-fallback",
							accountLabel: "Work",
							subject: null,
							receivedAt: null,
							transactionIndex: 0,
							documentIndex: null,
						},
					],
				},
			],
			documentCandidates: [
				{
					id: "document-fallback",
					canonicalKey: "doc:fallback",
					status: "candidate",
					documentType: "statement",
					issuer: null,
					externalId: null,
					statementPeriodStart: null,
					statementPeriodEnd: null,
					dueAt: null,
					taxYear: null,
					ownerIdentityId: null,
					financialAccountId: null,
					institutionId: null,
					evidenceCount: 1,
					firstMessageReceivedAt: null,
					lastMessageReceivedAt: null,
					updatedAt: "2026-01-10",
					evidence: [
						{
							id: "document-evidence-fallback",
							messageId: "message-fallback",
							accountLabel: "Work",
							subject: null,
							receivedAt: null,
							transactionIndex: null,
							documentIndex: 0,
						},
					],
				},
			],
		});

		const route = await import("#/app/routes/finance");
		renderRouteComponent(route);

		expect(screen.getByText("registry imported: never")).toBeTruthy();
		expect(screen.getByText("Registry sha: none")).toBeTruthy();
		expect(screen.getByText("No yearly rollups yet.")).toBeTruthy();
		expect(screen.getByText("No subcategory rollups yet.")).toBeTruthy();
		expect(
			screen.getByText("No ledger entries for this selection."),
		).toBeTruthy();
		expect(
			screen.getByText("No imported documents for this year."),
		).toBeTruthy();
		expect(screen.getByText("unknown")).toBeTruthy();
		expect(screen.getByText("unknown issuer")).toBeTruthy();
		expect(screen.getByText("no external id")).toBeTruthy();
	});

	it("renders the finance route when no candidates exist yet", async () => {
		const queueImportOperatorRegistry = Symbol("queueImportOperatorRegistry");
		const queueRebuildFinanceKnowledge = Symbol("queueRebuildFinanceKnowledge");
		const queueRebuildFinanceRollups = Symbol("queueRebuildFinanceRollups");
		const queueReconcileRegistrySuggestions = Symbol(
			"queueReconcileRegistrySuggestions",
		);

		vi.doMock("#/app/server/actions", () => ({
			getFinanceData: vi.fn(),
			queueImportOperatorRegistry,
			queueRebuildFinanceKnowledge,
			queueRebuildFinanceRollups,
			queueReconcileRegistrySuggestions,
		}));

		mockRouteRuntime({
			registry: {
				sha256: null,
				importedAt: null,
				sourceDir: "/tmp/registry",
				counts: {
					identities: 0,
					institutions: 0,
					financialAccounts: 0,
					senderRules: 0,
				},
			},
			coverage: {
				rootFinanceRelevantCount: 0,
				totalHeads: 0,
				readyCount: 0,
				reviewCount: 0,
				staleCount: 0,
				blockedParseErrorCount: 0,
				eventCandidateCount: 0,
				documentCandidateCount: 0,
			},
			eventCandidates: [],
			documentCandidates: [],
		});

		const route = await import("#/app/routes/finance");
		renderRouteComponent(route);

		expect(screen.getByText("No materialized event candidates.")).toBeTruthy();
		expect(
			screen.getByText("No materialized document candidates."),
		).toBeTruthy();
	});

	it("renders runs fallbacks when runtime meta is missing", async () => {
		const loaderData = {
			jobs: [
				{
					id: "job-2",
					kind: "sync_account_delta",
					status: "queued",
					scope_type: "account",
					scope_id: "acct-2",
					model: null,
					request_count: 0,
					success_count: 0,
					error_count: 0,
					last_error: null,
					meta_json: null,
				},
			],
			runtime: {
				preferredBackend: "auto",
				resolvedBackend: null,
			},
		};
		mockRouteRuntime(loaderData);
		vi.doMock("#/app/server/actions", () => ({
			getRunsData: vi.fn(async () => loaderData),
		}));
		const route = await import("#/app/routes/runs");
		await (
			route.Route as unknown as { loader: () => Promise<unknown> }
		).loader();
		renderRouteComponent(route);

		expect(screen.getByText("resolved: unavailable")).toBeTruthy();
		expect(screen.getByText("n/a")).toBeTruthy();
		expect(screen.getByText("processed: 0/0")).toBeTruthy();
		expect(screen.getByText("backend: n/a")).toBeTruthy();
	});
});
