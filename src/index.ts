import { fileURLToPath } from "url";
import { downloadAB, refreshAppData } from "@/downloadAssetBundleInfo.js";
import { compareVersions, listDownloadedVersions } from "@/compare.js";
import { downloadDiffAssets } from "@/getAssets.js";
import { flatFolder } from "@/flatFolder.js";
import { loadStore, saveStore, extractVersionFromUrl } from "@/garupa/assetBundleInfo.js";
import path from "path";
import dotenv from "dotenv";
import fs from "node:fs";
import axios from "axios";

dotenv.config();

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const JSON_PATH = "AssetBundleInfoUrl.json";

const envPath = path.resolve(__dirname, "../.env");
const examplePath = path.resolve(__dirname, "../.env.example");

// 优先使用 .env，没有就自动 fallback 到 .env.example
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log("Loaded: .env");
} else if (fs.existsSync(examplePath)) {
    dotenv.config({ path: examplePath });
    console.log("Loaded: .env.example");
} else {
    console.warn("Warning: No .env or .env.example found.");
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 点分版本号数字比较：a < b 返回 true */
function versionLess(a: string, b: string): boolean {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na < nb;
    }
    return false;
}

/** 下载 AssetBundleInfo（带 403/429/5xx 重试循环） */
async function downloadWithRetry(input: string): Promise<{ version: string, filePath: string, url: string }> {
    while (true) {
        try {
            return await downloadAB(input);
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const statusCode = err.response?.status;
                if (statusCode === 403) {
                    console.warn("403 Forbidden: 权限或频率受限，20秒后重试...");
                    await sleep(1000 * 20);
                    continue;
                }
                if (statusCode === 429) {
                    console.warn("429 Too Many Requests: 触发限流，60秒后重试...");
                    await sleep(1000 * 60);
                    continue;
                }

                // 如果是其他 4xx 错误（如 404），通常重试无意义，直接抛出
                if (statusCode && statusCode >= 400 && statusCode < 500) {
                    console.error(`客户端错误 ${statusCode}，放弃重试`);
                    throw err;
                }

                // 如果是 5xx 错误或网络超时
                console.log(`网络或服务器错误 (${statusCode || 'TIMEOUT'})，10秒后重试...`);
                await sleep(1000 * 10);
                continue;
            }

            // 非 Axios 错误（如代码逻辑错误），直接抛出
            throw err;
        }
    }
}

async function main() {
    console.log('正在执行完整流程......')
    const readline = await import('readline/promises');
    const process = await import('process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        // 读取 store（含 nowDataVersion）
        const store = await loadStore(JSON_PATH);

        // 1. 刷新 application（一次，失败不中断）
        const appInfo = await refreshAppData(store);

        // 2. 两个输入框
        const inputNew = (await rl.question("请输入新版本 AssetBundleInfo URL 或版本号（回车自动检测）：\n> ")).trim();
        const inputOld = (await rl.question("请输入旧版本 AssetBundleInfo URL 或版本号（回车用本机当前版本）：\n> ")).trim();

        // 3. 确定 new：输入（版本号直接 / URL 提取）或默认 latest.dataVersion
        let newVersion: string;
        if (inputNew) {
            newVersion = extractVersionFromUrl(inputNew) || inputNew;
        } else {
            newVersion = appInfo?.dataVersion || store.latest.dataVersion || "";
            if (!newVersion) throw new Error("无法自动检测新版本，请手动输入版本号或 URL");
        }

        // 4. 下载 new（URL 输入走 URL 模式学习 hash；版本号/默认走版本号模式，避免二次刷新 application）
        const isVersionFormat = /^\d+\.\d+\.\d+\.\d+$/.test(inputNew);
        const newDownloadInput = (inputNew && !isVersionFormat) ? inputNew : newVersion;
        console.log('─'.repeat(60));
        console.log(`下载新版本 AssetBundleInfo: ${newVersion} ...`);
        await downloadWithRetry(newDownloadInput);
        console.log(`下载AssetBundleInfo完成: ${newVersion}`);

        // 5. 确定 old：输入或默认 nowDataVersion；now 空/相同则回退 AssetBundleInfo/ 目录相邻旧版本
        let oldVersion: string | undefined;
        let oldDownloadInput: string | undefined;
        if (inputOld) {
            oldVersion = extractVersionFromUrl(inputOld) || inputOld;
            oldDownloadInput = isVersionFormat ? oldVersion : inputOld;
        } else {
            oldVersion = store.nowDataVersion;
            if (!oldVersion || oldVersion === newVersion) {
                const downloaded = await listDownloadedVersions();
                const older = downloaded.filter(v => versionLess(v, newVersion));
                oldVersion = older.length ? older[older.length - 1] : undefined;
            }
            oldDownloadInput = oldVersion;
        }
        // 目录相邻也没有 → 让用户再输入一次
        if (!oldVersion) {
            const inputOld2 = (await rl.question("未找到旧版本文件，请输入旧版本（版本号或 URL）：\n> ")).trim();
            if (!inputOld2) throw new Error("未提供旧版本，无法继续");
            oldVersion = extractVersionFromUrl(inputOld2) || inputOld2;
            oldDownloadInput = /^\d+\.\d+\.\d+\.\d+$/.test(inputOld2) ? oldVersion : inputOld2;
        }

        // 6. 下载 old
        console.log('─'.repeat(60));
        console.log(`下载旧版本 AssetBundleInfo: ${oldVersion} ...`);
        await downloadWithRetry(oldDownloadInput!);
        console.log(`下载AssetBundleInfo完成: ${oldVersion}`);

        console.log('─'.repeat(60));

        // 7. 对比生成 diff
        console.log('对比文件中...');
        const { outFile, diff, summary, versions } = await compareVersions(newVersion, oldVersion);
        console.log(`\n✔ 对比完成: ${versions.verOld} → ${versions.verNew}`);
        console.log(`新增: ${summary.added}, 修改: ${summary.changed}`);
        console.log(`结果已保存到: ${outFile}`);

        // 8. 解包流程（全部成功后更新 nowDataVersion；中途失败/中止不更新）
        try {
            console.log('─'.repeat(60));

            console.log('边下载边解包，在内存中去重并解码音频...');
            const result = await downloadDiffAssets(PROJECT_ROOT, outFile, diff);
            if (result.failed > 0) {
                throw new Error(`处理失败 ${result.failed}/${result.total} 个 bundle；原输出保持不变，重跑会重新下载处理`);
            }

            console.log('扁平化路径...');
            // Keep assets/<version> stable even when only one category is present.
            for (const entry of await fs.promises.readdir(result.output, { withFileTypes: true })) {
                if (entry.isDirectory()) await flatFolder(path.join(result.output, entry.name));
            }

            // 提交点：解包全部成功后更新本机当前已解包版本
            const completedStore = await loadStore(JSON_PATH);
            completedStore.nowDataVersion = versions.verNew;
            await saveStore(completedStore, JSON_PATH);
            console.log(`已更新 nowDataVersion: ${versions.verNew}`);

            console.log('解包完成')
        } catch (err) {
            console.error("解包流程失败，nowDataVersion 未更新:", err instanceof Error ? err.message : err);
            process.exitCode = 1;
        }
    } catch (err) {
        console.error("流程失败:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    } finally {
        rl.close();
    }
}
if (isMainProcess)
    main();
