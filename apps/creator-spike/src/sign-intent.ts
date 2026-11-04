import { Transaction } from "@mysten/sui/transactions";
import { coordinatorTransactions as ct, getNetworkConfig } from "@ika.xyz/sdk";
import { hash, unb64 } from "./shared.ts";

export interface SignIntent {
  creator: string;
  operator: string;
  capId: string;
  presignCapId: string;
  ikaCoinId: string;
  suiCoinId: string;
  id: string;
  message: string;
  partialSignature: string;
}
// Reconstruct the complete allowed command/input graph locally. RPC-resolved
// versions and digests may vary; object identities, pure values and commands may not.
export async function validateSignTransaction(
  bytes: Uint8Array,
  intent: SignIntent,
) {
  const config = getNetworkConfig("testnet"),
    expected = new Transaction();
  const coord = expected.sharedObjectRef({
    objectId: config.objects.ikaDWalletCoordinator.objectID,
    initialSharedVersion:
      config.objects.ikaDWalletCoordinator.initialSharedVersion,
    mutable: true,
  });
  const sid = ct.registerSessionIdentifier(
    config,
    coord,
    unb64(await hash(`sign:${intent.id}`)),
    expected,
  );
  const cap = ct.verifyPresignCap(
    config,
    coord,
    expected.object(intent.presignCapId),
    expected,
  );
  const approval = ct.approveMessage(
    config,
    coord,
    expected.object(intent.capId),
    0,
    0,
    unb64(intent.message),
    expected,
  );
  const ika = expected.object(intent.ikaCoinId),
    sui = expected.object(intent.suiCoinId);
  ct.requestSign(
    config,
    coord,
    cap,
    approval,
    unb64(intent.partialSignature),
    sid,
    ika,
    sui,
    expected,
  );
  expected.transferObjects([ika, sui], intent.creator);
  const actual = Transaction.from(bytes).getData(),
    wanted = expected.getData();
  if (
    actual.sender !== intent.creator ||
    actual.gasData.owner !== intent.operator ||
    BigInt(actual.gasData.budget ?? 0) > 100_000_000n ||
    BigInt(actual.gasData.budget ?? 0) <= 0n
  )
    throw new Error("Unexpected transaction sender or gas sponsor.");
  function normalized(inputs: typeof actual.inputs) {
    return inputs.map((input) => {
      if (input.Pure) return { pure: input.Pure.bytes };
      if (input.UnresolvedObject)
        return { object: input.UnresolvedObject.objectId };
      if (input.Object?.ImmOrOwnedObject)
        return { object: input.Object.ImmOrOwnedObject.objectId };
      if (input.Object?.SharedObject)
        return {
          shared: {
            ...input.Object.SharedObject,
            initialSharedVersion: String(
              input.Object.SharedObject.initialSharedVersion,
            ),
          },
        };
      throw new Error("Unexpected transaction input.");
    });
  }
  // The SDK deduplicates pure inputs during build. Compare semantic arguments,
  // rather than their pre-build input indices, while preserving result edges.
  function commandGraph(data: typeof actual) {
    const inputs = normalized(data.inputs);
    const arg = (a: {
      Input?: number;
      Result?: number;
      NestedResult?: [number, number];
      GasCoin?: true;
    }) => {
      if (a.Input !== undefined) return inputs[a.Input];
      if (a.Result !== undefined) return { result: a.Result };
      if (a.NestedResult) return { nested: a.NestedResult };
      throw new Error("Unexpected transaction argument.");
    };
    return data.commands.map((c) => {
      if (c.MoveCall)
        return {
          call: [c.MoveCall.package, c.MoveCall.module, c.MoveCall.function],
          types: c.MoveCall.typeArguments,
          args: c.MoveCall.arguments.map(arg),
        };
      if (c.TransferObjects)
        return {
          transfer: c.TransferObjects.objects.map(arg),
          to: arg(c.TransferObjects.address),
        };
      throw new Error("Unexpected transaction command.");
    });
  }
  const inputSet = (data: typeof actual) =>
    JSON.stringify(
      [
        ...new Set(normalized(data.inputs).map((x) => JSON.stringify(x))),
      ].sort(),
    );
  if (
    inputSet(actual) !== inputSet(wanted) ||
    JSON.stringify(commandGraph(actual)) !==
      JSON.stringify(commandGraph(wanted))
  )
    throw new Error(
      "Sponsored transaction does not match this test signature.",
    );
}
