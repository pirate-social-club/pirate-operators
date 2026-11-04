import { startKubo } from "./kubo.ts";
export default async function globalSetup() { await startKubo(); }
