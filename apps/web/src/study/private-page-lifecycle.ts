// Independently owned from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db
// src/features/notifications/private-page-lifecycle.ts. Session refresh is an
// injected owned-service read, rather than the centralized session singleton.
let lastRestoration: Event | undefined;
export function bindLearningPageLifecycle(
  clear: () => void,
  refresh: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const restore = (event: PageTransitionEvent) => {
    if (!event.persisted || lastRestoration === event) return;
    lastRestoration = event;
    refresh();
  };
  window.addEventListener("pagehide", clear);
  window.addEventListener("pageshow", restore);
  return () => {
    window.removeEventListener("pagehide", clear);
    window.removeEventListener("pageshow", restore);
  };
}
