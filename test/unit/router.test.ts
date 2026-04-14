import { describe, expect, it, vi } from "vitest";

const createRouter = vi.fn((options: unknown) => options);

vi.mock("@tanstack/react-router", () => ({
	createRouter,
}));

vi.mock("#/app/routeTree.gen", () => ({
	routeTree: { id: "__root__" },
}));

describe("app router", () => {
	it("creates the TanStack router with the generated route tree", async () => {
		const router = await import("#/app/router");
		const result = router.getRouter();

		expect(createRouter).toHaveBeenCalledWith({
			routeTree: { id: "__root__" },
			scrollRestoration: true,
			defaultPreload: "intent",
			defaultPreloadStaleTime: 0,
		});
		expect(result).toMatchObject({
			routeTree: { id: "__root__" },
		});
	});
});
