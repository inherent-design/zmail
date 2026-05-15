import { spawn } from "node:child_process";

import { serve } from "@hono/node-server";

import { loadResolvedConfig } from "#/lib/app-config";
import { startTrace } from "#/lib/log";
import { app, injectWebSocket, prepareApiRuntime } from "#/server/app";

const config = loadResolvedConfig();

await prepareApiRuntime();
const apiServer = serve({
	fetch: app.fetch,
	hostname: config.server.bindHost,
	port: config.server.bindPort,
});
injectWebSocket(apiServer);

const vite = spawn(
	"pnpm",
	["exec", "vite", "dev", "--host", config.server.bindHost, "--port", "5173"],
	{
		stdio: "inherit",
		env: process.env,
	},
);

startTrace({ kind: "process", operation: "server.startup" }).complete(
	"server.listen",
	{
		public_origin: config.server.publicOrigin,
		base_path: config.server.basePath,
		bind_host: config.server.bindHost,
		bind_port: config.server.bindPort,
		renderer: "sveltekit-dev",
		vite_origin: `http://${config.server.bindHost}:5173`,
	},
);

function shutdown() {
	vite.kill();
	apiServer.close();
}

process.once("SIGINT", () => {
	shutdown();
	process.exit(130);
});
process.once("SIGTERM", () => {
	shutdown();
	process.exit(143);
});

vite.once("exit", (code) => {
	apiServer.close();
	process.exit(code ?? 0);
});
