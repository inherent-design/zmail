import autocannon from "autocannon";

import { runCli } from "#/scripts/_shared";

interface TargetConfig {
	title: string;
	url: string;
	method?: "GET" | "POST";
	body?: string;
}

function targetList(baseUrl: string) {
	const targets: TargetConfig[] = [
		{ title: "home", url: `${baseUrl}/` },
		{ title: "accounts", url: `${baseUrl}/accounts` },
		{ title: "runs", url: `${baseUrl}/runs` },
		{ title: "finance", url: `${baseUrl}/finance` },
	];

	const rpcPath = process.env.ZMAIL_BENCH_RPC_PATH;
	if (rpcPath) {
		targets.push({
			title: "rpc",
			url: `${baseUrl}${rpcPath}`,
			method: "POST",
			body: "{}",
		});
	}

	return targets;
}

async function runOne(input: {
	title: string;
	url: string;
	method?: "GET" | "POST";
	body?: string;
	connections: number;
	duration: number;
}) {
	const result = await autocannon({
		url: input.url,
		method: input.method ?? "GET",
		body: input.body,
		connections: input.connections,
		duration: input.duration,
		headers:
			input.method === "POST"
				? {
						"content-type": "application/json",
					}
				: undefined,
	});

	console.log(`\n[${input.title}] ${input.method ?? "GET"} ${input.url}`);
	console.log(
		`  latency p50=${result.latency.p50}ms p97.5=${result.latency.p97_5}ms avg=${result.latency.average}ms`,
	);
	console.log(
		`  requests avg=${result.requests.average}/s total=${result.requests.total}`,
	);
	console.log(`  throughput avg=${result.throughput.average} B/s`);
}

async function main() {
	const baseUrl = process.env.ZMAIL_BASE_URL ?? "http://127.0.0.1:56711";
	const connections = Number.parseInt(
		process.env.ZMAIL_BENCH_CONNECTIONS ?? "10",
		10,
	);
	const duration = Number.parseInt(
		process.env.ZMAIL_BENCH_DURATION ?? "10",
		10,
	);

	console.log(
		`HTTP benchmark against ${baseUrl} with ${connections} connections for ${duration}s per target.`,
	);

	for (const target of targetList(baseUrl)) {
		await runOne({
			...target,
			connections,
			duration,
		});
	}
}

runCli(main, import.meta.url, "bench-http");
