import type { Page } from "@playwright/test";

export async function findClippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const candidates = document.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, h5, h6, p, label, button, a, strong, small, dt, dd",
    );
    return Array.from(candidates).flatMap((element) => {
      const text = element.innerText.trim().replace(/\s+/g, " ");
      const rect = element.getBoundingClientRect();
      if (!text || rect.width < 1 || rect.height < 1) return [];

      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") return [];
      const overflowAllowed = (value: string) => value === "auto" || value === "scroll";
      const intentionallyEllipsized = style.textOverflow === "ellipsis";
      const lineClamp = style.getPropertyValue("-webkit-line-clamp");
      const intentionallyClamped = Boolean(lineClamp && lineClamp !== "none" && lineClamp !== "0");
      const clippedHorizontally = element.scrollWidth > element.clientWidth + 1
        && !overflowAllowed(style.overflowX)
        && !intentionallyEllipsized;
      const clippedVertically = element.scrollHeight > element.clientHeight + 1
        && !overflowAllowed(style.overflowY)
        && !intentionallyClamped;
      if (!clippedHorizontally && !clippedVertically) return [];

      const identity = [
        element.tagName.toLowerCase(),
        element.id ? `#${element.id}` : "",
        ...Array.from(element.classList).map((name) => `.${name}`),
      ].join("");
      return [
        `${identity}: ${text.slice(0, 100)} `
        + `(client ${element.clientWidth}x${element.clientHeight}, `
        + `scroll ${element.scrollWidth}x${element.scrollHeight}, `
        + `font ${style.fontSize}/${style.lineHeight})`,
      ];
    });
  });
}
