import { createIslandRegistry } from "./core/island-registry.js";
import { createRpcClient } from "./core/rpc-client.js";
import { createShellNav } from "./core/shell-nav.js";
import { createSyncProvider } from "./core/sync-provider.js";

function readBasePath() {
	return document.documentElement.dataset.zmailBasePath || "/";
}

function readEventCursor() {
	return document.documentElement.dataset.zmailEventCursor || null;
}

function appPath(basePath, path) {
	if (/^https?:\/\//i.test(path)) {
		return path;
	}
	if (!path.startsWith("/")) {
		throw new Error(`appPath requires an absolute path: ${path}`);
	}
	return basePath === "/"
		? path
		: path === "/"
			? basePath
			: `${basePath}${path}`;
}

function currentPathname(basePath, windowRef = window) {
	const pathname = windowRef.location.pathname;
	if (basePath === "/") {
		return pathname;
	}
	if (pathname === basePath) {
		return "/";
	}
	if (pathname.startsWith(`${basePath}/`)) {
		return pathname.slice(basePath.length) || "/";
	}
	return pathname;
}

const basePath = readBasePath();

const pageRegistry = createIslandRegistry({
	accounts: () => import("./pages/accounts.js"),
	"account-detail": () => import("./pages/account-detail.js"),
	"account-form": () => import("./pages/account-form.js"),
	"account-delete": () => import("./pages/account-delete.js"),
	messages: () => Promise.resolve({ init() {} }),
	"message-detail": () => import("./pages/message-detail.js"),
	review: () => import("./pages/review.js"),
	finance: () => import("./pages/finance.js"),
	profiles: () => import("./pages/profiles.js"),
	runs: () => import("./pages/runs.js"),
	home: () => import("./pages/home.js"),
	"org-select": () => Promise.resolve({ init() {} }),
	"org-create": () => Promise.resolve({ init() {} }),
	"org-claim-legacy": () => Promise.resolve({ init() {} }),
});

const syncProvider = createSyncProvider({
	basePath,
	initialCursor: readEventCursor(),
});
const rpcClient = createRpcClient();

const app = {
	basePath,
	appPath: (path) => appPath(basePath, path),
	subscribe: syncProvider.subscribe,
	mountTopics: syncProvider.mountTopics,
	reconnect: syncProvider.reconnect,
	close: syncProvider.close,
	postJson: rpcClient.postJson,
	refresh: () => shellNav.refresh(),
	scheduleRefresh: (options) => shellNav.scheduleRefresh(options),
	navigate: (url, options) => shellNav.navigate(url, options),
	currentPage: () => pageRegistry.currentPage(),
	currentPathname: () => currentPathname(basePath),
};

const shellNav = createShellNav({
	onAfterSwap: async (page) => {
		syncProvider.setCursor(readEventCursor());
		await pageRegistry.mount(page, app);
	},
});

const cleanupLinkClicks = shellNav.bindLinkClicks();
const cleanupPopState = shellNav.bindPopState();
const cleanupPrefetch = shellNav.bindPrefetch();

window.Zmail = app;
window.addEventListener("beforeunload", () => {
	cleanupLinkClicks();
	cleanupPopState();
	cleanupPrefetch();
	syncProvider.close();
	pageRegistry.cleanup();
});

void pageRegistry.mount(shellNav.currentMain()?.dataset.page || "unknown", app);
