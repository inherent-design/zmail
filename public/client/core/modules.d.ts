type RuntimeEvent = {
	topic: string;
	entityKind?: string | null;
	entityId?: string | null;
	eventType?: string;
	createdAt?: string;
	payload?: Record<string, unknown>;
};

type RefreshSource = "sse" | "action" | "navigation";
type IslandFallback = "none" | "main";

type IslandStatePolicy = {
	semanticUrlKeys: string[];
	sessionKeys: string[];
	ephemeralKeys: string[];
	restoreOnSwap: boolean;
	shareable: "none" | "committed" | "live";
};

type IslandDefinition = {
	id: string;
	page: string;
	mode: "server" | "client" | "dynamic-root";
	fragmentUrl: string;
	topics: string[];
	statePolicy: IslandStatePolicy;
	fallback: IslandFallback;
};

type IslandApp = {
	basePath: string;
	appPath(path: string): string;
	subscribe(topic: string, handler: (event: RuntimeEvent) => void): () => void;
	postJson(path: string, payload?: unknown): Promise<unknown>;
	refresh(options?: {
		islands?: string | string[];
		originPage?: string;
		originUrl?: string;
		fallback?: IslandFallback;
		source?: RefreshSource;
	}): Promise<void>;
	refreshIsland(
		ids: string | string[],
		options?: {
			originPage?: string;
			originUrl?: string;
			fallback?: IslandFallback;
			source?: RefreshSource;
		},
	): Promise<void>;
	scheduleRefresh(options?: {
		immediate?: boolean;
		debounceMs?: number;
		maxWaitMs?: number;
		islands?: string | string[];
		originPage?: string;
		originUrl?: string;
		fallback?: IslandFallback;
		source?: RefreshSource;
	}): Promise<void>;
	navigate(url: string | URL, options?: unknown): Promise<void>;
	currentPage(): string | null;
	currentPathname(): string;
	islandsForEvent(event: RuntimeEvent): string[];
};

type IslandContext = {
	app: IslandApp;
	id: string;
	root: Element;
	props: unknown;
	state: unknown;
};

type IslandCleanup = () => void;
// biome-ignore lint/suspicious/noConfusingVoidType: Island init matches browser module contract.
type IslandInitResult = void | IslandCleanup;

type IslandModule = {
	init(ctx: IslandContext): IslandInitResult | Promise<IslandInitResult>;
	beforeSwap?(): unknown;
	afterSwap?(state: unknown): void | Promise<void>;
	shouldRefresh?(event: RuntimeEvent): boolean;
};

declare module "#/public/client/core/realtime.js" {
	export const SSE_EVENTS: string[];
	export function normalizeTopics(topics: Iterable<unknown>): string[];
	export function buildEventsUrl(input: {
		topics: Iterable<unknown>;
		cursor?: number | string | null;
		basePath?: string;
	}): string;
	export function parseEventPayload(raw: string): {
		topic: string;
		entityKind?: string | null;
		entityId?: string | null;
		eventType?: string;
		createdAt?: string;
		payload?: Record<string, unknown>;
	};
}

declare module "#/public/client/core/island-registry.js" {
	export type {
		IslandApp,
		IslandContext,
		IslandDefinition,
		IslandFallback,
		IslandModule,
		IslandStatePolicy,
		RefreshSource,
		RuntimeEvent,
	};
	export function captureGenericState(root: Element): unknown;
	export function createIslandRegistry(
		loaders: Record<string, () => Promise<unknown>>,
	): {
		mount(page: string, app: unknown): Promise<void>;
		beforeIslandSwap(id: string, root: Element): unknown;
		afterIslandSwap(
			id: string,
			root: Element,
			state: unknown,
			app: unknown,
		): Promise<void>;
		islandsForEvent(event: RuntimeEvent): string[];
		cleanup(): void;
		currentPage(): string | null;
	};
	export function restoreGenericState(root: Element, state: unknown): void;
}

