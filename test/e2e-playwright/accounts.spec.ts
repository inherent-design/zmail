import { expect, test } from "@playwright/test";

import { gotoAndHydrate, waitForHydration } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("accounts list and reconnect flows render the current control matrix", async ({
	page,
}) => {
	await gotoAndHydrate(page, "/accounts");

	const reconnectRow = page.locator("tbody tr").filter({
		hasText: PLAYWRIGHT_SCENARIOS.reconnect.account.label,
	});
	await expect(reconnectRow).toContainText("Needs reconnect");
	await expect(
		reconnectRow.getByRole("link", { name: "Reconnect", exact: true }),
	).toBeVisible();

	const disconnectedRow = page.locator("tbody tr").filter({
		hasText: PLAYWRIGHT_SCENARIOS.disconnected.account.label,
	});
	await expect(disconnectedRow).toContainText("Disconnected");
	await expect(
		disconnectedRow.getByRole("link", { name: "Reconnect", exact: true }),
	).toBeVisible();

	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.backlog.account.id}`,
	);
	await expect(
		page.getByRole("heading", { name: "PW Backlog Gmail" }),
	).toBeVisible();
	await expect(page.getByText("Paused", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Disconnect Gmail" }),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Delete local account" }),
	).toBeVisible();

	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.reconnect.account.id}/reconnect`,
	);
	await expect(
		page.getByRole("heading", { name: "Reconnect Gmail account" }),
	).toBeVisible();
	await expect(page.getByLabel("Account label")).toHaveValue(
		PLAYWRIGHT_SCENARIOS.reconnect.account.label,
	);
	await expect(page.getByLabel("Expected Gmail email")).toHaveValue(
		PLAYWRIGHT_SCENARIOS.reconnect.account.email,
	);
});

test("delete account requires typed confirmation and removes the account", async ({
	page,
}) => {
	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.delete.account.id}`,
	);
	await Promise.all([
		page.waitForURL(/\/delete$/),
		page.getByRole("link", { name: "Delete local account" }).click(),
	]);
	await waitForHydration(page);
	await expect(
		page.getByRole("heading", { name: "Delete local account" }),
	).toBeVisible();

	const deleteButton = page.getByRole("button", {
		name: "Delete local account",
	});
	await expect(deleteButton).toBeDisabled();

	await page
		.getByLabel("Confirmation email")
		.fill(PLAYWRIGHT_SCENARIOS.delete.account.email);
	await expect(deleteButton).toBeEnabled();

	await deleteButton.click();
	await page.waitForURL("**/accounts");
	await waitForAccountsRowGone(page, PLAYWRIGHT_SCENARIOS.delete.account.label);
});

async function waitForAccountsRowGone(
	page: import("@playwright/test").Page,
	label: string,
) {
	await expect
		.poll(
			async () => page.locator("tbody tr").filter({ hasText: label }).count(),
			{ timeout: 30_000 },
		)
		.toBe(0);
}
