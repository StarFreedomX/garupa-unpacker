#!/usr/bin/env npx tsx
/**
 * 手动更新 AssetBundleInfoUrl.json 的 snapshots 快照（clientVersion → {dataVersion, masterDataVersion, hash}）。
 *
 * Usage:
 *   npx tsx src/updateSnapshots.ts                           # 交互式：添加/更新一个 clientVersion 快照
 *   npx tsx src/updateSnapshots.ts list                      # 列出所有快照
 *   npx tsx src/updateSnapshots.ts add <clientVersion> [hash] # 非交互添加（自动调 /application 获取 dataVersion）
 *   npx tsx src/updateSnapshots.ts del <clientVersion>       # 删除快照
 *
 * 说明：自动调 /application(clientVersion) 获取 dataVersion / masterDataVersion；
 * 传入 hash（64 位 hex）时一并写入（同步 clientHashes）。网络失败时仅写入已提供字段。
 */
import { fileURLToPath } from "url";
import * as path from "path";
import {
    loadStore, saveStore, recordSnapshot, compareVersions, type SnapshotEntry, type AssetBundleInfoStore,
} from "./garupa/assetBundleInfo.js";
import { fetchApplication } from "./garupa/api/application.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, "..", "AssetBundleInfoUrl.json");

const HASH_RE = /^[a-fA-F0-9]{64}$/;

/** 列出所有快照 */
async function listSnapshots(store: AssetBundleInfoStore): Promise<void> {
    const entries = Object.entries(store.snapshots).sort(([a], [b]) => compareVersions(a, b));
    if (entries.length === 0) {
        console.log("（无快照记录）");
        return;
    }
    console.log("snapshots:");
    for (const [cv, s] of entries) {
        console.log(`  ${cv}: dataVersion=${s.dataVersion ?? "-"} master=${s.masterDataVersion ?? "-"} (hash 见 clientHashes)`);
    }
}

/**
 * 添加/更新 clientVersion 快照。
 * @param hash 可选 64 位 hex；提供时写入 hash 并同步 clientHashes
 */
async function addSnapshot(store: AssetBundleInfoStore, cv: string, hash?: string): Promise<void> {
    if (!/^\d+\.\d+\.\d+$/.test(cv)) {
        throw new Error(`clientVersion 格式应为 x.y.z（如 10.1.4），收到: ${cv}`);
    }
    if (hash && !HASH_RE.test(hash)) {
        throw new Error("hash 必须是 64 位十六进制字符串");
    }

    // 自动调 /application 获取 dataVersion / masterDataVersion（失败仅警告）
    let dataVersion: string | undefined;
    let masterDataVersion: string | undefined;
    try {
        const app = await fetchApplication(cv);
        dataVersion = app.dataVersion;
        masterDataVersion = app.masterDataVersion;
        console.log(`/application(${cv}) → dataVersion ${dataVersion} / masterDataVersion ${masterDataVersion ?? "-"}`);
    } catch (err) {
        console.warn(`调 /application(${cv}) 失败（仅写入已提供字段）: ${(err as Error).message}`);
    }

    const partial: Partial<SnapshotEntry> & { hash?: string } = {};
    if (dataVersion) partial.dataVersion = dataVersion;
    if (masterDataVersion) partial.masterDataVersion = masterDataVersion;
    if (hash) partial.hash = hash;

    const changed = recordSnapshot(store, cv, partial);
    if (!changed) {
        console.log("快照无变化，未写盘。");
        return;
    }
    await saveStore(store, JSON_PATH);
    const fields = { ...partial };
    delete (fields as { hash?: string }).hash;
    console.log(`已写入 snapshots[${cv}] → ${JSON.stringify(fields)}`);
    if (hash) console.log(`hash 已写入 clientHashes[${cv}]（snapshots 不存 hash）`);
}

/** 删除快照（同时清理对应 clientHashes 键） */
async function deleteSnapshot(store: AssetBundleInfoStore, cv: string): Promise<void> {
    if (!(cv in store.snapshots)) {
        console.log(`未找到快照 ${cv}（可先 list 查看）`);
        return;
    }
    delete store.snapshots[cv];
    delete store.clientHashes[cv];
    await saveStore(store, JSON_PATH);
    console.log(`已删除 snapshots[${cv}]（clientHashes 同步清理）`);
}

/** 交互式向导 */
async function interactive(store: AssetBundleInfoStore): Promise<void> {
    const readline = await import("readline/promises");
    const process = await import("process");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const cv = (await rl.question("clientVersion（如 10.1.4，回车取消）：\n> ")).trim();
    if (!cv) {
        rl.close();
        return;
    }
    const hash = (await rl.question("hash（64 位 hex，回车跳过）：\n> ")).trim() || undefined;
    rl.close();

    await addSnapshot(store, cv, hash);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const store = await loadStore(JSON_PATH);

    const sub = args[0];
    if (sub === "list") {
        await listSnapshots(store);
    } else if (sub === "add") {
        if (!args[1]) throw new Error("add 需要 clientVersion 参数，如: add 10.1.4");
        await addSnapshot(store, args[1], args[2]);
    } else if (sub === "del") {
        if (!args[1]) throw new Error("del 需要 clientVersion 参数，如: del 10.1.4");
        await deleteSnapshot(store, args[1]);
    } else if (sub === undefined) {
        await interactive(store);
    } else {
        throw new Error(`未知子命令: ${sub}（支持 list / add <cv> [hash] / del <cv>，无参数为交互式）`);
    }
}

main().catch((err) => {
    console.error("错误:", (err as Error).message);
    process.exit(1);
});
