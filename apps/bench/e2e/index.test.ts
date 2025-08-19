import { expect, test } from "@playwright/test";

test("should display content", async ({ page }) => {
	const title = "The first post";

	await page.goto("/");

	const link = page.getByRole("link", { name: title });
	await expect(link).toBeVisible();

	await link.click();
	await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
});
