import { pathToFileURL } from "node:url";

import { type LogTrace, startTrace } from "#/lib/log";

export function isDirectExecution(importMetaUrl: string) {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}
	return importMetaUrl === pathToFileURL(entry).href;
}

export function runCli(
	main: (trace?: LogTrace) => Promise<void>,
	importMetaUrl: string,
	commandName = "cli",
) {
	if (!isDirectExecution(importMetaUrl)) {
		return;
	}

	const trace = startTrace({
		kind: "cli",
		operation: commandName,
	});
	trace.info("cli.command.start");

	void main(trace)
		.then(() => {
			trace.complete("cli.command.complete");
		})
		.catch((error) => {
			trace.fail("cli.command.fail", error);
			process.exitCode = 1;
		});
}
