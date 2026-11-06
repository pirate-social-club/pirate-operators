// Local test entry only. The deployed operator uses karaoke-audio-runtime.ts.
import runtime, {
  ServiceState as AudioState,
} from "../services/karaoke-audio-runtime.ts";

export class ServiceState extends AudioState {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname === "/__fixture/alarm") {
      if (
        this.env.LOCAL_ONLY !== "pirate-local-skeleton" ||
        this.env.OPERATOR_PROFILE
      )
        return new Response("not_found", { status: 404 });
      const { now } = (await request.json()) as { now: number };
      if (!Number.isSafeInteger(now) || now < this.store.now())
        return new Response("invalid_clock", { status: 400 });
      this.store.set("clock", now);
      await this.alarm();
      return Response.json({ now });
    }
    return super.fetch(request);
  }
}
export default runtime;
