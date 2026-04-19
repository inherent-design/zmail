import { expect, type Locator, test } from "@playwright/test";

import { gotoAndHydrate, waitForHydration } from "./helpers";
import { PLAYWRIGHT_SCENARIOS } from "./scenarios";

async function expectNonBlankCanvas(canvas: Locator) {
	await expect
		.poll(
			async () =>
				canvas.evaluate((element) => {
					if (!(element instanceof HTMLCanvasElement)) {
						return false;
					}
					if (element.width === 0 || element.height === 0) {
						return false;
					}
					const context = element.getContext("2d");
					if (!context) {
						return false;
					}
					const pixels = context.getImageData(
						0,
						0,
						element.width,
						element.height,
					).data;
					for (let index = 0; index < pixels.length; index += 4) {
						if (
							pixels[index] !== 0 ||
							pixels[index + 1] !== 0 ||
							pixels[index + 2] !== 0 ||
							pixels[index + 3] !== 0
						) {
							return true;
						}
					}
					return false;
				}),
			{ timeout: 10_000 },
		)
		.toBe(true);
}

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

test("finance chart islands render canvases", async ({ page }) => {
	await gotoAndHydrate(page, "/finance");

	const cashflow = page.locator('[data-zmail-island="finance.cashflow"]');
	const categories = page.locator('[data-zmail-island="finance.categories"]');
	const cashflowCanvas = cashflow.locator("canvas");
	const categoriesCanvas = categories.locator("canvas");

	await expect(
		cashflow.locator('[data-finance-chart="cashflow"]'),
	).toBeVisible();
	await expect(
		categories.locator('[data-finance-chart="categories"]'),
	).toBeVisible();
	await expect(cashflowCanvas).toHaveCount(1);
	await expect(categoriesCanvas).toHaveCount(1);
	await expect
		.poll(async () =>
			cashflowCanvas.evaluate((element) =>
				element instanceof HTMLCanvasElement ? element.width : 0,
			),
		)
		.toBeGreaterThan(100);
	await expectNonBlankCanvas(cashflowCanvas);
	await expectNonBlankCanvas(categoriesCanvas);
});

test("finance page remains useful with JavaScript disabled", async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	});
	const page = await context.newPage();
	try {
		await page.goto("/finance");

		await expect(page.getByRole("heading", { name: "Finance" })).toBeVisible();
		await expect(page.getByText("Transactions")).toBeVisible();
		await expect(
			page.getByRole("cell", { name: "software_services / saas" }),
		).toBeVisible();
		await expect(
			page.getByRole("cell", { name: "software_services / statement_import" }),
		).toBeVisible();
		await expect(page.locator('[data-finance-chart="cashflow"]')).toBeVisible();
	} finally {
		await context.close();
	}
});
