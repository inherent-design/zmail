import { rm } from "node:fs/promises";
import { resolve } from "node:path";

async function main() {
	await rm(resolve(process.cwd(), "test/.runtime/e2e-live"), {
		recursive: true,
		force: true,
	});
}

export default main;
