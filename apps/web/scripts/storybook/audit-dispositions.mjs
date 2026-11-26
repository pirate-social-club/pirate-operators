export function reviewedAvatarsFor(ledger, storyId, startedAt) {
  const cutoff = Date.parse(ledger.reviewBefore);
  const started = Date.parse(startedAt);
  if (!Number.isFinite(cutoff) || !Number.isFinite(started) || started >= cutoff) return [];
  return ledger.reviews.filter((review) => review.stories.includes(storyId));
}

// Serialized into the browser. Match the observed button independently of axe's
// shortened HTML snippets so changes to its name or visible text need review.
export function observeReviewedAvatars(reviews) {
  const normalize = (text) => text.trim().replace(/\s+/gu, " ");
  return reviews.flatMap(({ rule, target, name, visibleText, decorativeText }) => {
    const visible = [...document.querySelectorAll(target)].filter((node) =>
      node.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    if (visible.length !== 1) return [];
    const [button] = visible;
    if (button.tagName !== "BUTTON" || button.hasAttribute("aria-labelledby") ||
      ![null, "button"].includes(button.getAttribute("role")) ||
      button.closest('[aria-hidden="true"], [inert]') ||
      button.getAttribute("aria-label") !== name ||
      normalize(button.innerText) !== visibleText) return [];
    const hidden = [...button.querySelectorAll('[aria-hidden="true"]')]
      .map((node) => normalize(node.textContent)).filter(Boolean);
    if (JSON.stringify(hidden) !== JSON.stringify(decorativeText)) return [];
    return [{ rule, target, name, visibleText, decorativeText }];
  });
}

export function countUndispositionedViolations(violations, observedAvatars) {
  const reviewed = [];
  let undispositioned = 0;
  for (const violation of violations) {
    if (!Array.isArray(violation.nodes) || !violation.nodes.length) {
      undispositioned += 1;
      continue;
    }
    for (const node of violation.nodes) {
      const match = observedAvatars.find(({ rule, target, name }) =>
        rule === "label-content-name-mismatch" && rule === violation.id &&
        Array.isArray(node.target) && node.target.length === 1 && node.target[0] === target &&
        typeof node.html === "string" && node.html.includes(` aria-label="${name}"`));
      if (match && !reviewed.includes(match)) reviewed.push(match);
      else undispositioned += 1;
    }
  }
  return { reviewed, undispositioned };
}
