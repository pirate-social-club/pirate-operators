// Manual, opt-in MegaETH testnet deployment of OperatorPayments
// (docs/operator-payments.md). Never runs in CI. Chain 6343 only; keys are
// read from a private file outside the repository and never printed. It
// writes only public addresses, transaction hashes and reads as evidence.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseEther,
  stringToBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check } from "../../packages/protocol/index.ts";
import {
  purchaseDomain,
  purchaseMessage,
  purchaseTypes,
  unitHash,
  type Purchase,
} from "../../packages/protocol/payments.ts";
import { compile } from "../compile.ts";

const RPC = process.env.MEGAETH_RPC ?? "https://carrot.megaeth.com/rpc";
const KEYS = process.env.MEGAETH_KEYS ?? join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json");
const PT_USD = "0xC5321666F425812D1C12F44dA7BFe08CEB00044B" as Address;
const DEPOSIT = 500_000_000n; // 500 ptUSD, six decimals, no value
const OPERATOR_GAS = parseEther("0.02");

const megaeth = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const transport = http(RPC, { timeout: 20_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: megaeth, transport });

async function main() {
  check((await publicClient.getChainId()) === 6343, "refusing_non_megaeth_testnet_chain");
  const file = JSON.parse(readFileSync(KEYS, "utf8")) as {
    chainId: number;
    keys: Record<"communityAdmin" | "purchaseSigner" | "operator", Hex>;
  };
  check(file.chainId === 6343, "keys_not_for_megaeth_testnet");
  const admin = privateKeyToAccount(file.keys.communityAdmin);
  const signer = privateKeyToAccount(file.keys.purchaseSigner);
  const operator = privateKeyToAccount(file.keys.operator);
  const adminBalance = await publicClient.getBalance({ address: admin.address });
  check(adminBalance >= parseEther("0.03"), `fund_community_admin:${admin.address}`);

  const artifacts = compile();
  const adminWallet = createWalletClient({ chain: megaeth, transport, account: admin });
  const operatorWallet = createWalletClient({ chain: megaeth, transport, account: operator });
  const transactions: { step: string; hash: Hex; gasUsed: string; block: string }[] = [];
  const confirm = async (step: string, hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    check(receipt.status === "success", `transaction_reverted:${step}`);
    transactions.push({ step, hash, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() });
    return receipt;
  };
  const payments = artifacts.OperatorPayments;
  const token = artifacts.TestPaymentToken.abi; // standard mint/approve/transfer shapes

  const deployed = await confirm(
    "deploy_operator_payments",
    await adminWallet.deployContract({ abi: payments.abi, bytecode: payments.bytecode, args: [] }),
  );
  const contract = deployed.contractAddress!;
  if ((await publicClient.getBalance({ address: operator.address })) < OPERATOR_GAS / 2n)
    await confirm(
      "fund_operator_gas",
      await adminWallet.sendTransaction({ to: operator.address, value: OPERATOR_GAS }),
    );
  await confirm(
    "mint_test_usd",
    await adminWallet.writeContract({ address: PT_USD, abi: token, functionName: "mint", args: [admin.address, DEPOSIT] }),
  );
  await confirm(
    "approve_deposit",
    await adminWallet.writeContract({ address: PT_USD, abi: token, functionName: "approve", args: [contract, DEPOSIT] }),
  );
  await confirm(
    "deposit",
    await adminWallet.writeContract({
      address: contract,
      abi: payments.abi,
      functionName: "deposit",
      args: [admin.address, PT_USD, DEPOSIT],
    }),
  );
  await confirm(
    "set_signer",
    await adminWallet.writeContract({ address: contract, abi: payments.abi, functionName: "setSigner", args: [signer.address] }),
  );

  // One smoke purchase, redeemed by the operator, then a ticket closure.
  const block = await publicClient.getBlock();
  const now = Number(block.timestamp);
  const ticketId = keccak256(stringToBytes(`megaeth-smoke-ticket:${now}`));
  const purchase: Purchase = {
    community: admin.address,
    unit: unitHash(`segment:${ticketId}:seg-01:0`),
    ticketId,
    quoteId: keccak256(stringToBytes("megaeth-smoke-quote")),
    operator: operator.address,
    recipient: operator.address,
    token: PT_USD,
    amount: "1000",
    validAfter: now - 300,
    expiresAt: now + 600,
  };
  const signature = await signer.signTypedData({
    domain: purchaseDomain(6343, contract),
    types: purchaseTypes,
    primaryType: "Purchase",
    message: purchaseMessage(purchase),
  });
  const operatorBefore = (await publicClient.readContract({
    address: PT_USD,
    abi: token,
    functionName: "balanceOf",
    args: [operator.address],
  })) as bigint;
  await confirm(
    "smoke_redeem",
    await operatorWallet.writeContract({
      address: contract,
      abi: payments.abi,
      functionName: "redeem",
      args: [purchaseMessage(purchase), signature],
    }),
  );
  await confirm(
    "smoke_close_ticket",
    await operatorWallet.writeContract({
      address: contract,
      abi: payments.abi,
      functionName: "closeTicket",
      args: [admin.address, ticketId],
    }),
  );

  // Independent reads of what the transactions should have left behind.
  const read = (functionName: string, args: readonly unknown[] = []) =>
    publicClient.readContract({ address: contract, abi: payments.abi, functionName, args });
  const expectedDomain = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [
        keccak256(stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        keccak256(stringToBytes("Pirate Operator Payments")),
        keccak256(stringToBytes("1")),
        6343n,
        contract,
      ],
    ),
  );
  const verified = {
    domainSeparator: (await read("DOMAIN_SEPARATOR")) === expectedDomain,
    signer: ((await read("signer", [admin.address])) as string).toLowerCase() === signer.address.toLowerCase(),
    deposit: ((await read("balance", [admin.address, PT_USD])) as bigint) === DEPOSIT - 1000n,
    smokeRedeemed: (await read("redemption", [admin.address, purchase.unit])) !== `0x${"0".repeat(64)}`,
    smokeClosed: (await read("closed", [admin.address, ticketId, operator.address])) === true,
    operatorPaid:
      ((await publicClient.readContract({
        address: PT_USD,
        abi: token,
        functionName: "balanceOf",
        args: [operator.address],
      })) as bigint) === operatorBefore + 1000n,
  };
  check(Object.values(verified).every(Boolean), `verification_failed:${JSON.stringify(verified)}`);
  const code = await publicClient.getCode({ address: contract });
  const evidence = {
    kind: "megaeth-operator-payments-testnet",
    recordedAt: new Date().toISOString(),
    chainId: 6343,
    rpc: RPC,
    contract,
    runtimeCodeHash: keccak256(code!),
    token: PT_USD,
    community: admin.address,
    purchaseSigner: signer.address,
    operator: operator.address,
    deposit: DEPOSIT.toString(),
    transactions,
    verified,
    remainingAdminEth: formatEther(await publicClient.getBalance({ address: admin.address })),
    remainingOperatorEth: formatEther(await publicClient.getBalance({ address: operator.address })),
  };
  mkdirSync("docs/evidence", { recursive: true });
  const path = `docs/evidence/megaeth-operator-payments-${evidence.recordedAt.slice(0, 10)}.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ evidence: path, contract, verified }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
