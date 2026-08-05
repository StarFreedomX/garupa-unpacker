import * as fs from 'fs/promises';
import * as path from 'path';
import axios, { AxiosError } from 'axios';
import { fileURLToPath } from "url";
import {
    mainVersion, buildAssetBundleUrl, extractVersionFromUrl, extractHashFromUrl,
    ensureTimestamp, loadStore, saveStore,
} from "./garupa/assetBundleInfo.js";
import { getAppVersions } from "./garupa/version.js";

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const JSON_PATH = "AssetBundleInfoUrl.json";
const BASE_NAME = "AssetBundleInfo";
const OUT_DIR = BASE_NAME;

/** 输入是否为纯版本号 9.3.0.210 */
function isVersionFormat(input: string): boolean {
    return /^\d+\.\d+\.\d+\.\d+$/.test(input);
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

    // 读取存储（兼容旧格式自动迁移）
    const store = await loadStore(JSON_PATH);

    // 输入了内容
    if (inputAssetBundlePath) {
        // 输入的是版本号（非 URL）
        if (isVersionFormat(inputAssetBundlePath)) {
            version = inputAssetBundlePath;
            const main = mainVersion(version);
            const hash = store.hashes[main];
            if (!hash)
                throw new Error(`hashes 中缺少主版本 ${main} 的 hash，请先粘贴一次该主版本的完整 AssetBundleInfo URL 以自动记录`);
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
    // 未输入 → 从游戏 API 自动检测最新版本
    else {
        const app = await getAppVersions();
        version = app.dataVersion;
        store.latest = {
            clientVersion: app.clientVersion,
            dataVersion: app.dataVersion,
            masterDataVersion: app.masterDataVersion,
        };
        const main = mainVersion(version);
        const hash = store.hashes[main];
        if (!hash)
            throw new Error(`hashes 中缺少主版本 ${main} 的 hash，请先粘贴一次该主版本的完整 AssetBundleInfo URL 以自动记录`);
        url = ensureTimestamp(buildAssetBundleUrl(version, hash));
        console.log(`自动检测最新版本 → ${version}`);
        console.log(`构造 URL: ${url}`);
    }

    // 手动输入时也尽力刷新 latest 记录（失败不影响本次下载）
    let dirty = learnedHash !== null;
    if (!("dataVersion" in store.latest) || store.latest.dataVersion === undefined) dirty = true;
    if (!("dataVersion" in store.latest && store.latest.dataVersion === version)) {
        try {
            const app = await getAppVersions();
            store.latest = {
                clientVersion: app.clientVersion,
                dataVersion: app.dataVersion,
                masterDataVersion: app.masterDataVersion,
            };
            dirty = true;
        } catch { /* 保持旧 latest 记录 */ }
    }

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

    // 学习到新 hash → 记录到 hashes
    if (learnedHash) {
        store.hashes[mainVersion(version)] = learnedHash;
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
