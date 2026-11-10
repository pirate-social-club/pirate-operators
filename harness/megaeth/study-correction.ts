// Manual testnet command. Default planning is read-only, including local files.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createPublicClient, http, type Hex } from "viem";
import { insist, CommunityError } from "../../packages/community/common.ts";
import {
  registerControllerProfile,
  markControllerPrepared,
  auditControllerCatalog,
} from "./controller-dispatch-catalog.ts";
import { ActivationJournal } from "./activation-journal.ts";
import {
  privateExistingFile,
  readControllerInventory,
} from "./controller-inventory.ts";
import {
  correctionIntent,
  type StudyCorrectionProfile,
} from "./study-correction-plan.ts";
import { observeCorrection } from "./study-correction-observation.ts";
import {
  correctionStatus,
  runCorrection,
  type CorrectionTransaction,
} from "./study-correction-runner.ts";

function writableDirectory(path: string) {
  for (let p = path; ; p = dirname(p)) {
    insist(!existsSync(join(p, ".git")), "correction_state_inside_repository");
    if (p === dirname(p)) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  insist(
    realpathSync(path) === path &&
      info.isDirectory() &&
      !(info.mode & 0o077) &&
      (!process.getuid || info.uid === process.getuid()),
    "correction_state_not_private",
  );
}
export async function studyCorrectionMain(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      profile: { type: "string" },
      execute: { type: "boolean" },
      status: { type: "boolean" },
      "expect-profile": { type: "string" },
      "key-file": { type: "string" },
    },
  });
  insist(
    values.profile && !(values.execute && values.status),
    "usage_study_correction_profile_required",
  );
  const profile: StudyCorrectionProfile = JSON.parse(
    readFileSync(values.profile, "utf8"),
  );
  const intent = correctionIntent(profile);
  const client = createPublicClient({
    transport: http("https://carrot.megaeth.com/rpc", {
      retryCount: 0,
      timeout: 15000,
      fetchOptions: { redirect: "error" },
    }),
  });
  const directory = join(
    homedir(),
    ".local/state/pirate-controller",
    "6343",
    profile.controller.toLowerCase(),
  );
  const journalPath = join(directory, intent.profileHash.slice(2) + ".sqlite");
  if (values.status) {
    let stored: CorrectionTransaction | undefined;
    if (existsSync(journalPath)) {
      privateExistingFile(journalPath);
      const db = new DatabaseSync(journalPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT value FROM records WHERE key='correction'")
          .get() as { value: string } | undefined;
        stored = row ? JSON.parse(row.value) : undefined;
      } finally {
        db.close();
      }
    }
    return {
      mode: "status",
      profileHash: intent.profileHash,
      ...(await correctionStatus(client, profile, stored)),
    };
  }
  const observe = async () => {
    const observation = await observeCorrection(client, profile);
    const inventory = await readControllerInventory(
      client,
      profile,
      BigInt(observation.head.number),
    );
    return { observation, inventory };
  };
  if (!values.execute) {
    const { observation, inventory } = await observe();
    const catalog = await auditControllerCatalog(client, profile, journalPath);
    return {
      mode: "plan",
      profileHash: intent.profileHash,
      to: intent.to,
      data: intent.data,
      nonce: intent.nonce,
      maximumFeeWei: intent.maximumFeeWei,
      nextCommitment: intent.commitment,
      canonicalHead: observation.head,
      latestNonce: observation.latestNonce,
      pendingNonce: observation.pendingNonce,
      inventory,
      catalog,
      executionWindowOpen:
        Date.now() >= Date.parse(profile.notBefore) &&
        Date.now() < Date.parse(profile.deadline),
      custody:
        "reviewed finite inventory; legacy runners must remain quiescent",
    };
  }
  insist(
    values["expect-profile"] === intent.profileHash && values["key-file"],
    "correction_explicit_profile_and_key_path_required",
  );
  // This fixed signer-wide OS lease serializes participating correction commands.
  // It cannot fence older runners; the hash-bound custody record must do that.
  await observe();
  writableDirectory(directory);
  const lease = new ActivationJournal(
    join(directory, "dispatch-custody.sqlite"),
  );
  let journal: ActivationJournal | undefined;
  try {
    await registerControllerProfile(client, profile, lease, journalPath);
    journal = new ActivationJournal(journalPath);
    return {
      mode: "execute",
      profileHash: intent.profileHash,
      ...(await runCorrection(
        client,
        profile,
        journal,
        () => {
          privateExistingFile(values["key-file"]!);
          let key: { chainId?: number; privateKey?: Hex };
          try {
            key = JSON.parse(readFileSync(values["key-file"]!, "utf8"));
          } catch {
            throw new Error("correction_key_unreadable");
          }
          insist(key.chainId === 6343, "correction_key_wrong_chain");
          insist(
            typeof key.privateKey === "string" &&
              /^0x[0-9a-f]{64}$/i.test(key.privateKey) &&
              BigInt(key.privateKey) > 1024n,
            "correction_fixture_key_refused",
          );
          return key.privateKey as Hex;
        },
        () => Date.now(),
        (stored) => markControllerPrepared(lease, journalPath, stored),
      )),
    };
  } finally {
    journal?.close();
    lease.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  studyCorrectionMain()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const code =
        error instanceof CommunityError
          ? error.code
          : error instanceof Error &&
              /^[a-z][a-z0-9_]{1,100}$/.test(error.message)
            ? error.message
            : "correction_failed";
      console.error(code);
      process.exitCode = 1;
    });
}
