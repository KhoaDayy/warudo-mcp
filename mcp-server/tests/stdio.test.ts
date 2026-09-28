import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The same process-level check is used against a clean installed package.
// @ts-expect-error The shared test helper is intentionally plain Node.js.
import { smokeStdio } from "../scripts/smoke-stdio.mjs";

test("real stdio process starts offline, keeps stdout clean, and stops on stdin EOF", async () => {
  await smokeStdio(fileURLToPath(new URL("../src/index.ts", import.meta.url)), true);
});
