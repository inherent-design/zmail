import { tanstackRouterGenerator } from "@tanstack/router-plugin/vite";
import { createServer } from "vite";
import type { LogTrace } from "#/lib/log";
import { runCli } from "#/scripts/_shared";

export async function main(_trace?: LogTrace) {
	const server = await createServer({
		configFile: false,
		root: process.cwd(),
		logLevel: "silent",
		plugins: [
			tanstackRouterGenerator({
				target: "react",
				routesDirectory: "./app/routes",
				generatedRouteTree: "./app/routeTree.gen.ts",
				routeFileIgnorePrefix: "-",
				autoCodeSplitting: true,
			}),
		],
	});

	await server.close();
}

runCli(main, import.meta.url, "router:generate");
