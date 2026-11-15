// Directory enrollment only. Member issuance remains the Naming lane and uses
// the accepted registry SDK/ABI; Story root registration stays in its own module.
import { decodeEventLog, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress,
  TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionSerializedEIP1559 } from "viem";
import { canonical, hashText, insist } from "./common.ts";
import { address, ipfsUri } from "./manifest-core.ts";
import { sharedBinding, sharedDirectoryAbi, validateSharedProfile, type SharedDirectoryProfile } from "./shared-directory.ts";
import { validateSharedConfig } from "./shared-config-manifest.ts";
import type { SharedCommunityConfig } from "./config-manifest.ts";
import { sharedBytes32 } from "./shared-identity.ts";

export interface SharedRegistrationPlan {
  schema: "pirate.shared-directory-registration/1";
  profile: SharedDirectoryProfile;
  admin: Address;
  config: SharedCommunityConfig;
  uri: string;
  data: Hex;
  commitment: Hex;
}
export function prepareSharedRegistration(profile: SharedDirectoryProfile, value: unknown, uri: string, admin: Address): SharedRegistrationPlan {
  const p = validateSharedProfile(profile), config = validateSharedConfig(value, p);
  insist(config.configurationRevision === 1 && config.publisherRevocations.length === 0, "initial_configuration_required");
  const reference = ipfsUri(uri), actor = address(admin);
  const data = encodeFunctionData({ abi: sharedDirectoryAbi, functionName: "registerSharedCommunity", args: [p.registry, p.tld,
    sharedBinding(p), { controller: config.controller, publisher: config.publisher, operatorPayments: config.operatorPayments,
      learningRecords: config.learningRecords, sha256Digest: hashText(canonical(config)), uri: reference }] });
  const commitment = hashText(canonical({ schema: "pirate.shared-directory-registration/1", profile: { ...p, deploymentBlock: String(p.deploymentBlock) },
    admin: actor, config, uri: reference, data }));
  // Both validators reconstruct owned values. Freeze this known shape explicitly
  // so a caller cannot change nested identity/configuration after an await.
  Object.freeze(p);
  Object.freeze(config.app);
  Object.freeze(config.feed);
  Object.freeze(config.policies.admission);
  Object.freeze(config.policies);
  for (const revocation of config.publisherRevocations) Object.freeze(revocation);
  Object.freeze(config.publisherRevocations);
  Object.freeze(config);
  const plan: SharedRegistrationPlan = {
    schema: "pirate.shared-directory-registration/1", profile: p, admin: actor, config, uri: reference, data, commitment,
  };
  return Object.freeze(plan);
}
export interface OriginalDirectoryTransaction {
  schema: "pirate.shared-directory-original/1";
  plan: SharedRegistrationPlan;
  rawTransaction: Hex;
  transactionHash: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
export async function bindSharedRegistrationTransaction(plan: SharedRegistrationPlan, rawTransaction: Hex,
  limits: { nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<OriginalDirectoryTransaction> {
  const exact = prepareSharedRegistration(plan.profile, plan.config, plan.uri, plan.admin);
  insist(plan.schema === exact.schema && plan.commitment === exact.commitment && plan.data === exact.data, "registration_plan_changed");
  // Copy only permitted primitive fields before the first await. Structural
  // typing does not prevent callers/journals from supplying extra properties.
  const { nonce, gas, maxFeePerGas, maxPriorityFeePerGas } = limits;
  insist(typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0 &&
    typeof gas === "bigint" && gas > 0n && typeof maxFeePerGas === "bigint" && maxFeePerGas > 0n &&
    typeof maxPriorityFeePerGas === "bigint" && maxPriorityFeePerGas >= 0n && maxPriorityFeePerGas <= maxFeePerGas,
    "explicit_transaction_limits_required");
  const parsed = parseTransaction(rawTransaction);
  insist(parsed.type === "eip1559" && parsed.chainId === exact.profile.chainId && parsed.to?.toLowerCase() === exact.profile.directory &&
    parsed.data === exact.data && (parsed.value ?? 0n) === 0n && parsed.nonce === nonce && parsed.gas === gas &&
    parsed.maxFeePerGas === maxFeePerGas && parsed.maxPriorityFeePerGas === maxPriorityFeePerGas &&
    (await recoverTransactionAddress({ serializedTransaction: rawTransaction as TransactionSerializedEIP1559 })).toLowerCase() === exact.admin,
    "original_directory_transaction_mismatch");
  const operation: OriginalDirectoryTransaction = {
    schema: "pirate.shared-directory-original/1", plan: exact, rawTransaction,
    transactionHash: keccak256(rawTransaction), nonce, gas, maxFeePerGas, maxPriorityFeePerGas,
  };
  return Object.freeze(operation);
}
export async function observeSharedRegistration(client: PublicClient, original: OriginalDirectoryTransaction) {
  // Capture the saved expectation once; the binder synchronously reconstructs
  // and freezes the plan before its own first await. Never read original again.
  const { schema, transactionHash, plan, rawTransaction, nonce, gas, maxFeePerGas, maxPriorityFeePerGas } = original;
  insist(schema === "pirate.shared-directory-original/1", "unsupported_original_operation");
  const operation = await bindSharedRegistrationTransaction(plan, rawTransaction, { nonce, gas, maxFeePerGas, maxPriorityFeePerGas });
  insist(transactionHash === operation.transactionHash, "original_directory_transaction_mismatch");
  const p = operation.plan.profile;
  insist((await client.getChainId()) === p.chainId, "wrong_application_chain");
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try { receipt = await client.getTransactionReceipt({ hash: operation.transactionHash }); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return { status: "pending" as const, original: operation }; throw error; }
  // Match the registry's safe-block convention, including its inclusive boundary.
  // Missing/unsupported safe tags propagate refusal; never fall back to latest.
  const [safe, block, code] = await Promise.all([client.getBlock({ blockTag: "safe" }),
    client.getBlock({ blockNumber: receipt.blockNumber }), client.getCode({ address: p.directory, blockNumber: receipt.blockNumber })]);
  insist(typeof safe.number === "bigint" && safe.number >= 0n && typeof safe.hash === "string", "directory_safe_block_unavailable");
  const safeNumber = safe.number, safeHash = sharedBytes32(safe.hash);
  insist(code && keccak256(code) === p.directoryCodeHash && block.hash === receipt.blockHash &&
    receipt.blockNumber >= p.deploymentBlock && block.number === receipt.blockNumber &&
    receipt.transactionHash === operation.transactionHash && receipt.to?.toLowerCase() === p.directory &&
    receipt.from.toLowerCase() === operation.plan.admin, "directory_receipt_authentication_failed");
  if (receipt.blockNumber > safeNumber) return { status: "pending" as const, original: operation };
  async function finish() {
    const [originalBlock, confirmation] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlock({ blockNumber: safeNumber }),
    ]);
    insist(originalBlock.number === receipt.blockNumber && originalBlock.hash === receipt.blockHash &&
      confirmation.number === safeNumber && confirmation.hash === safeHash, "directory_chain_reorganized");
  }
  if (receipt.status === "reverted") {
    await finish();
    return { status: "reverted" as const, original: operation, receipt };
  }
  insist(receipt.status === "success", "directory_receipt_status_unknown");
  const bound = [], published = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== p.directory) continue;
    insist(log.blockHash === receipt.blockHash && log.transactionHash === receipt.transactionHash &&
      log.blockNumber === receipt.blockNumber && log.removed !== true, "directory_receipt_authentication_failed");
    try {
      const decoded = decodeEventLog({ abi: sharedDirectoryAbi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === "CommunityBound" && decoded.args.communityId === p.communityId) bound.push(decoded.args.binding);
      if (decoded.eventName === "ConfigurationPublished" && decoded.args.communityId === p.communityId && decoded.args.revision === 1n)
        published.push(decoded.args);
    } catch { continue; }
  }
  insist(bound.length === 1 && canonical(bound[0]) === canonical(sharedBinding(p)) && published.length === 1,
    "directory_registration_event_missing");
  const config = operation.plan.config, event = published[0]!;
  insist(event.sha256Digest === hashText(canonical(config)) && event.uri === operation.plan.uri &&
    event.controller.toLowerCase() === config.controller && event.publisher.toLowerCase() === config.publisher &&
    event.operatorPayments.toLowerCase() === config.operatorPayments && event.learningRecords.toLowerCase() === config.learningRecords,
    "directory_registration_event_mismatch");
  await finish();
  // Durable original fact, independent of later publisher/controller changes.
  return { status: "consumed" as const, original: operation, receipt, communityId: p.communityId };
}
