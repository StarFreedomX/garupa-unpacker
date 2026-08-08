/**
 * AssetBundleInfoUrl.json 存取 + AssetBundleInfo URL 构造。
 * 结构: {
 *   latest: {clientVersion, dataVersion, masterDataVersion},
 *   nowDataVersion: "10.1.0.230",
 *   hashes: { "10.1.0": "<64hex>" },
 *   clientHashes: { "10.1.4": "<64hex>" },
 *   snapshots: { "10.1.4": { dataVersion, masterDataVersion } }
 * }
 * URL 规律: https://content.garupa.jp/Release/<dataVersion>_<主版本hash>/Android/AssetBundleInfo
 * 其中 dataVersion 是游戏 /application 返回的 4 段数据版本（如 10.1.0.230）。
 * latest = 云端最新版本（每次刷新 application 更新）；nowDataVersion = 本机当前已解包版本
 * （对比基准，只在完整解包成功后更新）。CDN hash 真正归属于 clientVersion 线
 * （同一 clientVersion 线共享同一 hash），clientHashes（键 = clientVersion）是权威表；
 * hashes（键 = dataVersion 主版本）是历史遗留的兼容层。snapshots 记录每次运行时
 * /application 确认的 clientVersion → {dataVersion, masterDataVersion}。
 */
import fs from "node:fs/promises";

/** 快照条目：clientVersion → /application 返回的 dataVersion / masterDataVersion（不含 hash） */
export type SnapshotEntry = {
    dataVersion?: string;
    masterDataVersion?: string;
};

export type AssetBundleInfoStore = {
    latest: { clientVersion?: string; dataVersion?: string; masterDataVersion?: string };
    nowDataVersion?: string;
    hashes: Record<string, string>;
    clientHashes: Record<string, string>;
    snapshots: Record<string, SnapshotEntry>;
};

/** 取主版本（前三段）：10.1.0.230 → 10.1.0 */
export function mainVersion(version: string): string {
    return version.split(".").slice(0, 3).join(".");
}

/**
 * 点分版本号数字比较（与 saveStore 的 hashes 排序逻辑一致，提取自原内联比较器）。
 * 返回负数表示 a 排前（即 a 更新/更大），0 表示相等，正数表示 b 排前。
 */
export function compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return nb - na;
    }
    return 0;
}

/**
 * 记录一次 clientVersion 快照（合并进已有条目）。
 * - snapshot 只存 dataVersion / masterDataVersion（/application 返回，不含 hash）
 * - partial.hash 不落入 snapshot，而是写入权威表 clientHashes（键 = 调用方传入的 clientVersion）
 * - 同时提供 dataVersion 与 hash 时同步兼容层 hashes（键 = dataVersion 主版本）
 * 返回是否产生了实际变化（新增或字段值改变），调用方据此置 dirty 触发落盘。
 */
export function recordSnapshot(store: AssetBundleInfoStore, clientVersion: string, partial: Partial<SnapshotEntry> & { hash?: string }): boolean {
    const { hash, ...snapshotFields } = partial;
    const prev = store.snapshots[clientVersion] || {};
    const next = { ...prev, ...snapshotFields };
    let changed = Object.keys(snapshotFields).some(k => prev[k as keyof SnapshotEntry] !== next[k as keyof SnapshotEntry]);
    store.snapshots[clientVersion] = next;

    if (hash) {
        if (store.clientHashes[clientVersion] !== hash) {
            store.clientHashes[clientVersion] = hash;
            changed = true;
        }
    }
    if (partial.dataVersion && hash) {
        const key = mainVersion(partial.dataVersion);
        if (store.hashes[key] !== hash) {
            store.hashes[key] = hash;
            changed = true;
        }
    }
    return changed;
}

/**
 * 从 snapshots 反查 dataVersion 对应的 clientVersion：
 * 精确 dataVersion 命中优先，否则同主版本线取最新 clientVersion；无 → null。
 */
export function findClientVersionForDataVersion(store: AssetBundleInfoStore, dataVersion: string): string | null {
    const line = mainVersion(dataVersion);
    const candidates: Array<[string, SnapshotEntry]> = Object.entries(store.snapshots)
        .filter(([, s]) => s.dataVersion && mainVersion(s.dataVersion) === line);
    if (candidates.length === 0) return null;

    const exact = candidates.find(([, s]) => s.dataVersion === dataVersion);
    if (exact) return exact[0];

    candidates.sort(([a], [b]) => compareVersions(a, b));
    return candidates[0][0];
}

