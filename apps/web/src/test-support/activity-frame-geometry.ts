import { expect } from "storybook/test";

type SlotName = "header" | "content" | "footer";

function slot(root: ParentNode, name: SlotName) {
  return root.querySelector<HTMLElement>(`[data-activity-frame-slot="${name}"]`);
}

function rectOf(element: Element) {
  return element.getBoundingClientRect();
}

/** The learning frame owns slot geometry; children may intentionally be narrower inside it. */
export async function expectLearningActivityFrameGeometry(
  root: ParentNode,
  options: { footer?: boolean; header?: boolean } = {},
) {
  const content = slot(root, "content");
  if (!content) throw new Error("Expected the learning activity content slot");
  const contentRect = rectOf(content);
  const expectedWidth = Math.min(window.innerWidth, 640);
  await expect(Math.round(contentRect.width)).toBe(expectedWidth);
  if (window.innerWidth > expectedWidth) {
    await expect(Math.abs(contentRect.left - (window.innerWidth - contentRect.right))).toBeLessThanOrEqual(1);
  } else {
    await expect(Math.round(contentRect.left)).toBe(0);
    await expect(Math.round(contentRect.right)).toBe(window.innerWidth);
  }

  for (const name of ["header", "footer"] as const) {
    if ((name === "header" && options.header === false) || (name === "footer" && options.footer === false)) continue;
    const element = slot(root, name);
    if (!element) throw new Error(`Expected the learning activity ${name} slot`);
    const rect = rectOf(element);
    await expect(Math.round(rect.width)).toBe(Math.round(contentRect.width));
    await expect(Math.abs(rect.left - contentRect.left)).toBeLessThanOrEqual(1);
    await expect(Math.abs(rect.right - contentRect.right)).toBeLessThanOrEqual(1);
  }
  return contentRect;
}

export async function expectInsideLearningActivityColumn(
  element: Element,
  column: DOMRect,
  padding = 0,
) {
  const rect = rectOf(element);
  await expect(rect.left).toBeGreaterThanOrEqual(column.left + padding - 1);
  await expect(rect.right).toBeLessThanOrEqual(column.right - padding + 1);
}
