import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function fixturePath(...segments: string[]) {
	return resolve(process.cwd(), "test", "fixtures", ...segments);
}

export async function makeTempDir(prefix: string) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	globalThis.__zmailTestRuntimeDirs__?.add(dir);
	return dir;
}
