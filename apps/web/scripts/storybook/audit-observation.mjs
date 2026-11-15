// The observation window includes screenshot capture and closes explicitly.
// No result retains references to the live browser/host event buffers.
import { classify } from "./audit-results.mjs";

function immutableCopy(value) {
  const copy = structuredClone(value);
  const visited = new Set();
  const freeze = (item) => {
    if (!item || typeof item !== "object" || visited.has(item)) return item;
    visited.add(item);
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(copy);
}

export function createHostEvidence() {
  const data = { errors: [], blocked: [], consoleErrors: [] };
  let final;
  return {
    record(kind, value) {
      if (!Object.hasOwn(data, kind)) throw new Error("Unknown evidence kind: " + kind);
      if (!final) data[kind].push(structuredClone(value));
    },
    close(raw, observedPageSize) {
      // This synchronous call is the host-side observation boundary.
      // Browser channel collection has already closed inside page.evaluate.
      final ??= immutableCopy({
        ...data, raw, observedPageSize, closed: true,
        closedAt: new Date().toISOString(),
      });
      return final;
    },
  };
}

export async function captureAndClassify({
  id, size, metadata, capture, closeWindow,
}) {
  let screenshot = null;
  let captureError = null;
  try {
    screenshot = await capture();
  } catch (error) {
    captureError = String(error?.message ?? error);
  }
  // Take final channel + host evidence only AFTER capture has settled.
  const final = await closeWindow();
  const errors = [...final.errors];
  if (!final.closed || final.raw?.closed !== true) {
    errors.push("Observation window did not close");
  }
  if (final.blocked.length) errors.push("External network or WebSocket attempted");
  errors.push(...(final.raw?.collectionErrors ?? []));
  if (captureError) errors.push(captureError);
  const classified = classify(id, final.raw, size, errors);
  if (!screenshot) {
    classified.passed = false;
    classified.failures.push("screenshot_missing");
  }
  return immutableCopy({
    ...metadata, ...classified,
    raw: final.raw, errors, blocked: final.blocked,
    consoleErrors: final.consoleErrors,
    observedPageSize: final.observedPageSize,
    screenshot,
    observationWindow: {
      browserClosedAt: final.raw?.closedAt ?? null,
      hostClosedAt: final.closedAt,
      captureSettledBeforeClose: true,
    },
  });
}
