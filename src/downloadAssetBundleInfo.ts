import * as fs from 'fs/promises';
import * as path from 'path';
import axios, { AxiosError } from 'axios';
import { fileURLToPath } from "url";
import {
    mainVersion, compareVersions, buildAssetBundleUrl, extractVersionFromUrl, extractHashFromUrl,
    ensureTimestamp, loadStore, saveStore, recordSnapshot, findHashForDataVersion,
} from "./garupa/assetBundleInfo.js";
import type { AssetBundleInfoStore } from "./garupa/assetBundleInfo.js";
import { getAppVersions } from "./garupa/version.js";
import { extractApkCandidates } from "./garupa/apkHash.js";
import { fetchApplication } from "./garupa/api/application.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const APKS_DIR = path.join(PROJECT_ROOT, "apks");

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const JSON_PATH = "AssetBundleInfoUrl.json";
const BASE_NAME = "AssetBundleInfo";
const OUT_DIR = BASE_NAME;

/** 输入是否为纯版本号 9.3.0.210 */
function isVersionFormat(input: string): boolean {
    return /^\d+\.\d+\.\d+\.\d+$/.test(input);
}

/**
 * 从 apks 目录的候选 APK 中，为指定 dataVersion 找 hash。
 * 候选 APK 只含 clientVersion + hash；逐个用 /application 询问其真实 dataVersion，
 * 命中目标 dataVersion 主版本线的候选即返回其 hash（最新 clientVersion 优先）。
 * 网络失败 / 无候选 / 全部未命中 → null（不抛出）。
 */
export async function hashFromApksForDataVersion(store: AssetBundleInfoStore, version: string): Promise<string | null> {
    let candidates: Array<{ apkName: string; clientVersion: string; hash: string }>;
    try {
        candidates = await extractApkCandidates(APKS_DIR);
    } catch (err) {
        console.warn(`从 apks 提取候选失败（忽略）: ${(err as Error).message}`);
        return null;
    }
    if (candidates.length === 0) return null;

    // 最新 clientVersion 优先（compareVersions 为逆序比较器，直接 sort 即最新在前）
    candidates.sort((a, b) => compareVersions(a.clientVersion, b.clientVersion));

    let snapshotChanged = false;
    for (const c of candidates) {
        // 已有快照则直接用其 dataVersion（省一次网络请求）
        let dataVersion: string | undefined = store.snapshots[c.clientVersion]?.dataVersion;
        if (!dataVersion) {
            try {
                const app = await fetchApplication(c.clientVersion);
                dataVersion = app.dataVersion;
                const masterDataVersion = app.masterDataVersion;
                snapshotChanged = recordSnapshot(store, c.clientVersion, { dataVersion, masterDataVersion }) || snapshotChanged;
            } catch {
                dataVersion = undefined;
            }
        }
        if (dataVersion && mainVersion(dataVersion) === mainVersion(version)) {
            snapshotChanged = recordSnapshot(store, c.clientVersion, { hash: c.hash }) || snapshotChanged;
            console.log(`apks 候选 ${c.apkName}（clientVersion ${c.clientVersion}）→ 服务器 dataVersion ${dataVersion}，命中主版本 ${mainVersion(version)}，使用其 hash`);
            return c.hash;
        }
        // dataVersion 解析失败时仍把 hash 保留到 clientHashes（供将来快照补全后反查用），但无法确认归属 → 不返回
        snapshotChanged = recordSnapshot(store, c.clientVersion, { hash: c.hash }) || snapshotChanged;
    }
    return null;
}

/**
 * 刷新 /application → 更新 store.latest + snapshots；失败返回 null（不抛出）。
 * 供 index.ts 一键流程起点一次性刷新用；downloadAB 只在「自动检测」分支内自行刷新。
 */
export async function refreshAppData(store: AssetBundleInfoStore): Promise<{ clientVersion: string; dataVersion: string; masterDataVersion: string } | null> {
    try {
        const app = await getAppVersions();
        store.latest = {
            clientVersion: app.clientVersion,
            dataVersion: app.dataVersion,
            masterDataVersion: app.masterDataVersion,
        };
        recordSnapshot(store, app.clientVersion, {
            dataVersion: app.dataVersion,
            masterDataVersion: app.masterDataVersion,
        });
        console.log(`已刷新 /application：client ${app.clientVersion} / data ${app.dataVersion}`);
        return app;
    } catch (err) {
        console.warn(`刷新 /application 失败: ${(err as Error).message}`);
        return null;
    }
}

/**
 * 核心下载逻辑
 * @param inputAssetBundlePath URL 或版本号，例如 "9.3.0.200"
 */
