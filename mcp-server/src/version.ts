import { readFileSync } from "node:fs";

/** Source and dist are both direct children of the package root. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
