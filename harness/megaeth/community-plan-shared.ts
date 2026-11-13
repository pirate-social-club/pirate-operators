import { encodeDeployData, keccak256, type Abi, type Address, type Hex } from "viem";
import { insist } from "../../packages/community/common.ts";
import { address, chain } from "../../packages/community/manifest-core.ts";

// Actual compiled artifact supplied and pinned by Root's later gate. No bytecode,
// live gas price, account, nonce, maximum age or deployment address default.
export function sharedCommunityPlan(input: { profile: "pirate.shared-directory/2"; chainId: number;
  admin: Address; maxVerificationAge: bigint; artifact: { abi: Abi; bytecode: Hex };
  approvedCreationCodeHash: Hex; gas: bigint; maxFeePerGas: bigint }) {
  insist(input.profile === "pirate.shared-directory/2", "explicit_shared_profile_required");
  chain(input.chainId); address(input.admin);
  insist(input.maxVerificationAge > 0n && input.maxVerificationAge <= 86400n && input.gas > 0n && input.maxFeePerGas > 0n,
    "explicit_deployment_limits_required");
  insist(input.artifact.bytecode.length > 2 && keccak256(input.artifact.bytecode) === input.approvedCreationCodeHash,
    "directory_artifact_changed");
  const constructors = input.artifact.abi.filter((item) => item.type === "constructor");
  insist(constructors.length === 1 && constructors[0]!.inputs.length === 2 &&
    constructors[0]!.inputs[0]!.type === "address" && constructors[0]!.inputs[1]!.type === "uint64",
    "directory_constructor_abi_changed");
  return { profile: input.profile, chainId: input.chainId, admin: input.admin,
    data: encodeDeployData({ abi: input.artifact.abi, bytecode: input.artifact.bytecode,
      args: [input.admin, input.maxVerificationAge] }), gas: input.gas, maxFeePerGas: input.maxFeePerGas,
    maximumGasCost: input.gas * input.maxFeePerGas, execution: "not-authorized" as const };
}
