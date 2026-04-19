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
		createdAt?: string;
		payload?: Record<string, unknown>;
	};
}

declare module "#/public/client/core/shell-nav.js" {
	export function createShellNav(input?: {
		documentRef?: Document;
		windowRef?: Window;
		fetchImpl?: typeof fetch;
		onAfterSwap?: (page: string, nextUrl: string) => void | Promise<void>;
	}): {
		navigate(
			url: string | URL,
			options?: {
				replace?: boolean;
				history?: boolean;
				source?: "user" | "refresh" | "popstate" | "action";
			},
		): Promise<void>;
		refresh(): Promise<void>;
		scheduleRefresh(options?: {
			immediate?: boolean;
			debounceMs?: number;
			maxWaitMs?: number;
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
}

declare module "#/public/client/core/sync-provider.js" {
	export function createSyncProvider(input?: {
		basePath?: string;
		initialCursor?: number | string | null;
		eventSourceFactory?: (url: string) => EventSource;
	}): {
		subscribe(
			topic: string,
			handler: (event: {
				topic: string;
				entityKind?: string | null;
				entityId?: string | null;
				eventType?: string;
				createdAt?: string;
				payload?: Record<string, unknown>;
			}) => void,
		): () => void;
		mountTopics(topics: Iterable<unknown>): () => void;
		reconnect(): void;
		close(): void;
		setCursor(cursor: number | string | null | undefined): void;
	};
}
