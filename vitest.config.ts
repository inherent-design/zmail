import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["./test/setup.ts"],
		restoreMocks: true,
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
		exclude: ["test/e2e-playwright/**"],
		coverage: {
			provider: "v8",
			include: ["server/**/*.ts", "lib/**/*.ts", "scripts/**/*.ts"],
			reporter: ["text", "json-summary"],
			exclude: [
				"server/index.tsx",
				"server/ui.tsx",
				"db/**",
				"prompts/**",
				"test/**",
				"public/**",
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
