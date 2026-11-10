import { copyFile } from "node:fs/promises";
import { join } from "node:path";

export const applicationInfrastructure = [
  "application-alchemy.run.ts",
  "encrypted-state.ts",
  "protected-data.ts",
  "learning-bindings.ts",
];
export const applicationInfrastructureSources = applicationInfrastructure.map(
  (p) => `apps/community-wizard/infra/${p}`,
);
export async function writeApplicationInfrastructure(directory: string) {
  for (const name of applicationInfrastructure)
    await copyFile(
      `apps/community-wizard/infra/${name}`,
      join(
        directory,
        name === "application-alchemy.run.ts" ? "alchemy.run.ts" : name,
      ),
    );
}
