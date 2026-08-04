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
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import dotenv from "dotenv";
import seekBzip from "seek-bzip";
import { decode } from "./protobuf.js";

// 加载 .env（AES Key/IV 等配置）
dotenv.config();

// ── Config ─────────────────────────────────────────────────────────────────

const API_BASE = "https://api.garupa.jp/api/";
const AES_KEY = Buffer.from(process.env.GARUPA_AES_KEY || "");
const AES_IV = Buffer.from(process.env.GARUPA_AES_IV || "");
if (AES_KEY.length === 0 || AES_IV.length === 0) {
    console.error("错误：未设置 GARUPA_AES_KEY / GARUPA_AES_IV。请在 .env 中配置");
    process.exit(1);
}
// 客户端版本默认值（拉取 App Store 失败时兜底）
const DEFAULT_CLIENT_VERSION = "10.1.4";
// JP 服 App Store 包查询（iTunes Lookup API），返回最新客户端版本
const ITUNES_LOOKUP_URL = "https://itunes.apple.com/jp/lookup?bundleId=jp.co.craftegg.band";

// ── HTTP download ──────────────────────────────────────────────────────────

function download(url: string, headers: Record<string, string>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(60_000, () => {
            req.destroy();
            reject(new Error("Timeout"));
        });
    });
}

// ── Client version ─────────────────────────────────────────────────────────

/**
 * 获取客户端版本号（X-ClientVersion）：
 * 1. GARUPA_CLIENT_VERSION_FORCE 设置则强制使用（跳过自动拉取）
 * 2. 否则从 Apple iTunes Lookup API 拉取 App Store 最新版本
 * 3. 拉取失败则回退 GARUPA_CLIENT_VERSION_DEFAULT，再回退内置默认值
 */
async function getClientVersion(): Promise<string> {
    const forced = process.env.GARUPA_CLIENT_VERSION_FORCE;
    if (forced) {
        console.log(`Client version (forced): ${forced}`);
        return forced;
    }

    try {
        const body = await download(`${ITUNES_LOOKUP_URL}&t=${Date.now()}`, {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
        });
        const data = JSON.parse(body.toString("utf-8")) as { results?: Array<{ version?: string }> };
        const version = data.results?.[0]?.version;
        if (version) {
            console.log(`Client version (from App Store): ${version}`);
            return version;
        }
        console.warn("iTunes lookup returned no version, falling back to default");
    } catch (err) {
        console.warn(`Failed to fetch client version: ${(err as Error).message}`);
    }
    const fallback = process.env.GARUPA_CLIENT_VERSION_DEFAULT || DEFAULT_CLIENT_VERSION;
    console.log(`Client version (default): ${fallback}`);
    return fallback;
}

// ── AES decrypt ────────────────────────────────────────────────────────────

function decrypt(encrypted: Buffer): Buffer {
    const decipher = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const clientVersion = await getClientVersion();

    const HEADERS: Record<string, string> = {
        "User-Agent": "UnityPlayer/2021.3.45f2 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)",
        "X-Unity-Version": "2021.3.45f2",
        "X-ClientPlatform": "Android",
        "X-ClientVersion": clientVersion,
        Accept: "application/octet-stream",
        "Content-Type": "application/octet-stream",
    };

    console.log("Downloading SuiteMaster from game API...");
    const encrypted = await download(API_BASE + "suite/master", HEADERS);

    console.log(`Encrypted: ${(encrypted.length / 1024 / 1024).toFixed(1)} MB`);
    const decrypted = decrypt(encrypted);

    console.log(`Decompressing BZip2: ${(decrypted.length / 1024 / 1024).toFixed(1)} MB`);
    const decompressed = seekBzip.decode(decrypted);

    console.log(`Decompressed: ${(decompressed.length / 1024 / 1024).toFixed(1)} MB`);
    console.log("Parsing protobuf with schema...");

    const result = decode(new Uint8Array(decompressed));

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
