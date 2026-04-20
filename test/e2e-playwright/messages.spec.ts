import { expect, test } from "@playwright/test";

import {
	clickAndWaitForServerAction,
	gotoAndHydrate,
	waitForRun,
} from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

test("classify backlog queues a run and leaves a current v3 label", async ({
	page,
}) => {
	await gotoAndHydrate(
		page,
		`/accounts/${PLAYWRIGHT_SCENARIOS.backlog.account.id}`,
	);
	await clickAndWaitForServerAction(page, () =>
		page.getByRole("button", { name: "Classify backlog" }).click(),
	);
	await expect(
		page.locator('[data-zmail-island="account.mailbox-sync"]'),
	).not.toContainText("Phaseunknown");
	await expect(
		page.locator('[data-zmail-island="account.lanes"]'),
	).toContainText("Root classifier");

	await waitForRun(page, {
		kind: "classify_account_backlog",
		scopeId: PLAYWRIGHT_SCENARIOS.backlog.account.id,
	});

	await gotoAndHydrate(
		page,
		`/messages/${PLAYWRIGHT_SCENARIOS.backlog.message.id}`,
	);
	const currentLabelCard = page
		.locator(".card")
		.filter({ hasText: "Current label" })
		.first();
	await expect(currentLabelCard).toContainText("message-label.v3");
	await expect(currentLabelCard).toContainText("primaryBucket");
});

test("classify now produces a current v3 label on message detail", async ({
	page,
}) => {
	await gotoAndHydrate(
		page,
		`/messages/${PLAYWRIGHT_SCENARIOS.classifyNow.message.id}`,
	);
	await expect(
		page.getByRole("heading", {
			name: PLAYWRIGHT_SCENARIOS.classifyNow.message.subject,
		}),
	).toBeVisible();

	await clickAndWaitForServerAction(page, () =>
		page.getByRole("button", { name: "Classify now" }).click(),
	);
	await waitForRun(page, {
		kind: "classify_root_messages",
		scopeId: PLAYWRIGHT_SCENARIOS.classifyNow.account.id,
	});
	await gotoAndHydrate(
		page,
		`/messages/${PLAYWRIGHT_SCENARIOS.classifyNow.message.id}`,
	);

	const currentLabelCard = page
		.locator(".card")
		.filter({ hasText: "Current label" })
		.first();
	await expect(currentLabelCard).toContainText("message-label.v3");
	await expect(currentLabelCard).toContainText("primaryBucket");
});
