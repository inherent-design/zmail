import { expect, type Page } from "@playwright/test";

export async function waitForHydration(page: Page) {
	await expect(page.getByTestId("sveltekit-shell")).toBeVisible();
}

export async function gotoAndHydrate(page: Page, path: string) {
	await page.goto(path);
	await waitForHydration(page);
}

export async function clickAndWaitForServerAction(
	page: Page,
	click: () => Promise<void>,
) {
	await Promise.all([
		page.waitForResponse((response) => {
			const request = response.request();
			return (
				request.method() === "POST" &&
				(response.url().includes("/rpc/") ||
					response.url().includes("/api/")) &&
				response.status() >= 200 &&
				response.status() < 400
			);
		}),
		click(),
	]);
}

async function findRunRow(
	page: Page,
	input: {
		kind: string;
		scopeId?: string;
	},
) {
	await gotoAndHydrate(page, "/runs");
	const rows = await page.locator("tbody tr").allTextContents();
	return (
		rows.find((row) => {
			if (!row.includes(input.kind)) {
				return false;
			}
			return input.scopeId ? row.includes(input.scopeId) : true;
		}) ?? ""
	);
}

export async function waitForRun(
	page: Page,
	input: {
		kind: string;
		scopeId?: string;
	},
) {
	await expect
		.poll(async () => findRunRow(page, input), { timeout: 180_000 })
		.toContain("complete");

	const row = await findRunRow(page, input);
	expect(row).toContain(input.kind);
	expect(row).toContain("complete");
	expect(row).toContain("0 errors");
}
