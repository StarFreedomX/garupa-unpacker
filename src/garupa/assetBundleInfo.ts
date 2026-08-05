/**
 * AssetBundleInfoUrl.json 存取 + AssetBundleInfo URL 构造。
 * 结构: { latest: {clientVersion, dataVersion, masterDataVersion}, hashes: { "10.1.0": "<64hex>" } }
 * URL 规律: https://content.garupa.jp/Release/<dataVersion>_<主版本hash>/Android/AssetBundleInfo
 * 其中 dataVersion 是游戏 /application 返回的 4 段数据版本（如 10.1.0.230），
 * hashes 的 key 是其前三段主版本（如 10.1.0），同一主版本内共享同一 hash。
 */
import fs from "node:fs/promises";

export type AssetBundleInfoStore = {
    latest: { clientVersion?: string; dataVersion?: string; masterDataVersion?: string };
    hashes: Record<string, string>;
};

/** 取主版本（前三段）：10.1.0.230 → 10.1.0 */
export function mainVersion(version: string): string {
    return version.split(".").slice(0, 3).join(".");
}

/** dataVersion（4 段数据版本号）+ 主版本 hash → AssetBundleInfo URL（无时间戳） */
export function buildAssetBundleUrl(dataVersion: string, hash: string): string {
    return `https://content.garupa.jp/Release/${dataVersion}_${hash}/Android/AssetBundleInfo`;
}

/** 从 URL 提取 dataVersion（4 段数据版本号） */
export function extractVersionFromUrl(url: string): string | null {
    const match = url.match(/\/Release\/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}

/** 从 URL 提取主版本 hash */
export function extractHashFromUrl(url: string): string | null {
    const match = url.match(/\/Release\/\d+\.\d+\.\d+\.\d+_([a-fA-F0-9]{64})/);
    return match ? match[1] : null;
}

/** 给 URL 加时间戳避免 403 */
export function ensureTimestamp(url: string): string {
    if (url.includes("t=")) return url;
    const sep = url.includes("?") ? "&" : "?";
    const stamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    return `${url}${sep}t=${stamp}`;
}

/** 读取存储；兼容旧版扁平结构（{ "9.4.0.240": "https://..._<hash>/..." }）自动迁移 */
export async function loadStore(filePath: string): Promise<AssetBundleInfoStore> {
    try {
        const raw = JSON.parse(await fs.readFile(filePath, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            if ("hashes" in raw && typeof raw.hashes === "object" && raw.hashes) {
                return { latest: { ...(raw.latest || {}) }, hashes: { ...raw.hashes } };
            }
            // 旧格式迁移：从每个 dataVersion 的 URL 提取 hash 汇总到主版本
            const store: AssetBundleInfoStore = { latest: {}, hashes: {} };
            for (const [version, url] of Object.entries(raw)) {
                if (typeof url !== "string") continue;
                const hash = extractHashFromUrl(url);
                if (hash) store.hashes[mainVersion(version)] = hash;
            }
            return store;
        }
    } catch { /* 文件不存在或损坏 → 空存储 */ }
    return { latest: {}, hashes: {} };
}

/** 保存存储（hashes 按主版本号语义化逆序排序） */
export async function saveStore(store: AssetBundleInfoStore, filePath: string): Promise<void> {
    const sortedHashes = Object.fromEntries(
        Object.entries(store.hashes).sort((a, b) => {
            const pa = a[0].split(".").map(Number);
            const pb = b[0].split(".").map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const na = pa[i] || 0;
                const nb = pb[i] || 0;
                if (na !== nb) return nb - na;
            }
            return 0;
        })
    );
    const sorted = { latest: { ...store.latest }, hashes: sortedHashes };
    await fs.writeFile(filePath, JSON.stringify(sorted, null, 2), "utf-8");
}
