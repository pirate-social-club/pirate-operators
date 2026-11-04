import { workers, accounts } from "./runtime.ts";
import { chain } from "./chain.ts";
import { runFlow } from "./flow.ts";
let evm: Awaited<ReturnType<typeof chain>> | undefined;
let runtime: Awaited<ReturnType<typeof workers>> | undefined;
try {
  evm = await chain();
  const running = evm;
  runtime = await workers(undefined, {
    rpcUrl: running.rpcUrl,
    paymentToken: running.paymentToken,
    paymentsContract: running.paymentsContract,
  });
  await runFlow({
    runtime,
    accounts,
    windowSeconds: 60,
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
  if (runtime) await runtime.mf.dispose();
  if (evm) {
    evm.child.kill();
    await new Promise<void>((resolve) => {
      if (evm!.child.exitCode !== null) resolve();
      else evm!.child.once("exit", () => resolve());
    });
  }
}