export async function downloadAB(inputAssetBundlePath?: string) {
    inputAssetBundlePath = inputAssetBundlePath?.trim();
    let url = "";
    let version = "";
    let learnedHash: string | null = null;
    let dirty = false;

    // 读取存储（兼容旧格式自动迁移 + clientHashes 结构升级）
    const migrated = { value: false };
    const store = await loadStore(JSON_PATH, migrated);
    if (migrated.value) dirty = true; // 迁移推导出了 clientHashes → 需要落盘一次

    // 输入了内容
    if (inputAssetBundlePath) {
        // 输入的是版本号（非 URL）——不刷新 /application，下载旧版本绝不能污染 latest
        if (isVersionFormat(inputAssetBundlePath)) {
            version = inputAssetBundlePath;
            const main = mainVersion(version);
            let hash = findHashForDataVersion(store, version);
            if (!hash) hash = await hashFromApksForDataVersion(store, version);
            if (!hash) {
                throw new Error(`hashes 中缺少主版本 ${main} 的 hash，请先粘贴一次该主版本的完整 AssetBundleInfo URL 以自动记录，或放置对应版本的 .apk/.apks/.xapk 到 ${APKS_DIR}`);
            }
            url = ensureTimestamp(buildAssetBundleUrl(version, hash));
            console.log(`使用版本号模式 → 主版本 ${main} 匹配成功`);
            console.log(`构造 URL: ${url}`);
        }
        // 输入的是真 URL → 学习该主版本的 hash（自动更新记录）
        else {
            url = ensureTimestamp(inputAssetBundlePath);
            const extracted = extractVersionFromUrl(url);
            if (!extracted) throw new Error("无法识别 URL 中的版本号！");
            version = extracted;
            learnedHash = extractHashFromUrl(url);
            console.log(`手动 URL 模式 → 版本: ${version}`);
        }
    }
    // 未输入 → 刷新 application 拿云端最新 + 更新 latest/snapshots，再自动检测
    else {
        const app = await getAppVersions();
        store.latest = {
            clientVersion: app.clientVersion,
            dataVersion: app.dataVersion,
            masterDataVersion: app.masterDataVersion,
        };
        if (recordSnapshot(store, app.clientVersion, {
            dataVersion: app.dataVersion,
            masterDataVersion: app.masterDataVersion,
        })) dirty = true;
        console.log(`已刷新 /application：client ${app.clientVersion} / data ${app.dataVersion}`);
        version = app.dataVersion;
        const main = mainVersion(version);
        let hash = findHashForDataVersion(store, version, app.clientVersion);
        if (!hash) hash = await hashFromApksForDataVersion(store, version);
        if (!hash) {
            throw new Error(`hashes 中缺少主版本 ${main} 的 hash，请先粘贴一次该主版本的完整 AssetBundleInfo URL 以自动记录，或放置对应版本的 .apk/.apks/.xapk 到 ${APKS_DIR}`);
        }
        url = ensureTimestamp(buildAssetBundleUrl(version, hash));
        console.log(`自动检测最新版本 → ${version}`);
        console.log(`构造 URL: ${url}`);
    }

    if (learnedHash) dirty = true;

    // 保存路径
    const finalPath = path.join(OUT_DIR, `${BASE_NAME}_${version}.txt`);
    await fs.mkdir(OUT_DIR, { recursive: true });

    let downloaded = false;
    // 如果已有文件 → 跳过
    try {
        await fs.access(finalPath);
        console.log(`文件已存在，无需下载: ${finalPath}`);
    } catch {
        console.log(`正在下载 ${version} ...`);
        try {
            const res = await axios.get(url, {
                responseType: "arraybuffer",
                timeout: 20000,
            });
            await fs.writeFile(finalPath, Buffer.from(res.data));
            downloaded = true;
            console.log(`已保存: ${finalPath}`);
        } catch (err) {
            if (err instanceof AxiosError) {
                console.error(err.message);
                throw err;
            }
            throw new Error(`下载失败: ${(err as any).message}`);
        }
    }

    // 学习到新 hash → 记录到 hashes（兼容层），并尝试补写 clientHashes（权威表）
    if (learnedHash) {
        store.hashes[mainVersion(version)] = learnedHash;
        // 从 snapshots 找同 dataVersion 主版本线的 clientVersion 候选（最新优先），
        // 找到则 clientHashes[cv] = learnedHash；找不到只写 hashes（不报错）
        const line = mainVersion(version);
        const cvCandidates = Object.entries(store.snapshots)
            .filter(([, s]) => s.dataVersion && mainVersion(s.dataVersion) === line)
            .map(([cv]) => cv)
            .sort((a, b) => compareVersions(a, b));
        if (cvCandidates.length > 0) {
            store.clientHashes[cvCandidates[0]] = learnedHash;
            console.log(`URL 学习 hash → 同时写入 clientHashes[${cvCandidates[0]}]`);
        }
        dirty = true;
    }

    // 有变化才写回 JSON
    if (dirty) {
        await saveStore(store, JSON_PATH);
        console.log(`URL 记录已更新: ${JSON_PATH}`);
    }

    return { version, filePath: finalPath, url };
}

/** CLI 启动入口 */
async function main() {
    const readline = await import('readline/promises');
    const process = await import('process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const input = await rl.question("请输入 AssetBundleInfo URL 或版本号（留空自动检测更新）：\n> ");
    rl.close();

    try {
        const result = await downloadAB(input || undefined);
        console.log(`处理完成: ${result.filePath}`);
    } catch (e) {
        console.error(`错误:`, e instanceof Error ? e.message : e);
    }
}

if (isMainProcess)
    main();
