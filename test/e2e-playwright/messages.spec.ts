import { expect, test } from "@playwright/test";

import { gotoAndHydrate } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("account and message pages render through SvelteKit SSR", async ({
	page,
}) => {
	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.backlog.account.id}`,
	);
	await expect(page.getByTestId("sveltekit-shell")).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: PLAYWRIGHT_SCENARIOS.backlog.account.label,
		}),
	).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.backlog.account.id,
	);

	await gotoAndHydrate(
		page,
		`/messages/${PLAYWRIGHT_SCENARIOS.backlog.message.id}`,
	);
	await expect(
		page.getByRole("heading", {
			name: PLAYWRIGHT_SCENARIOS.backlog.message.subject,
		}),
	).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		PLAYWRIGHT_SCENARIOS.backlog.message.id,
	);
});
