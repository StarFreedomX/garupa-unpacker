#!/usr/bin/env npx tsx
/**
 * Download SuiteMaster from game API, parse ALL protobuf fields, output JSON.
 *
 * Usage:
 *   npx tsx src/suiteMaster.ts [--output suite_master.json]
 *
 * Output: JSON file with all master data fields resolved (skills, cards,
 *   characters, events, gacha, music, etc.)
 */
import * as fs from "fs";
import * as path from "path";
import { getClientVersion } from "./garupa/version.js";
import { fetchSuiteMaster } from "./garupa/api/suiteMaster.js";

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const clientVersion = await getClientVersion();
    const result = await fetchSuiteMaster(clientVersion);

    const outFile = process.argv.includes("--output")
        ? process.argv[process.argv.indexOf("--output") + 1]
        : "suite_master.json";

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
    console.log(`Saved to ${outFile}`);
    console.log(`Top-level keys: ${Object.keys(result).length}`);
    for (const [k, v] of Object.entries(result).slice(0, 20)) {
        const type = Array.isArray(v) ? `array(${v.length})` : typeof v;
        console.log(`  ${k}: ${type}`);
    }
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
