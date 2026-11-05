// Independently owned state helper adopted from apps/community-wizard/infra/encrypted-state.ts at df49ece.
// Wrap the pinned Alchemy v2 local store, retaining its atomic writes and replacement handling.
import { relative, resolve, sep } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { State, makeLocalState } from "alchemy/State";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import { seal, unseal, statePassword } from "./protected-data.ts";

export function encryptedFileSystem(
  fs: FileSystem.FileSystem,
  password: string,
  directory: string,
): FileSystem.FileSystem {
  const context = (file: string) => {
    // Alchemy's atomic writer uses <target>.<pid>.<random>.tmp before rename.
    const committed = file.replace(/\.\d+\.[a-z0-9]*\.tmp$/, "");
    const name = relative(resolve(directory), resolve(committed));
    if (
      !name ||
      name.startsWith(`..${sep}`) ||
      name === ".." ||
      resolve(name) === name
    )
      throw new Error("State operation escaped its protected directory.");
    return `alchemy-state:${name.split(sep).join("/")}`;
  };
  return {
    ...fs,
    readFile: (file) =>
      fs
        .readFile(file)
        .pipe(
          Effect.map((bytes) =>
            Buffer.from(
              unseal(
                Buffer.from(bytes).toString("utf8"),
                password,
                context(file),
              ),
            ),
          ),
        ),
    writeFileString: (file, text, options) =>
      Effect.suspend(() =>
        fs.writeFileString(file, seal(text, password, context(file)), {
          ...options,
          mode: 0o600,
        }),
      ),
  };
}
export function encryptedLocalState() {
  return Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();
      const fs = yield* FileSystem.FileSystem;
      const directory = resolve(yield* dotAlchemyDirectory, "state");
      const protectedFs = encryptedFileSystem(fs, statePassword(), directory);
      const make = makeLocalState().pipe(
        Effect.provideService(FileSystem.FileSystem, protectedFs),
        Effect.provideContext(context),
        Effect.map((state) => ({ ...state, id: "pirate-encrypted-local" })),
      );
      return yield* Effect.cached(make);
    }),
  );
}
