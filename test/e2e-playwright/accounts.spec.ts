import { expect, test } from "@playwright/test";

import { gotoAndHydrate, waitForHydration } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("accounts routes render through SvelteKit SSR", async ({ page }) => {
	await gotoAndHydrate(page, "/accounts");

	await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.reconnect.account.id,
	);

	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.backlog.account.id}`,
	);
	await expect(
		page.getByRole("heading", {
			name: PLAYWRIGHT_SCENARIOS.backlog.account.label,
		}),
	).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.backlog.account.id,
	);

	await page.getByRole("link", { name: "Accounts" }).click();
	await waitForHydration(page);
	await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
});

test("account lifecycle pages render with seeded account data", async ({
	page,
}) => {
	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.reconnect.account.id}/reconnect`,
	);
	await expect(
		page.getByRole("heading", { name: "Reconnect Gmail" }),
	).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.reconnect.account.id,
	);

	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.delete.account.id}/delete`,
	);
	await expect(
		page.getByRole("heading", { name: "Delete local account" }),
	).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.delete.account.id,
	);
});
