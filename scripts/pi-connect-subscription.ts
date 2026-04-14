import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import { loginOpenAICodex } from "@mariozechner/pi-ai/oauth";

import { PI_SUBSCRIPTION_PATH } from "#/lib/config";
import { type LogTrace, startTrace } from "#/lib/log";
import { runCli } from "#/scripts/_shared";

export async function main(trace?: LogTrace) {
	const runTrace =
		trace?.child({
			kind: "cli",
			operation: "pi:connect",
		}) ??
		startTrace({
			kind: "cli",
			operation: "pi:connect",
		});

	runTrace.info("cli.pi_connect.start");
	await mkdir(dirname(PI_SUBSCRIPTION_PATH), { recursive: true });
	const rl = createInterface({
		input: stdin,
		output: stdout,
	});

	try {
		const credentials = await loginOpenAICodex({
			originator: "zmail",
			onAuth(info) {
				runTrace.info("cli.pi_connect.auth_prompt", {
					has_instructions: Boolean(info.instructions),
					has_url: Boolean(info.url),
				});
				if (info.instructions) {
					console.log(info.instructions);
				}
				if (info.url) {
					console.log(info.url);
				}
			},
			onProgress(message) {
				runTrace.info("cli.pi_connect.progress");
				console.log(message);
			},
			async onManualCodeInput() {
				return rl.question("Verification code: ");
			},
			async onPrompt(prompt) {
				return rl.question(`${prompt.message} `);
			},
		});

		const record = {
			version: 1 as const,
			provider: "openai-subscription" as const,
			credentials,
			updatedAt: new Date().toISOString(),
		};
		await writeFile(
			PI_SUBSCRIPTION_PATH,
			JSON.stringify(record, null, 2),
			"utf8",
		);
		runTrace.complete("cli.pi_connect.credentials_stored");
		console.log(`subscription stored at ${PI_SUBSCRIPTION_PATH}`);
	} finally {
		rl.close();
	}
}

runCli(main, import.meta.url, "pi:connect");
