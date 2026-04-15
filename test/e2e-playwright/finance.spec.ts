import { expect, test } from "@playwright/test";

import { gotoAndHydrate, waitForHydration } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("finance page shows warning state and consistent filtered views", async ({
	page,
}) => {
	await gotoAndHydrate(page, "/finance");

	await expect(
		page.getByText("Warning: Registry has not been imported yet."),
	).toBeVisible();
	await expect(
		page.getByText("Warning: Finance knowledge tables are still empty."),
	).toBeVisible();

	await expect(page.getByText("Account filter")).toBeVisible();
	await expect(page.getByText("Institution filter")).toBeVisible();
	await expect(page.getByText("Identity filter")).toBeVisible();
	await expect(page.getByText("Source filter")).toBeVisible();

	await expect(page.getByText("Acme Cloud")).toBeVisible();
	await expect(page.getByText("Imported PDF statement for March.")).toBeVisible();

	const sourceFilterCard = page.locator("section.card").filter({
		hasText: "Source filter",
	});
	await Promise.all([
		page.waitForURL(/sourceKind=pdf/),
		sourceFilterCard.getByRole("link", { name: "pdf", exact: true }).click(),
	]);
	await waitForHydration(page);

	await expect(page.getByText("PDF Services")).toBeVisible();
	await expect(page.getByText("Imported PDF statement for March.")).toBeVisible();
	await expect(page.getByText("Acme Cloud")).toHaveCount(0);

	const accountFilterCard = page.locator("section.card").filter({
		hasText: "Account filter",
	});
	await Promise.all([
		page.waitForURL(
			new RegExp(`accountId=${PLAYWRIGHT_SCENARIOS.finance.account.id}`),
		),
		accountFilterCard
			.getByRole("link", { name: PLAYWRIGHT_SCENARIOS.finance.account.label })
			.click(),
	]);
	await waitForHydration(page);

	await expect(page.getByText("Acme Cloud")).toBeVisible();
	await expect(page.getByText("Imported PDF statement for March.")).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Clear filters" })).toBeVisible();
});
