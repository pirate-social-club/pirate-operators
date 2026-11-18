import assert from "node:assert/strict";
import test from "node:test";
import { createWeb2SetupLifetime } from "../deploy/linux/web2-service.ts";

test("shutdown waits for late activation and does not start a first grant after setup admission closes", async () => {
  const setup = createWeb2SetupLifetime();
  const activation = Promise.withResolvers<void>();
  const events: string[] = [];
  const apply = setup.exclusive(async () => {
    await activation.promise;
    events.push("activation-owned");
    setup.running(() => { events.push("composer-start"); });
  });
  const stop = setup.shutdown(async () => { events.push("app-stop"); }, async () => {
    events.push("composer-drain");
  });
  await assert.rejects(setup.exclusive(async () => assert.fail("admitted after shutdown")), /web2_setup_closed_or_busy/);
  assert.deepEqual(events, []);
  activation.resolve();
  await Promise.all([apply, stop]);
  assert.deepEqual(events, ["activation-owned", "composer-drain", "app-stop"]);
});

test("shutdown holds the app on a failed first-grant drain and retries that drain with setup closed", async () => {
  const setup = createWeb2SetupLifetime();
  const composer = Promise.withResolvers<void>();
  const draining = Promise.withResolvers<void>();
  const attempts: string[] = [];
  await setup.exclusive(async () => {
    setup.running(() => { attempts.push("composer-start"); });
  });
  async function stopApp() { attempts.push("app-stop"); }
  const shutdown = setup.shutdown(stopApp, async () => {
    attempts.push("composer-drain");
    draining.resolve();
    await composer.promise;
  });
  const failure = assert.rejects(shutdown, /drain unresolved/);
  await draining.promise;
  await assert.rejects(setup.exclusive(async () => assert.fail("admitted while draining")), /web2_setup_closed_or_busy/);
  assert.deepEqual(attempts, ["composer-start", "composer-drain"]);
  composer.reject(Error("drain unresolved"));
  await failure;
  assert.deepEqual(attempts, ["composer-start", "composer-drain"]);
  await setup.shutdown(stopApp, async () => { attempts.push("retry-drain"); });
  assert.deepEqual(attempts, ["composer-start", "composer-drain", "retry-drain", "app-stop"]);
});
