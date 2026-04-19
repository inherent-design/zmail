import { expect, test } from "@playwright/test";

import { gotoAndHydrate, waitForHydration } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("finance page shows warning state and consistent filtered views", async ({
	page,
}) => {
	await gotoAndHydrate(page, "/finance?tab=ledger");

	await expect(
		page.getByText("Warning: Registry has not been imported yet."),
	).toBeVisible();

	await expect(page.getByText("Account filter")).toBeVisible();
	await expect(page.getByText("Institution filter")).toBeVisible();
	await expect(page.getByText("Identity filter")).toBeVisible();
	await expect(page.getByText("Source filter")).toBeVisible();
	await expect(page.getByRole("link", { name: "overview" })).toBeVisible();
	await expect(page.getByRole("link", { name: "ledger" })).toBeVisible();
	await expect(page.getByRole("link", { name: "imports" })).toBeVisible();
	await expect(page.locator("details.drawer").first()).toBeVisible();

	await expect(page.getByRole("cell", { name: "Acme Cloud" })).toBeVisible();
	await expect(page.getByRole("cell", { name: "PDF Services" })).toBeVisible();

	const sourceFilterCard = page.locator("section.card").filter({
		hasText: "Source filter",
	});
	await Promise.all([
		page.waitForURL(/sourceKind=pdf/),
		sourceFilterCard.getByRole("link", { name: "pdf", exact: true }).click(),
	]);
	await waitForHydration(page);

	await expect(page.getByRole("cell", { name: "PDF Services" })).toBeVisible();
	await expect(page.getByRole("cell", { name: "Acme Cloud" })).toHaveCount(0);
	await Promise.all([
		page.waitForURL(/\/finance\?tab=ledger&year=/),
		page.getByRole("link", { name: "Clear filters" }).click(),
	]);
	await waitForHydration(page);
	await expect(page.getByRole("cell", { name: "Acme Cloud" })).toBeVisible();
	await expect(page.getByRole("cell", { name: "PDF Services" })).toBeVisible();

	await Promise.all([
		page.waitForURL(/tab=imports/),
		page.getByRole("link", { name: "imports" }).click(),
	]);
	await waitForHydration(page);
	await expect(
		page.getByRole("cell", { name: "PDF Credit Union" }),
	).toBeVisible();

	await Promise.all([
		page.waitForURL(/tab=ledger/),
		page.getByRole("link", { name: "ledger" }).click(),
	]);
	await waitForHydration(page);

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

	await expect(page.getByRole("cell", { name: "Acme Cloud" })).toBeVisible();
	await expect(page.getByRole("cell", { name: "PDF Services" })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Clear filters" })).toBeVisible();
});
