import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		setupFiles: ["./test/setup.ts"],
		restoreMocks: true,
		include: [
			"test/**/*.test.ts",
			"test/**/*.test.tsx",
			"test/**/*.test.svelte",
		],
		exclude: ["test/e2e-playwright/**"],
		coverage: {
			provider: "v8",
			include: ["server/**/*.ts", "lib/**/*.ts", "scripts/**/*.ts", "src/**/*"],
			reporter: ["text", "json-summary"],
			exclude: [
				"db/**",
				"prompts/**",
				"test/**",
				"public/**",
				".svelte-kit/**",
			],
			thresholds: {
				statements: 100,
				branches: 100,
				functions: 100,
				lines: 100,
			},
		},
	},
});
