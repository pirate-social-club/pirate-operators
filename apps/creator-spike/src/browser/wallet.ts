import { SuiGrpcClient } from "@mysten/sui/grpc";
import { validateFixedSignMessage } from "../sign-message.ts";
import {
  IkaClient,
  getNetworkConfig,
  UserShareEncryptionKeys,
  prepareDKGAsync,
  Curve,
  Hash,
  SignatureAlgorithm,
  userAndNetworkDKGOutputMatch,
  publicKeyFromDWalletOutput,
  createUserSignMessageWithPublicOutput,
  CoordinatorInnerModule as C,
} from "@ika.xyz/sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { publicKeyToAddress } from "viem/accounts";
import { bytesToHex } from "viem";
import {
  b64,
  unb64,
  sameBytes,
  suiUrl,
  communityOrigin,
  walletOrigin,
  hash,
  utf8,
  type WalletRecord,
} from "../shared.ts";
import { unlock, signer } from "./passkey.ts";
import { api, poll } from "./api.ts";
import { validateSignTransaction } from "../sign-intent.ts";
import {
  activationWrappingKey,
  openActivation,
  sealActivation,
  type SealedActivation,
} from "../activation-vault.ts";

const sui = new SuiGrpcClient({ network: "testnet", baseUrl: suiUrl }),
  config = getNetworkConfig("testnet");
const ika = new IkaClient({ suiClient: sui, config });
const request = new URL(location.href).searchParams.get("request");
let scopedConnection = false,
  returnOrigin = communityOrigin;
const connectionReady = request
  ? api<{
      scoped: boolean;
      communityOrigin: string;
      purpose?: string;
      connectionId?: string;
    }>(`connection?request=${encodeURIComponent(request)}`).then((info) => {
      const origin = new URL(info.communityOrigin);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== info.communityOrigin
      )
        throw new Error("The requesting community could not be verified.");
      scopedConnection = info.scoped;
      returnOrigin = origin.origin;
      if (scopedConnection) {
        const intro = document.querySelector<HTMLElement>(".intro")!;
        intro.textContent = `${info.purpose} Requesting community: ${returnOrigin}`;
        document.querySelector<HTMLAnchorElement>(".wordmark")!.href =
          returnOrigin;
        document.querySelector("footer")!.textContent =
          "Creator setup uses capped operator funding. Reopening an active wallet does not create another wallet.";
      }
      return info;
    })
  : Promise.resolve(null);
let keys: UserShareEncryptionKeys | undefined, wallet: WalletRecord | undefined;
let activationKey: CryptoKey | undefined;
interface SetupIntent {
  network: string;
  operator: string;
  creator: string;
  networkKeyId: string;
  session: string;
  origin: string;
  encryptionKeyHash: string;
  signingKey: string;
  maxIka: string;
  maxSui: string;
  expires: number;
  packages: unknown;
}
let activationWork:
  | {
      intent: SetupIntent;
      prepared: Pick<
        Awaited<ReturnType<typeof prepareDKGAsync>>,
        "userDKGMessage" | "userPublicOutput" | "encryptedUserShareAndProof"
      >;
      consentSignature: string;
      attemptId: string;
      recovery?: SealedActivation;
    }
  | undefined;
let retryStep: (() => Promise<void>) | undefined;
const status = document.querySelector<HTMLElement>("#status")!;
const setStatus = (text: string) => {
  status.textContent = text;
};
void connectionReady.catch((error) =>
  setStatus(
    error instanceof Error
      ? error.message
      : "The community connection could not be verified.",
  ),
);
const details = document.querySelector<HTMLElement>("#details")!;
const button = (id: string) =>
  document.querySelector<HTMLButtonElement>(`#${id}`)!;
