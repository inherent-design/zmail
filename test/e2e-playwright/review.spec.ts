import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { clickAndWaitForServerAction, gotoAndHydrate } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

const manualOverride = readFileSync(
	resolve(process.cwd(), "test/fixtures/review/manual-override.json"),
	"utf8",
);

test("review override resolves the seeded open review", async ({ page }) => {
	await gotoAndHydrate(page, "/review");
	const reviewCard = page.locator(
		`section[data-review-id="${PLAYWRIGHT_SCENARIOS.review.reviewId}"]`,
	);
	await expect(reviewCard).toBeVisible();
	await reviewCard.getByLabel("Override JSON").fill(manualOverride);
	await clickAndWaitForServerAction(page, () =>
		reviewCard.getByRole("button", { name: "Override" }).click(),
	);
	await expect(reviewCard).toHaveCount(0);

	await gotoAndHydrate(
		page,
		`/messages/${PLAYWRIGHT_SCENARIOS.review.message.id}`,
	);
	await expect(
		page.getByText("Manual override for review coverage.").first(),
	).toBeVisible();
});
