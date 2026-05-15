import { expect, test } from "@playwright/test";

import { gotoAndHydrate, waitForHydration } from "./helpers";

test("finance page renders through SvelteKit with shareable filter params", async ({
	page,
}) => {
	await gotoAndHydrate(page, "/finance?tab=ledger&sourceKind=pdf");

	await expect(page.getByRole("heading", { name: "Finance" })).toBeVisible();
	await expect(page.getByTestId("page-content")).toBeVisible();
	await expect(page.getByTestId("data-inspector")).toContainText(
		"Finance data",
	);
	await expect(page).toHaveURL(/sourceKind=pdf/);
	await expect(page.locator("#app-main")).toBeVisible();
});

test("navigation keeps SvelteKit shell stable across operator routes", async ({
	page,
}) => {
	await gotoAndHydrate(page, "/finance?tab=ledger&sourceKind=pdf");
	const shell = page.getByTestId("sveltekit-shell");
	await shell.evaluate((element) =>
		element.setAttribute("data-test-shell-stable", "yes"),
	);

	await page.getByRole("link", { name: "Runs" }).click();
	await waitForHydration(page);
	await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
	await expect(shell).toHaveAttribute("data-test-shell-stable", "yes");

	await page.goBack();
	await waitForHydration(page);
	await expect(page).toHaveURL(/sourceKind=pdf/);
	await expect(page.getByRole("heading", { name: "Finance" })).toBeVisible();
});

test("WebSocket accepts browser subscribe and ping messages", async ({
	page,
}) => {
	await gotoAndHydrate(page, "/");

	const messages = await page.evaluate(async () => {
		const url = new URL("/ws", window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url);
		const seen: string[] = [];
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(
				() => reject(new Error("WebSocket timed out")),
				10_000,
			);
			socket.addEventListener("open", () => {
				socket.send(
					JSON.stringify({
						type: "subscribe",
						topics: ["jobs", "finance"],
						cursor: 0,
					}),
				);
				socket.send(JSON.stringify({ type: "ping", id: "e2e" }));
			});
			socket.addEventListener("message", (event) => {
				const message = JSON.parse(String(event.data)) as { type: string };
				seen.push(message.type);
				if (seen.includes("ready") && seen.includes("pong")) {
					window.clearTimeout(timeout);
					socket.close();
					resolve();
				}
			});
			socket.addEventListener("error", () => {
				window.clearTimeout(timeout);
				reject(new Error("WebSocket failed"));
			});
		});
		return seen;
	});

	expect(messages).toContain("ready");
	expect(messages).toContain("pong");
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
		await expect(page.getByTestId("data-inspector")).toBeVisible();
	} finally {
		await context.close();
	}
});