declare module "#/public/client/core/shell-nav.js" {
	export function createShellNav(input?: {
		documentRef?: Document;
		windowRef?: Window;
		fetchImpl?: typeof fetch;
		onAfterSwap?: (page: string, nextUrl: string) => void | Promise<void>;
		onBeforeIslandSwap?: (id: string, root: Element) => unknown;
		onAfterIslandSwap?: (
			id: string,
			root: Element,
			state: unknown,
		) => void | Promise<void>;
	}): {
		navigate(
			url: string | URL,
			options?: {
				replace?: boolean;
				history?: boolean;
				source?: "user" | "refresh" | "popstate" | "action" | "navigation";
			},
		): Promise<void>;
		refresh(options?: {
			islands?: string | string[];
			originPage?: string;
			originUrl?: string;
			fallback?: IslandFallback;
			source?: RefreshSource;
		}): Promise<void>;
		refreshIsland(
			ids: string | string[],
			options?: {
				originPage?: string;
				originUrl?: string;
				fallback?: IslandFallback;
				source?: RefreshSource;
			},
		): Promise<void>;
		scheduleRefresh(options?: {
			immediate?: boolean;
			debounceMs?: number;
			maxWaitMs?: number;
			islands?: string | string[];
			originPage?: string;
			originUrl?: string;
			fallback?: IslandFallback;
			source?: RefreshSource;
		}): Promise<void>;
		bindLinkClicks(): () => void;
		bindPopState(): () => void;
		bindPrefetch(): () => void;
		currentMain(): HTMLElement | null;
	};
	export function extractPartialMain(
		html: string,
		parser?: DOMParser,
	): HTMLElement | null;
	export function extractIslandFragments(
		html: string,
		parser?: DOMParser,
	): { envelope: Element | null; roots: Map<string, Element> };
}

declare module "#/public/client/core/sync-provider.js" {
	export function createSyncProvider(input?: {
		basePath?: string;
		initialCursor?: number | string | null;
		eventSourceFactory?: (url: string) => EventSource;
	}): {
		subscribe(
			topic: string,
			handler: (event: RuntimeEvent) => void,
		): () => void;
		mountTopics(topics: Iterable<unknown>): () => void;
		reconnect(): void;
		close(): void;
		setCursor(cursor: number | string | null | undefined): void;
	};
}

declare module "#/public/client/pages/account-detail.js" {
	import type { RuntimeEvent } from "#/public/client/core/island-registry.js";

	export function accountDetailIslandHints(
		event: RuntimeEvent,
		accountId: string,
	): string[];
	export function init(app: unknown): null | (() => void);
}

declare module "#/public/client/pages/accounts.js" {
	import type { RuntimeEvent } from "#/public/client/core/island-registry.js";

	export function accountsIslandHints(event: RuntimeEvent): string[];
	export function init(app: unknown): null | (() => void);
}

declare module "#/public/client/pages/finance.js" {
	import type { RuntimeEvent } from "#/public/client/core/island-registry.js";

	export function activeFinanceTabIsland(tab?: string): string;
	export function financeIslandHints(
		event: RuntimeEvent,
		tab?: string,
	): string[];
	export function actionRefreshIslands(target: Element, tab?: string): string[];
	export function init(app: unknown): null | (() => void);
}

declare module "#/public/client/pages/message-detail.js" {
	import type { RuntimeEvent } from "#/public/client/core/island-registry.js";

	export function messageDetailIslandHints(event: RuntimeEvent): string[];
	export function init(app: unknown): null | (() => void);
}

declare module "#/public/client/pages/profiles.js" {
	import type { RuntimeEvent } from "#/public/client/core/island-registry.js";

	export function profileIslandHints(
		event: RuntimeEvent,
		accountId: string,
	): string[];
	export function init(app: unknown): null | (() => void);
}

declare module "#/public/client/pages/review.js" {
	import type { RuntimeEvent } from "#/public/client/core/island-registry.js";

	export function reviewIslandHints(event: RuntimeEvent): string[];
	export function init(app: unknown): null | (() => void);
}
