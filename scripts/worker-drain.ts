import type { LogTrace } from "#/lib/log";
import { drainWorkerUntilIdle } from "#/lib/worker";
import { runCli } from "#/scripts/_shared";

export async function main(_trace?: LogTrace) {
	await drainWorkerUntilIdle();
}

runCli(main, import.meta.url, "worker:drain");
