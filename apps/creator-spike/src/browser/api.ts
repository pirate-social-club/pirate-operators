export async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(
    `/api/${path}`,
    body === undefined
      ? { credentials: "same-origin" }
      : {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(value.error ?? `Request failed (${r.status})`);
  return value;
}
export async function poll<T>(
  read: () => Promise<T>,
  ready: (v: T) => boolean,
  status: (text: string) => void,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const v = await read();
    if (ready(v)) return v;
    status(label);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    "The network is taking longer than expected. Retry this step to reconcile the same request.",
  );
}
