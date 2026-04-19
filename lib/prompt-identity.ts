import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PROMPTS_DIR } from "#/lib/config";

export interface PromptIdentity {
	name: string;
	text: string;
	sha256: string;
}

export function readPromptIdentity(name: string): PromptIdentity {
	const text = readFileSync(resolve(PROMPTS_DIR, name), "utf8");
	return {
		name,
		text,
		sha256: createHash("sha256").update(text).digest("hex"),
	};
}

export function promptSha256ForName(name: string) {
	return readPromptIdentity(name).sha256;
}
