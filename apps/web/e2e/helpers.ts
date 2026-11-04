import type { BrowserContext, Page } from "@playwright/test";

/** Records CSP violations and every request URL the page makes. */
export async function observe(context: BrowserContext, page: Page) {
  await context.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const requests: string[] = [];
  page.on("request", request => requests.push(request.url()));
  return {
    requests,
    violations: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp),
  };
}
