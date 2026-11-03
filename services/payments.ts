import {
  check,
  digest,
  jobTransition,
  type JobState,
} from "../packages/protocol/index.ts";
import { body, call, type Env, type Store } from "./runtime.ts";

interface Job {
  state: JobState;
  ceiling: number;
  charged: number;
  units?: number;
}
export async function payer(request: Request, env: Env, store: Store) {
  const path = new URL(request.url).pathname;
  const input = await body<{ jobId: string; ceiling: number; units: number }>(
    request,
  );
  check(
    typeof input.jobId === "string" && input.jobId.length < 100,
    "invalid_job",
  );
  const key = `job:${input.jobId}`;
  if (path === "/reserve") {
    check(
      Number.isSafeInteger(input.ceiling) && input.ceiling > 0,
      "invalid_ceiling",
    );
    const old = store.get<Job>(key);
    if (old) {
      check(old.ceiling === input.ceiling, "idempotency_conflict");
      return Response.json(old);
    }
    const exposure = store.get<number>("exposure") ?? 0;
    check(exposure + input.ceiling <= 1000, "community_budget_exhausted");
    store.set("exposure", exposure + input.ceiling);
    const job: Job = {
      state: jobTransition("new", "reserve"),
      ceiling: input.ceiling,
      charged: 0,
    };
    store.set(key, job);
    return Response.json(job);
  }
  const job = store.get<Job>(key);
  check(job, "unreserved_job");
  if (path === "/charge") {
    check(
      Number.isSafeInteger(input.units) &&
        input.units > 0 &&
        input.units <= job.ceiling,
      "ceiling_exceeded",
    );
    if (job.units !== undefined)
      check(job.units === input.units, "idempotency_conflict");
    // Durable intent precedes the external side effect. An unknown result remains reserved.
    store.set(key, { ...job, units: input.units });
    const receipt = await call<{ charged: number }>(env.PROVIDER, "/charge", {
      jobId: input.jobId,
      units: input.units,
    });
    const current = store.get<Job>(key)!;
    check(receipt.charged === input.units, "invalid_receipt");
    if (current.state === "reserved") {
      current.state = jobTransition(current.state, "charge");
      current.charged = receipt.charged;
      store.set(
        "exposure",
        (store.get<number>("exposure") ?? 0) -
          current.ceiling +
          current.charged,
      );
      store.set(key, current);
    }
    return Response.json({ charged: current.charged });
  }
  if (path === "/delivered") {
    if (job.state !== "delivered") {
      job.state = jobTransition(job.state, "deliver");
      store.set(key, job);
    }
    return Response.json(job);
  }
  return new Response("not_found", { status: 404 });
}
export async function provider(request: Request, store: Store) {
  const path = new URL(request.url).pathname;
  if (path === "/__lose-next") {
    store.set("loseNext", true);
    return Response.json({ armed: true });
  }
  check(path === "/charge", "unknown_provider_method");
  const { jobId, units } = await body<{ jobId: string; units: number }>(
    request,
  );
  check(Number.isSafeInteger(units) && units > 0, "invalid_charge");
  const key = `charge:${jobId}`;
  const existing = store.get<{ units: number }>(key);
  if (existing) check(existing.units === units, "idempotency_conflict");
  else store.set(key, { units, receipt: digest({ jobId, units }) });
  if (store.get<boolean>("loseNext")) {
    store.set("loseNext", false);
    return Response.json({ error: "simulated_response_lost" }, { status: 503 });
  }
  return Response.json({ charged: units });
}
