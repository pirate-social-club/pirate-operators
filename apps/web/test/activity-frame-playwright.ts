import { expect, type Locator } from "@playwright/test";

type Metrics = {
  viewport: number;
  header?: { left: number; right: number; width: number; top: number };
  content?: { left: number; right: number; width: number; top: number; bottom: number; scrollHeight: number; clientHeight: number; scrollTop: number };
  footer?: { left: number; right: number; width: number; top: number };
};

async function metrics(root: Locator): Promise<Metrics> {
  return root.evaluate((element) => {
    const read = (name: string) => {
      const slot = element.querySelector(`[data-activity-frame-slot="${name}"]`);
      if (!slot) return undefined;
      const rect = slot.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        top: rect.top,
        bottom: rect.bottom,
        scrollHeight: slot.scrollHeight,
        clientHeight: slot.clientHeight,
        scrollTop: slot.scrollTop,
      };
    };
    return {
      viewport: window.innerWidth,
      header: read("header"),
      content: read("content"),
      footer: read("footer"),
    } as Metrics;
  });
}

export async function expectLearningActivityFrame(
  root: Locator,
  options: { footer?: boolean; header?: boolean } = {},
) {
  const value = await metrics(root);
  if (!value.content) throw new Error("Expected the learning activity content slot");
  const expectedWidth = Math.min(value.viewport, 640);
  expect(Math.round(value.content.width)).toBe(expectedWidth);
  if (value.viewport > expectedWidth) {
    expect(Math.abs(value.content.left - (value.viewport - value.content.right))).toBeLessThanOrEqual(1);
  } else {
    expect(Math.round(value.content.left)).toBe(0);
    expect(Math.round(value.content.right)).toBe(value.viewport);
  }
  for (const name of ["header", "footer"] as const) {
    if ((name === "header" && options.header === false) || (name === "footer" && options.footer === false)) continue;
    const slot = value[name];
    if (!slot) throw new Error(`Expected the learning activity ${name} slot`);
    expect(Math.round(slot.width)).toBe(Math.round(value.content.width));
    expect(Math.abs(slot.left - value.content.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(slot.right - value.content.right)).toBeLessThanOrEqual(1);
  }
  return value;
}

export async function expectInsideLearningActivityColumn(root: Locator, target: Locator) {
  const frame = await metrics(root);
  if (!frame.content) throw new Error("Expected the learning activity content slot");
  const box = await target.boundingBox();
  if (!box) throw new Error("Expected a visible target inside the learning activity column");
  expect(box.x).toBeGreaterThanOrEqual(frame.content.left - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.content.right + 1);
}

export async function learningActivityMetrics(root: Locator) {
  return metrics(root);
}
