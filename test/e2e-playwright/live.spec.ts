import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
	BACKLOG_SUBJECT,
	CLASSIFY_NOW_MESSAGE_ID,
	CLASSIFY_NOW_SUBJECT,
	LIVE_ACCOUNT_EMAIL,
	LIVE_ACCOUNT_ID,
	LIVE_ACCOUNT_LABEL,
	REVIEW_MESSAGE_ID,
	REVIEW_SUBJECT,
} from "./live-fixtures";

const manualOverride = readFileSync(
	resolve(process.cwd(), "test/fixtures/review/manual-override.json"),
	"utf8",
);

async function waitForHydration(page: Page) {
	await page.waitForFunction(() => typeof window.$_TSR === "undefined");
}

async function clickAndWaitForServerAction(
	page: Page,
	click: () => Promise<void>,
) {
	await Promise.all([
		page.waitForResponse((response) => {
			const request = response.request();
			return (
				request.method() === "POST" &&
				response.url().includes("/_serverFn/") &&
				response.status() >= 200 &&
				response.status() < 400
			);
		}),
		click(),
	]);
}

async function findRunRow(page: Page, kind: string) {
	await page.goto("/runs");
	await waitForHydration(page);
	const rows = await page.locator("tbody tr").allTextContents();
	return rows.find((row) => row.includes(kind)) ?? "";
}

async function waitForRun(page: Page, kind: string) {
	await expect
		.poll(async () => findRunRow(page, kind), { timeout: 180_000 })
		.toContain("complete");

	const row = await findRunRow(page, kind);
	expect(row).toContain(kind);
	expect(row).toContain("complete");
	expect(row).toContain("0 errors");
}

test("accounts -> classify backlog -> browse", async ({ page }) => {
	await page.goto("/accounts");
	await waitForHydration(page);
	await expect(page.getByText(LIVE_ACCOUNT_LABEL)).toBeVisible();
	await expect(page.getByText(LIVE_ACCOUNT_EMAIL)).toBeVisible();

	await page.getByRole("link", { name: LIVE_ACCOUNT_LABEL }).click();
	await waitForHydration(page);
	await clickAndWaitForServerAction(page, () =>
		page.getByRole("button", { name: "Classify backlog" }).click(),
	);
	await expect(page.getByText("classify_account_backlog")).toBeVisible();

	await waitForRun(page, "classify_account_backlog");

	await page.goto("/messages");
	await waitForHydration(page);
	const backlogRow = page.locator("tbody tr").filter({
		hasText: BACKLOG_SUBJECT,
	});
	await expect(backlogRow).toContainText("finance");
});

test("message detail -> classify now", async ({ page }) => {
	await page.goto(`/messages/${CLASSIFY_NOW_MESSAGE_ID}`);
	await waitForHydration(page);
	await expect(
		page.getByRole("heading", { name: CLASSIFY_NOW_SUBJECT }),
	).toBeVisible();
	await clickAndWaitForServerAction(page, () =>
		page.getByRole("button", { name: "Classify now" }).click(),
	);
	const currentLabelCard = page
		.locator(".card")
		.filter({
			hasText: "Current label",
		})
		.first();
	await expect(currentLabelCard).toContainText("message-label.v1");
	await expect(currentLabelCard).toContainText("primaryBucket");
	await expect(currentLabelCard).toContainText("personal");
});

test("review override flow", async ({ page }) => {
	await page.goto("/review");
	await waitForHydration(page);
	await expect(page.getByText(REVIEW_SUBJECT)).toBeVisible();
	const reviewCard = page.locator("section.card").filter({
		hasText: REVIEW_SUBJECT,
	});
	await reviewCard.getByLabel("Override JSON").fill(manualOverride);
	await clickAndWaitForServerAction(page, () =>
		reviewCard.getByRole("button", { name: "Override" }).click(),
	);
	await expect(page.getByText(REVIEW_SUBJECT)).toHaveCount(0);

	await page.goto(`/messages/${REVIEW_MESSAGE_ID}`);
	await waitForHydration(page);
	await expect(
		page.getByText("Manual override for review coverage.").first(),
	).toBeVisible({ timeout: 10_000 });
});

test("profile rebuild", async ({ page }) => {
	await page.goto("/accounts");
	await waitForHydration(page);
	await page.getByRole("link", { name: LIVE_ACCOUNT_LABEL }).click();
	await waitForHydration(page);
	await page.getByRole("link", { name: "Open overseer" }).click();
	await waitForHydration(page);
	await clickAndWaitForServerAction(page, () =>
		page.getByRole("button", { name: "Queue overseer rebuild" }).click(),
	);
	await waitForRun(page, "rebuild_overseer");
	await page.goto(`/profiles/${LIVE_ACCOUNT_ID}`);
	await waitForHydration(page);
	await expect(
		page.getByRole("heading", { name: LIVE_ACCOUNT_LABEL }),
	).toBeVisible();
	await expect(page.getByText("overseer-profile.v1")).toHaveCount(2);
});
