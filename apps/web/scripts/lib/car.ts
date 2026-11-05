// Deterministic UnixFS CAR packing for a release directory.
//
// The root CID depends on how files are chunked and linked, so the packing
// settings are fixed and recorded with every CAR: the IPIP-499 profile
// unixfs-v1-2025 (CIDv1, raw leaves, 1 MiB fixed chunks, 1,024 links per
// node, block-size HAMT threshold), wrapped in one directory, files in
// byte-wise path order. Blocks are written in depth-first order from the root,
// so the CAR bytes do not depend on importer concurrency.
import { CarWriter } from "@ipld/car/writer";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const PACKING = {
  profile: "unixfs-v1-2025",
  wrapWithDirectory: true,
  order: "byte-wise relative path",
  carVersion: 1,
  blockOrder: "depth-first from root, first occurrence",
  importer: "ipfs-unixfs-importer@17.1.1",
} as const;

export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
      else throw new Error(`unsupported file type in release: ${full}`);
    }
  };
  await walk(root);
  return out.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

class MemoryBlocks {
  readonly blocks = new Map<string, Uint8Array>();
  async put(cid: CID, bytes: Uint8Array): Promise<CID> {
    this.blocks.set(cid.toString(), bytes);
    return cid;
  }
}

export interface PackedCar {
  readonly rootCid: string;
  readonly car: Uint8Array;
  readonly carSha256: string;
  readonly blockCount: number;
  readonly fileCount: number;
}

export async function packDirectory(root: string): Promise<PackedCar> {
  const files = await listFiles(root);
  const store = new MemoryBlocks();
  const candidates = await Promise.all(files.map(async path => ({ path, content: await readFile(join(root, path)) })));
  let last: CID | undefined;
  for await (const entry of importer(candidates, store, {
    profile: PACKING.profile,
    wrapWithDirectory: PACKING.wrapWithDirectory,
    fileImportConcurrency: 1,
    blockWriteConcurrency: 1,
  })) {
    last = entry.cid;
  }
  if (last === undefined) throw new Error("empty release directory");

  const ordered: Array<{ cid: CID; bytes: Uint8Array }> = [];
  const seen = new Set<string>();
  const visit = (cid: CID) => {
    const key = cid.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const bytes = store.blocks.get(key);
    if (bytes === undefined) throw new Error(`missing block ${key}`);
    ordered.push({ cid, bytes });
    if (cid.code === dagPb.code) for (const link of dagPb.decode(bytes).Links) visit(link.Hash);
  };
  visit(last);

  const { writer, out } = CarWriter.create([last]);
  const chunks: Uint8Array[] = [];
  const collected = (async () => { for await (const chunk of out) chunks.push(chunk); })();
  for (const block of ordered) await writer.put(block);
  await writer.close();
  await collected;
  const car = Buffer.concat(chunks);
  return {
    rootCid: last.toString(),
    car,
    carSha256: createHash("sha256").update(car).digest("hex"),
    blockCount: ordered.length,
    fileCount: files.length,
  };
}

export { CID };
