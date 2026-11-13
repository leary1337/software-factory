/** warren-f106: audit text and icons on every routed page, viewport and theme. */
import { expect, test } from "@playwright/test";
import { harnessCases, openCase } from "./harness.ts";

const { fixture, cases } = harnessCases();

for (const c of cases) {
	test.describe(`appearance ${c.name}`, () => {
		test.use({ viewport: c.size, colorScheme: c.theme });
		test("renders readable typography and contrasting icons", async ({ page }, info) => {
			await openCase(page, c, fixture);
			const report = await page.evaluate(() => {
				const problems: string[] = [];
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("Missing color parser");
				function rgba(color: string) {
					if (!ctx) throw new Error("Missing color parser");
					ctx.clearRect(0, 0, 1, 1);
					ctx.fillStyle = color;
					ctx.fillRect(0, 0, 1, 1);
					return Array.from(ctx.getImageData(0, 0, 1, 1).data);
				}
				function over(foreground: number[], background: number[], opacity = 1) {
					const alpha = ((foreground[3] ?? 255) / 255) * opacity;
					return [0, 1, 2].map(
						(index) => (foreground[index] ?? 0) * alpha + (background[index] ?? 0) * (1 - alpha),
					);
				}
				function luminance(color: number[]) {
					return color.reduce((sum, value, index) => {
						const channel = value / 255;
						return (
							sum +
							(channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) *
								([0.2126, 0.7152, 0.0722][index] ?? 0)
						);
					}, 0);
				}
				function rendered(element: Element) {
					const rect = element.getBoundingClientRect();
					const css = getComputedStyle(element);
					return (
						rect.width > 1 &&
						rect.height > 1 &&
						css.visibility !== "hidden" &&
						css.display !== "none" &&
						!element.closest(".sr-only,[hidden]")
					);
				}
				const textElements = Array.from(document.querySelectorAll("body *")).filter(
					(element) =>
						rendered(element) &&
						Array.from(element.childNodes).some(
							(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
						),
				);
				function inspectText(element: Element) {
					const css = getComputedStyle(element);
					const label = element.textContent?.trim().slice(0, 70);
					if (Number.parseFloat(css.fontSize) < 12)
						problems.push(`Small text ${css.fontSize}: ${label}`);
					if (!/Roboto Mono|Neue Machina/.test(css.fontFamily))
						problems.push(`Unexpected font ${css.fontFamily}: ${label}`);
				}
				function iconContrast(icon: Element) {
					const ancestors: Element[] = [];
					for (let element: Element | null = icon; element; element = element.parentElement)
						ancestors.unshift(element);
					let background = [255, 255, 255];
					let opacity = 1;
					for (const element of ancestors) {
						const css = getComputedStyle(element);
						background = over(rgba(css.backgroundColor), background);
						opacity *= Number.parseFloat(css.opacity);
					}
					const foreground = over(rgba(getComputedStyle(icon).color), background, opacity);
					const f = luminance(foreground),
						b = luminance(background);
					return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
				}
				function inspectIcon(icon: Element) {
					const label = icon.getAttribute("class")?.split(" ").slice(0, 2).join(" ");
					const rect = icon.getBoundingClientRect();
					if (rect.width < 12 || rect.height < 12)
						problems.push(`Small icon ${rect.width}×${rect.height}: ${label}`);
					const contrast = iconContrast(icon);
					if (contrast < 3) problems.push(`Icon contrast ${contrast.toFixed(2)}: ${label}`);
				}
				textElements.forEach(inspectText);
				const icons = Array.from(document.querySelectorAll("svg.lucide")).filter(rendered);
				icons.forEach(inspectIcon);
				return {
					text: textElements.length,
					icons: icons.length,
					problems,
					bodyFontLoaded: document.fonts.check('14px "Roboto Mono"', "Работа"),
					headingFontLoaded: document.fonts.check('700 24px "Neue Machina"', "Проекты"),
				};
			});
			await info.attach("readability-audit", {
				body: JSON.stringify(report, null, 2),
				contentType: "application/json",
			});
			expect(report.bodyFontLoaded).toBe(true);
			expect(report.headingFontLoaded).toBe(true);
			expect(report.problems).toEqual([]);
		});
	});
}
