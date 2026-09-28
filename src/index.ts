import { fileURLToPath } from "url";
import { downloadAB, refreshAppData } from "@/downloadAssetBundleInfo.js";
import { compareVersions } from "@/compare.js";
import { downloadDiffAssets } from "@/getAssets.js";
import { loadStore, saveStore, extractVersionFromUrl } from "@/garupa/assetBundleInfo.js";
import { unpackTargetVersion } from "@/unpackServer/version.js";
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

/** 下载 AssetBundleInfo（带 403/429/5xx 重试循环） */
async function downloadWithRetry(input: string): Promise<{ version: string, filePath: string, url: string }> {
    while (true) {
        try {
            return await downloadAB(input);
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const statusCode = err.response?.status;
                if (statusCode === 403) {
                    console.warn("403 Forbidden: 目标版本可能尚未发布或请求受限，20秒后重试...");
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
        const inputNew = (await rl.question("请输入新版本 AssetBundleInfo URL 或版本号（回车推算下一个版本并等待发布）：\n> ")).trim();
        const inputOld = (await rl.question("请输入旧版本 AssetBundleInfo URL 或版本号（回车用本机当前版本）：\n> ")).trim();
        const isVersionFormat = /^\d+\.\d+\.\d+\.\d+$/.test(inputNew);

        // 3. 确定 old：输入或默认本机已完整解包的版本
        let oldVersion: string | undefined;
        let oldDownloadInput: string | undefined;
        if (inputOld) {
            oldVersion = extractVersionFromUrl(inputOld) || inputOld;
            oldDownloadInput = isVersionFormat ? oldVersion : inputOld;
        } else {
            oldVersion = store.nowDataVersion;
            oldDownloadInput = oldVersion;
        }
        if (!oldVersion) {
            const inputOld2 = (await rl.question("未记录本机当前版本，请输入旧版本（版本号或 URL）：\n> ")).trim();
            if (!inputOld2) throw new Error("未提供旧版本，无法继续");
            oldVersion = extractVersionFromUrl(inputOld2) || inputOld2;
            oldDownloadInput = /^\d+\.\d+\.\d+\.\d+$/.test(inputOld2) ? oldVersion : inputOld2;
        }

        // 4. 确定 new：手动目标直接使用；留空则从 application 版本推算下一个 CDN 版本
        const requestedNewVersion = inputNew ? extractVersionFromUrl(inputNew) || inputNew : undefined;
        const observed = appInfo?.dataVersion || store.latest.dataVersion || oldVersion;
        const newVersion = unpackTargetVersion(observed, oldVersion, requestedNewVersion, Object.keys(store.hashes));
        if (!inputNew) {
            console.log(`自动推算目标版本: ${observed} → ${newVersion}`);
        } else if (requestedNewVersion === oldVersion) {
            console.log(`目标与本机当前版本相同，改为等待 ${newVersion}`);
        }

        // 5. 下载 new（手动 URL 仅在目标版本未被推算替换时使用）
        const newDownloadInput = (inputNew && !isVersionFormat && extractVersionFromUrl(inputNew) === newVersion) ? inputNew : newVersion;
        console.log('─'.repeat(60));
        console.log(`下载新版本 AssetBundleInfo: ${newVersion} ...`);
        await downloadWithRetry(newDownloadInput);
        console.log(`下载AssetBundleInfo完成: ${newVersion}`);

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
                throw new Error(`处理失败 ${result.failed}/${result.total} 个 bundle；已写出的结果保留在 ${result.output}，重跑会重新下载处理`);
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
