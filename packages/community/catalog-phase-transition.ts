// SOURCE ONLY / UNRUN. This draft is unnumbered and never auto-applied.
// The marker is a source framing contract, not a SQL grammar or semicolon
// splitter: exact schema/trigger literals in the guard contain semicolons.
const marker = "\n-- catalog-phase-statement\n";

export function catalogPhaseTransitionSql(draft: string): string[] {
  if (!draft.startsWith("-- pirate.catalog-phase-transition/2\n")) {
    throw new Error("catalog_phase_transition_version");
  }
  const statements = draft.split(marker).map((statement) => statement.trim());
  if (statements.length < 3 || statements.some((statement) => !statement)) {
    throw new Error("catalog_phase_transition_framing");
  }
  return statements;
}

/** Submit the entire result to one D1Database.batch; never execute separately. */
export function catalogPhaseTransitionStatements(
  database: D1Database,
  draft: string,
): D1PreparedStatement[] {
  return catalogPhaseTransitionSql(draft).map((statement) =>
    database.prepare(statement),
  );
}