function showWallet(w: WalletRecord) {
  details.textContent = `Creator address\n${w.evmAddress ?? "Pending activation"}\n\nSui passkey address\n${w.suiAddress}${w.dWalletId ? `\n\ndWallet\n${w.dWalletId}` : ""}`;
}
async function confirm(w: WalletRecord, active: boolean) {
  if (!w.dWalletId || !w.capId || !w.shareId)
    throw new Error("Missing saved wallet objects.");
  const [d, share, cap] = await Promise.all([
    ika.getDWallet(w.dWalletId),
    ika.getEncryptedUserSecretKeyShare(w.shareId),
    sui.getObject({ objectId: w.capId, include: { content: true } }),
  ]);
  if (
    cap.object.owner.$kind !== "AddressOwner" ||
    cap.object.owner.AddressOwner !== w.suiAddress ||
    C.DWalletCap.parse(cap.object.content).dwallet_id !== w.dWalletId ||
    d.dwallet_cap_id !== w.capId ||
    d.public_user_secret_key_share !== null ||
    d.curve !== 0 ||
    d.is_imported_key_dwallet ||
    share.dwallet_id !== w.dWalletId ||
    share.encryption_key_address !== keys?.getSuiAddress()
  )
    throw new Error(
      "On-chain ownership or encryption binding did not match this passkey.",
    );
  if (
    active &&
    (d.state.$kind !== "Active" || share.state.$kind !== "KeyHolderSigned")
  )
    throw new Error("The wallet is not active on-chain.");
  return { d, share };
}
async function start(register: boolean) {
  await connectionReady;
  if (!request)
    throw new Error("Start from Release a song on the community page.");
  setStatus(
    register
      ? "Save a creator passkey. Your browser will ask for confirmation."
      : "Unlock your saved creator passkey.",
  );
  const unlocked = await unlock(request, register);
  wallet = unlocked.wallet;
  setStatus("Unlocking your encrypted wallet…");
  try {
    activationKey = await activationWrappingKey(
      unlocked.seed,
      wallet.credentialId,
    );
    keys = await UserShareEncryptionKeys.fromRootSeedKey(
      unlocked.seed,
      Curve.SECP256K1,
    );
  } finally {
    unlocked.seed.fill(0);
  }
  button("create").hidden = true;
  button("unlock").hidden = true;
  showWallet(wallet);
  if (wallet.status === "active") {
    await confirm(wallet, true);
    setStatus(
      scopedConnection
        ? "Wallet reopened. Confirm the connection to return to your community."
        : "Wallet reopened. Ready to sign the test message.",
    );
    button("sign").hidden = scopedConnection;
    button("finish").hidden = false;
  } else {
    await activate();
  }
}
async function activate() {
  if (!keys || !wallet || !activationKey)
    throw new Error("Unlock the passkey first.");
  if (!activationWork) {
    setStatus("Reserving testnet fees…");
    const r = await api<{
      intent: SetupIntent;
      consentMessage: string;
      attempt: { id: string };
    }>("activation/reserve", {
      request,
      encryptionKey: b64(keys.encryptionKey),
      signingKey: b64(keys.getSigningPublicKeyBytes()),
    });
    if (
      r.intent.network !== "testnet" ||
      r.intent.creator !== wallet.suiAddress ||
      r.intent.origin !== walletOrigin ||
      r.intent.encryptionKeyHash !== (await hash(keys.encryptionKey)) ||
      r.intent.signingKey !== b64(keys.getSigningPublicKeyBytes()) ||
      r.intent.maxIka !== "22000000000" ||
      r.intent.maxSui !== "600000000" ||
      JSON.stringify(r.intent.packages) !== JSON.stringify(config.packages) ||
      r.consentMessage !== JSON.stringify(r.intent)
    )
      throw new Error(
        "Activation intent does not match this creator and testnet budget.",
      );
    const cfg = await api<{ operatorAddress: string }>("config");
    if (cfg.operatorAddress !== r.intent.operator)
      throw new Error("Operator binding mismatch.");
    const retained = await api<{ recovery: SealedActivation | null }>(
      "activation/recovery",
      { request },
    );
    if (retained.recovery) {
      const recovered = await openActivation(
        activationKey,
        wallet.credentialId,
        r.attempt.id,
        retained.recovery,
      );
      activationWork = {
        intent: r.intent,
        attemptId: r.attempt.id,
        consentSignature: recovered.consentSignature,
        prepared: {
          userDKGMessage: unb64(recovered.message),
          userPublicOutput: unb64(recovered.publicOutput),
          encryptedUserShareAndProof: unb64(recovered.encryptedShare),
        },
        recovery: retained.recovery,
      };
    } else {
      if (r.intent.expires < Date.now())
        throw new Error(
          "The unused activation authorization expired. No new fee was sent.",
        );
      setStatus(
        "Confirm creation of this testnet wallet with your creator passkey.",
      );
      const consent = await signer(wallet).signPersonalMessage(
        utf8.encode(r.consentMessage),
      );
      const dkgClient = new IkaClient({
        suiClient: sui,
        config,
        encryptionKeyOptions: { encryptionKeyID: r.intent.networkKeyId },
      });
      setStatus("Preparing and securely saving your wallet recovery proof…");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const prepared = await prepareDKGAsync(
        dkgClient,
        Curve.SECP256K1,
        keys,
        unb64(r.intent.session),
        r.intent.operator,
      );
      activationWork = {
        intent: r.intent,
        attemptId: r.attempt.id,
        prepared: {
          userDKGMessage: prepared.userDKGMessage,
          userPublicOutput: prepared.userPublicOutput,
          encryptedUserShareAndProof: prepared.encryptedUserShareAndProof,
        },
        consentSignature: consent.signature,
      };
      prepared.userSecretKeyShare.fill(0);
    }
  }
  // Persist encrypted local DKG proof before the funded endpoint can run.
  // A page close or lost response reopens these same bytes with the passkey.
  if (!activationWork.recovery)
    activationWork.recovery = await sealActivation(
      activationKey,
      wallet.credentialId,
      activationWork.attemptId,
      {
        consentSignature: activationWork.consentSignature,
        message: b64(activationWork.prepared.userDKGMessage),
        publicOutput: b64(activationWork.prepared.userPublicOutput),
        encryptedShare: b64(activationWork.prepared.encryptedUserShareAndProof),
      },
    );
  await api("activation/recovery", {
    request,
    recovery: activationWork.recovery,
  });
  const { intent, prepared, consentSignature } = activationWork;
  setStatus(
    "Creating the wallet and transferring its capability to your passkey…",
  );
  const { attempt } = await api<{
    attempt: { dwallet_id: string; cap_id: string; share_id: string };
  }>("activation/dkg", {
    request,
    consentSignature,
    encryptionKey: b64(keys.encryptionKey),
    signingKey: b64(keys.getSigningPublicKeyBytes()),
    encryptionSignature: b64(await keys.getEncryptionKeySignature()),
    message: b64(prepared.userDKGMessage),
    publicOutput: b64(prepared.userPublicOutput),
    encryptedShare: b64(prepared.encryptedUserShareAndProof),
  });
  wallet = {
    ...wallet,
    dWalletId: attempt.dwallet_id,
    capId: attempt.cap_id,
    shareId: attempt.share_id,
    status: "creating",
  };
  await poll(
    () => confirm(wallet!, false),
    (v) => {
      if (
        v.d.state.$kind.startsWith("NetworkRejected") ||
        v.share.state.$kind === "NetworkVerificationRejected"
      )
        throw new Error(
          "Ika rejected this attempt. No activation was accepted.",
        );
      return (
        (v.d.state.$kind === "AwaitingKeyHolderSignature" &&
          v.share.state.$kind === "NetworkVerificationCompleted") ||
        (v.d.state.$kind === "Active" &&
          v.share.state.$kind === "KeyHolderSigned")
      );
    },
    setStatus,
    "Waiting for Ika to verify the new wallet…",
  );
  const { d, share } = await confirm(wallet, false);
  if (
    d.dwallet_network_encryption_key_id !== intent.networkKeyId ||
    !sameBytes(
      Uint8Array.from(share.encrypted_centralized_secret_share_and_proof),
      prepared.encryptedUserShareAndProof,
    )
  )
    throw new Error(
      "The encrypted share or network did not match the locally prepared request.",
    );
  // This SDK method verifies the network output against the retained local DKG
  // output before producing the acceptance signature.
  if (d.state.$kind === "AwaitingKeyHolderSignature") {
    const acceptance = await keys.getUserOutputSignature(
      d,
      prepared.userPublicOutput,
    );
    setStatus("Accepting your verified wallet share…");
    await api("activation/accept", { request, signature: b64(acceptance) });
  } else if (d.state.$kind === "Active") {
    if (
      !(await userAndNetworkDKGOutputMatch(
        Curve.SECP256K1,
        prepared.userPublicOutput,
        Uint8Array.from(d.state.Active.public_output),
      ))
    )
      throw new Error("Active wallet does not match the retained DKG output.");
    const restored = await keys.decryptUserShare(
      d,
      share,
      await ika.getProtocolPublicParameters(d, Curve.SECP256K1),
    );
    restored.secretShare.fill(0);
  } else throw new Error("Unexpected DKG state.");
  const completed = await poll(
    () =>
      api<{ status: string; wallet?: WalletRecord }>("activation/status", {
        request,
      }),
    (v) => v.status === "active",
    setStatus,
    "Waiting for confirmed activation…",
  );
  if (!completed.wallet) throw new Error("Missing activation record.");
  wallet = completed.wallet;
  const active = await confirm(wallet, true);
  if (active.d.state.$kind !== "Active") throw new Error("Wallet not active.");
  const publicKey = await publicKeyFromDWalletOutput(
    Curve.SECP256K1,
    Uint8Array.from(active.d.state.Active.public_output),
  );
  const address = publicKeyToAddress(
    bytesToHex(secp256k1.Point.fromBytes(publicKey).toBytes(false)),
  );
  if (address.toLowerCase() !== wallet.evmAddress?.toLowerCase())
    throw new Error("Creator address did not match the chain.");
  showWallet(wallet);
  setStatus(
    "Wallet active. Return to the community, then reopen it to test signing.",
  );
  button("finish").hidden = false;
  activationWork = undefined;
}
async function sign() {
  if (!wallet || !keys) throw new Error("Unlock your passkey first.");
  const { d, share } = await confirm(wallet, true);
  const pp = await ika.getProtocolPublicParameters(d, Curve.SECP256K1);
  setStatus("Decrypting and verifying the saved share…");
  const restored = await keys.decryptUserShare(d, share, pp);
  try {
    const publicKey = await publicKeyFromDWalletOutput(
      Curve.SECP256K1,
      restored.verifiedPublicOutput,
    );
    const address = publicKeyToAddress(
      bytesToHex(secp256k1.Point.fromBytes(publicKey).toBytes(false)),
    );
    if (address.toLowerCase() !== wallet.evmAddress?.toLowerCase())
      throw new Error("Reopened address does not match the saved wallet.");
    setStatus("Preparing a test signature with Ika…");
    const s = await api<{
      id: string;
      message: string;
      presignId: string;
      presignCapId: string;
      ikaCoinId: string;
      suiCoinId: string;
      operator: string;
    }>("sign/start", { request });
    const message = validateFixedSignMessage(s.id, address, s.message);
    const p = await poll(
      () => ika.getPresign(s.presignId),
      (v) => {
        if (v.state.$kind === "NetworkRejected")
          throw new Error("Ika rejected the presign.");
        return v.state.$kind === "Completed";
      },
      setStatus,
      "Waiting for Ika presign…",
    );
    if (
      p.state.$kind !== "Completed" ||
      p.dwallet_id !== null ||
      p.cap_id !== s.presignCapId ||
      p.curve !== 0 ||
      p.signature_algorithm !== 0
    )
      throw new Error("Presign does not match this signing attempt.");
    const partial = await createUserSignMessageWithPublicOutput(
      pp,
      restored.verifiedPublicOutput,
      restored.secretShare,
      Uint8Array.from(p.state.Completed.presign),
      message,
      Hash.KECCAK256,
      SignatureAlgorithm.ECDSASecp256k1,
      Curve.SECP256K1,
    );
    const tx = await api<{
      bytes: string;
      message: string;
      alreadySubmitted?: boolean;
    }>("sign/prepare", { request, partialSignature: b64(partial) });
    if (!sameBytes(unb64(tx.message), message))
      throw new Error("Test message changed.");
    if (!tx.alreadySubmitted) {
      await validateSignTransaction(unb64(tx.bytes), {
        ...s,
        creator: wallet.suiAddress,
        capId: wallet.capId!,
        partialSignature: b64(partial),
      });
      setStatus(
        "Confirm the test signature using your creator passkey. Testnet gas is sponsored.",
      );
      const signed = await signer(wallet).signTransaction(unb64(tx.bytes));
      await api("sign/execute", { request, signature: signed.signature });
    }
    const result = await poll(
      () =>
        api<{
          status: string;
          address?: string;
          transactionDigest?: string;
          signature?: string;
        }>("sign/status", { request }),
      (v) => {
        if (v.status === "NetworkRejected")
          throw new Error("Ika rejected this signature.");
        return v.status === "verified";
      },
      setStatus,
      "Waiting for the verified test signature…",
    );
    setStatus(
      "Success. Your reopened wallet signed as the same creator address.",
    );
    details.textContent += `\n\nVerified signature transaction\n${result.transactionDigest}`;
    button("sign").hidden = true;
    button("finish").hidden = false;
  } finally {
    restored.secretShare.fill(0);
  }
}
async function finish() {
  await connectionReady;
  const result = await api<{
    code?: string;
    state: string;
    origin?: string;
    returnUrl?: string;
  }>("finish", {
    request,
  });
  if (scopedConnection && result.origin !== returnOrigin)
    throw new Error(
      "The community connection changed. Reopen it from your community.",
    );
  if (window.opener) {
    window.opener.postMessage(
      { type: "pirate:creator", ...result },
      returnOrigin,
    );
    keys = undefined;
    window.close();
  } else {
    if (scopedConnection && result.returnUrl) {
      const target = new URL(result.returnUrl);
      if (
        target.origin !== returnOrigin ||
        target.pathname !== "/creator/complete" ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error("The return address did not match your community.");
      location.assign(target.href);
    } else setStatus("Wallet confirmed. Return to the community tab.");
  }
}
async function run(fn: () => Promise<void>) {
  button("retry").hidden = true;
  status.dataset.error = "false";
  for (const b of document.querySelectorAll<HTMLButtonElement>("button"))
    b.disabled = true;
  try {
    await fn();
    retryStep = undefined;
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "The test could not complete.",
    );
    status.dataset.error = "true";
    retryStep =
      wallet && keys && (wallet.status === "saved" || activationWork)
        ? activate
        : fn;
    button("retry").hidden = false;
  } finally {
    for (const b of document.querySelectorAll<HTMLButtonElement>("button"))
      b.disabled = false;
  }
}
button("create").onclick = () => void run(() => start(true));
button("unlock").onclick = () => void run(() => start(false));
button("sign").onclick = () => void run(sign);
button("finish").onclick = () => void run(finish);
button("retry").onclick = () => {
  if (retryStep) void run(retryStep);
};
if (!request) {
  button("create").disabled = true;
  button("unlock").disabled = true;
  setStatus("Open this wallet from Release a song on the community test page.");
}
window.addEventListener("pagehide", () => {
  keys?.decryptionKey.fill(0);
  activationWork = undefined;
  activationKey = undefined;
  keys = undefined;
  wallet = undefined;
});