/**
 * 为指定 dataVersion 反查 hash（可附带明确的 clientVersion）：
 * 1. clientVersion 提供且 clientHashes[clientVersion] 存在 → 直接返回（权威表优先）
 * 2. 经 findClientVersionForDataVersion 反查 dataVersion 对应 clientVersion → clientHashes[cv] 存在 → 返回
 * 3. hashes[mainVersion(dataVersion)] 存在 → 返回（兼容层兜底）
 * 4. 都没有 → null
 */
export function findHashForDataVersion(store: AssetBundleInfoStore, dataVersion: string, clientVersion?: string): string | null {
    // 1. 明确的 clientVersion 线直查（权威表）
    if (clientVersion && store.clientHashes[clientVersion]) {
        return store.clientHashes[clientVersion];
    }

    // 2. 由 snapshots 反查 dataVersion 对应的 clientVersion，再查 clientHashes
    const cv = findClientVersionForDataVersion(store, dataVersion);
    if (cv && store.clientHashes[cv]) {
        return store.clientHashes[cv];
    }

    // 3. hashes 兼容层（dataVersion 主版本）
    const direct = store.hashes[mainVersion(dataVersion)];
    if (direct) return direct;

    // 4. 都没有 → null
    return null;
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

/**
 * 读取存储；兼容旧版扁平结构（{ "9.4.0.240": "https://..._<hash>/..." }）自动迁移。
 * 可选 out 参数 migrated 用于报告「本次从旧结构推导补全了 clientHashes」（供调用方置 dirty 落盘）。
 */
export async function loadStore(filePath: string, migrated?: { value: boolean }): Promise<AssetBundleInfoStore> {
    try {
        // 容错：剥掉 UTF-8 BOM（某些编辑器/脚本写文件可能带 \uFEFF，直接 JSON.parse 会失败 → 静默空 store）
        const rawText = (await fs.readFile(filePath, "utf-8")).replace(/^\uFEFF/, "");
        const raw = JSON.parse(rawText);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            if ("hashes" in raw && typeof raw.hashes === "object" && raw.hashes) {
                const latest = { ...(raw.latest || {}) };
                const hashes = { ...raw.hashes };
                const snapshots = raw.snapshots && typeof raw.snapshots === "object" ? { ...raw.snapshots } : {};
                let clientHashes = raw.clientHashes && typeof raw.clientHashes === "object" ? { ...raw.clientHashes } : {};
                // 迁移：clientHashes 为空但老数据存在 → 从已有数据推导补全
                if (Object.keys(clientHashes).length === 0) {
                    // 兼容旧版本文件：snapshots 条目里可能残留 hash 字段（现已不写）
                    for (const [cv, s] of Object.entries(snapshots)) {
                        if (s && typeof s === "object" && (s as { hash?: string }).hash) {
                            clientHashes[cv] = (s as { hash?: string }).hash!;
                        }
                    }
                    if (latest.clientVersion && latest.dataVersion) {
                        const h = hashes[mainVersion(latest.dataVersion)];
                        if (h) clientHashes[latest.clientVersion] = h;
                    }
                    if (migrated) migrated.value = Object.keys(clientHashes).length > 0;
                }
                return {
                    latest,
                    nowDataVersion: typeof raw.nowDataVersion === "string" ? raw.nowDataVersion : undefined,
                    hashes,
                    clientHashes,
                    snapshots,
                };
            }
            // 旧格式迁移：从每个 dataVersion 的 URL 提取 hash 汇总到主版本
            const store: AssetBundleInfoStore = { latest: {}, hashes: {}, clientHashes: {}, snapshots: {} };
            for (const [version, url] of Object.entries(raw)) {
                if (typeof url !== "string") continue;
                const hash = extractHashFromUrl(url);
                if (hash) store.hashes[mainVersion(version)] = hash;
            }
            return store;
        }
    } catch { /* 文件不存在或损坏 → 空存储 */ }
    return { latest: {}, hashes: {}, clientHashes: {}, snapshots: {} };
}

/** 保存存储（hashes / clientHashes 按版本号语义化逆序排序；保留 snapshots、nowDataVersion） */
export async function saveStore(store: AssetBundleInfoStore, filePath: string): Promise<void> {
    const sortedHashes = Object.fromEntries(
        Object.entries(store.hashes).sort((a, b) => compareVersions(a[0], b[0]))
    );
    const sortedClientHashes = Object.fromEntries(
        Object.entries(store.clientHashes).sort((a, b) => compareVersions(a[0], b[0]))
    );
    const sorted = {
        latest: { ...store.latest },
        nowDataVersion: store.nowDataVersion,
        hashes: sortedHashes,
        clientHashes: sortedClientHashes,
        snapshots: { ...store.snapshots },
    };
    await fs.writeFile(filePath, JSON.stringify(sorted, null, 2), "utf-8");
}
