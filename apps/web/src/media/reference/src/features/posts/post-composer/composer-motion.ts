const composerBarEasing = "cubic-bezier(0.22, 1, 0.36, 1)";

function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function animateComposerBarEnter(
  element: HTMLElement | undefined,
): void {
  if (!element || !motionAllowed() || typeof element.animate !== "function")
    return;
  element.animate(
    [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }],
    { duration: 240, easing: composerBarEasing, fill: "both" },
  );
}
