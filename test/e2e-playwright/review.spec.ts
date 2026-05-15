import { expect, test } from "@playwright/test";

import { gotoAndHydrate } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("review page renders through SvelteKit SSR", async ({ page }) => {
	await gotoAndHydrate(page, "/review");

	await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.review.reviewId,
	);
});
