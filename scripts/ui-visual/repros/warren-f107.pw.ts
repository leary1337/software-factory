/** warren-f107: align sidebar labels and remove the Documentation link. */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { harnessCases, openCase } from "../harness.ts";

const { fixture, cases } = harnessCases();

async function openSidebar(page: Page, phone: boolean) {
	if (phone)
		await page
			.getByRole("navigation", { name: "Primary" })
			.getByRole("button", { name: "More" })
			.click();
	const sidebar = phone ? page.getByRole("dialog") : page.locator("aside");
	await sidebar.locator("summary").click();
	return sidebar;
}

async function labelLeft(row: Locator) {
	return row.evaluate((element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.trim()) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			return range.getBoundingClientRect().left;
		}
		throw new Error("Missing navigation label");
	});
}

for (const c of cases.filter((entry) => entry.page.id === "overview")) {
	test.describe(`sidebar alignment ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("aligns menu and footer labels in one column with equal row heights", async ({ page }) => {
			await openCase(page, c, fixture);
			const sidebar = await openSidebar(page, c.viewport === "phone");
			const reference = await labelLeft(
				sidebar.getByRole("link", { name: "Overview", exact: true }),
			);
			const rows = [
				...(await sidebar.getByRole("navigation", { name: "Workspace" }).getByRole("link").all()),
				sidebar.locator("summary"),
				sidebar.getByRole("link", { name: "Settings", exact: true }),
				sidebar.getByRole("button", { name: "Log out", exact: true }),
				sidebar.getByRole("button", { name: /^Theme:/ }),
			];
			for (const row of rows) {
				expect.soft(await labelLeft(row), await row.innerText()).toBeCloseTo(reference, 0);
				expect.soft((await row.boundingBox())?.height, await row.innerText()).toBe(44);
				if (await row.locator("svg").count()) {
					expect.soft((await row.locator("svg").boundingBox())?.x).toBeCloseTo(reference - 28, 0);
				}
			}
			const theme = sidebar.getByRole("button", { name: /^Theme:/ });
			const themeBox = await theme.boundingBox();
			expect((themeBox?.y ?? 0) + (themeBox?.height ?? 0)).toBeLessThanOrEqual(c.size.height);
			for (let i = 0; i < 3; i++) {
				await theme.click();
				expect(await labelLeft(theme)).toBeCloseTo(reference, 0);
			}
		});
		test("removes the Documentation shortcut from the menu", async ({ page }) => {
			await openCase(page, c, fixture);
			const sidebar = await openSidebar(page, c.viewport === "phone");
			await expect(sidebar.getByRole("link", { name: /Documentation/ })).toHaveCount(0);
		});
	});
}
