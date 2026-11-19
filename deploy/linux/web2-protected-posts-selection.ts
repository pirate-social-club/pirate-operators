import assert from "node:assert/strict";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { NativeGraph } from "./full-native-config.ts";

export interface ProtectedFirstSongGraph {
  schema: "pirate.web2-protected-posts-transport/1";
  transportRef: string;
  directory: string;
}

export interface ProtectedPostsBootSnapshot {
  selection: string;
  forward: string;
  reverse: string;
}

export const protectedPostsBinding = {
  owner: "WEB2_PROTECTED_POSTS_OWNER",
  selection: "WEB2_PROTECTED_POSTS_SELECTION_JSON",
  forward: "WEB2_PROTECTED_POSTS_FORWARD_AUTH",
  reverse: "WEB2_PROTECTED_POSTS_REVERSE_AUTH",
} as const;

export const beneath = (root: string, path: string) => {
  const rest = relative(root, path);
  return !isAbsolute(rest) && rest !== ".." && !rest.startsWith("../");
};

export function protectedPostsPaths(graph: Omit<NativeGraph, "directoryRuntimeBinding">) {
  const selected = graph.protectedFirstSong;
  if (!selected) return;
  const { directory } = selected;
  const socket = join(dirname(directory), "activity-transport", "host.sock");
  assert(Object.keys(selected).sort().join(",") === "directory,schema,transportRef" &&
    selected.schema === "pirate.web2-protected-posts-transport/1" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(selected.transportRef) &&
    isAbsolute(directory) && normalize(directory) === directory &&
    directory === join(dirname(directory), "posts-transport") &&
    /^\/[a-zA-Z0-9_./-]{1,100}\.sock$/.test(socket) &&
    ![directory, dirname(socket)].some(path => beneath(graph.releaseRoot, path)) &&
    !graph.fixtureTransport && (!graph.localActivitySocket || graph.localActivitySocket === socket),
    "protected_posts_graph_selection_changed");
  const bindings = [...graph.applicationBindings, ...graph.secretBindings, ...graph.actors.flatMap(actor => actor.bindings)];
  assert(!bindings.some(binding => ["COMMUNITY_PUBLISHER_PRIVATE_KEY", "POSTS_CUSTODY_SELECTION_JSON",
    "POSTS_CUSTODY_HOST_AUTH"].includes(binding.name)) &&
    !graph.actors.some(actor => actor.service === "web2-local-activities"),
    "protected_posts_legacy_binding_refused");
  return {
    directory, socket, selection: join(directory, "selection.json"),
    forward: join(directory, "owner.auth"), reverse: join(directory, "primary.auth"),
  };
}
