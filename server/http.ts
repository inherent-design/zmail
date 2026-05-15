import { existsSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { getRequestListener } from "@hono/node-server";

import { loadResolvedConfig, stripBasePath } from "#/lib/app-config";
import { startTrace } from "#/lib/log";
import { app, injectWebSocket, prepareApiRuntime } from "#/server/app";

type NodeHandler = (
	req: IncomingMessage,
	res: ServerResponse,
	next?: (error?: unknown) => void,
) => void | Promise<void>;

const config = loadResolvedConfig();

function honoOwnsRequest(req: IncomingMessage) {
	if (!req.url) {
		return true;
	}
	const url = new URL(req.url, config.server.publicOrigin);
	const pathname = stripBasePath(url.pathname);
	if (
		pathname === "/healthz" ||
		pathname === "/readyz" ||
		pathname === config.observability.metricsPath ||
		pathname === "/ws" ||
		pathname === "/ops/health" ||
		pathname.startsWith("/assets/")
	) {
		return true;
	}
	if (
		pathname.startsWith("/auth/") ||
		pathname.startsWith("/rpc/") ||
		pathname.startsWith("/api/")
	) {
		return true;
	}
	if (pathname.startsWith("/org/") && req.method !== "GET") {
		return true;
	}
	return false;
}

async function loadSvelteHandler(): Promise<NodeHandler> {
	const handlerPath = resolve("build/handler.js");
	if (!existsSync(handlerPath)) {
		return (_req, res) => {
			res.statusCode = 503;
			res.setHeader("content-type", "text/plain; charset=utf-8");
			res.end("SvelteKit build missing. Run pnpm build before preview.");
		};
	}
	const mod = (await import(pathToFileURL(handlerPath).href)) as {
		handler: NodeHandler;
	};
	return mod.handler;
}

export async function createProductionServer() {
	const honoListener = getRequestListener(app.fetch);
	const svelteHandler = await loadSvelteHandler();
	const server = createServer((req, res) => {
		if (honoOwnsRequest(req)) {
			void honoListener(req, res);
			return;
		}
		void svelteHandler(req, res, (error?: unknown) => {
			if (error) {
				res.statusCode = 500;
				res.end(error instanceof Error ? error.message : "Application error");
			}
		});
	});
	injectWebSocket(server);
	return server;
}

export async function startProductionServer() {
	await prepareApiRuntime();
	const server = await createProductionServer();
	server.listen(config.server.bindPort, config.server.bindHost, () => {
		startTrace({
			kind: "process",
			operation: "server.startup",
		}).complete("server.listen", {
			public_origin: config.server.publicOrigin,
			base_path: config.server.basePath,
			bind_host: config.server.bindHost,
			bind_port: config.server.bindPort,
			renderer: "sveltekit",
		});
	});
	return server;
}

const entrypointArg = process.argv[1];
if (entrypointArg && import.meta.url === new URL(entrypointArg, "file:").href) {
	await startProductionServer();
}
