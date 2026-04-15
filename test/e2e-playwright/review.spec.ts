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
	await expect(
		page.getByText(PLAYWRIGHT_SCENARIOS.review.message.subject),
	).toBeVisible();

	const reviewCard = page.locator("section.card").filter({
		hasText: PLAYWRIGHT_SCENARIOS.review.message.subject,
	});
	await reviewCard.getByLabel("Override JSON").fill(manualOverride);
	await clickAndWaitForServerAction(page, () =>
		reviewCard.getByRole("button", { name: "Override" }).click(),
	);
	await expect(
		page.getByText(PLAYWRIGHT_SCENARIOS.review.message.subject),
	).toHaveCount(0);

	await gotoAndHydrate(
		page,
		`/messages/${PLAYWRIGHT_SCENARIOS.review.message.id}`,
	);
	await expect(
		page.getByText("Manual override for review coverage.").first(),
	).toBeVisible();
});
