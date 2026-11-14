/** Unnumbered source draft only. Root assigns the contiguous ordinal at merge. */
export function nativeBusinessTransition(db:D1Database,draft:string) {
  if(!draft.startsWith("-- pirate.native-business-transition/1\n"))throw Error("native_transition_version");
  const statements=draft.split("\n-- native-transition-statement\n").map(x=>x.trim());
  if(statements.some(x=>!x))throw Error("native_transition_framing");
  return statements.map(sql=>db.prepare(sql));
}
