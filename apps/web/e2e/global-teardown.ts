import { stopKubo } from "./kubo.ts";
export default async function globalTeardown() { stopKubo(); }
