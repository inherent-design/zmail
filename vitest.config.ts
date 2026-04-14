import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["./test/setup.ts"],
		restoreMocks: true,
		include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
		exclude: ["test/e2e-playwright/**"],
		coverage: {
			provider: "v8",
			include: [
				"app/**/*.ts",
				"app/**/*.tsx",
				"lib/**/*.ts",
				"scripts/**/*.ts",
				"config/**/*.ts",
			],
			exclude: [
				"app/routeTree.gen.ts",
				"app/styles.css",
				"db/**",
				"prompts/**",
				"test/**",
				"test/e2e-playwright/**",
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
