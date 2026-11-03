import { workers, accounts } from "./runtime.ts";
import { chain } from "./chain.ts";
import { runFlow } from "./flow.ts";
const runtime = await workers();
let evm: Awaited<ReturnType<typeof chain>> | undefined;
try {
  evm = await chain();
  const running = evm;
  await runFlow({
    runtime,
    accounts,
    evm: {
      ...running,
      timestamp: async () =>
        Number((await running.publicClient.getBlock()).timestamp),
      advanceTo: async (now) => {
        await running.rpc("evm_setNextBlockTimestamp", [now]);
        await running.rpc("evm_mine", []);
      },
    },
    log: (step, state) => console.log(JSON.stringify({ step, state })),
  });
} finally {
  await runtime.mf.dispose();
  if (evm) {
    evm.child.kill();
    await new Promise<void>((resolve) => {
      if (evm!.child.exitCode !== null) resolve();
      else evm!.child.once("exit", () => resolve());
    });
  }
}
