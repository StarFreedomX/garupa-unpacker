import { fileURLToPath } from "url";
import { downloadAB } from "@/downloadAssetBundleInfo.js";
import { compareVersions } from "@/compare.js";
import { downloadDiffAssets } from "@/getAssets.js";
import { exportLatestAssets, getCategoryPaths, getDefaultPaths } from "@/export.js";
import { removeUnchangedFiles } from "@/removeUnchangedFiles.js";
import { mergeAllSegmentedAcbFiles } from "@/mergeBytes.js";
import { decodeLatestAssets } from "@/decodeAcb.js";
import { flatFolder } from "@/flatFolder.js";
import path from "path";
import dotenv from "dotenv";
import fs from "node:fs";
import axios, { AxiosError } from "axios";

dotenv.config();

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

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

const REMOVE_OLD_FILES = process.env.REMOVE_OLD_FILES!;
const REMOVE_ANALYSING_FILES = process.env.REMOVE_ANALYSING_FILES!;


async function main() {
    console.log('正在执行完整流程......')
    const readline = await import('readline/promises');
    const process = await import('process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const inputQ1 = await rl.question("请输入 AssetBundleInfo URL或版本号（留空自动检测更新）：\n> ");

    let result: { version: string, filePath: string, url: string };
    while (true) {
        try {
            // const TARGET_URL = 'https://content.garupa.jp/Release/9.4.0.170_9b65fe761fdb81f51e8120fd5d1c90b0961c3b8845e1430a77c268a66f1e4015/Android/sound/voice_stamp';
            // const response = await axios.get(TARGET_URL);
            result = await downloadAB(inputQ1 || undefined);
            break; // 成功则跳出循环
        } catch (err) {
            if (axios.isAxiosError(err)) {
                const statusCode = err.response?.status;
                if (statusCode === 403) {
                    console.warn("403 Forbidden: 权限或频率受限，5秒后重试...");
                    await new Promise(resolve => setTimeout(resolve, 1000 * 20));
                    continue;
                }
                if (statusCode === 429) {
                    console.warn("429 Too Many Requests: 触发限流，60秒后重试...");
                    await new Promise(resolve => setTimeout(resolve, 1000 * 60));
                    continue;
                }

                // 如果是其他 4xx 错误（如 404），通常重试无意义，直接抛出
                if (statusCode && statusCode >= 400 && statusCode < 500) {
                    console.error(`客户端错误 ${statusCode}，放弃重试`);
                    throw err;
                }

                // 如果是 5xx 错误或网络超时
                console.log(`网络或服务器错误 (${statusCode || 'TIMEOUT'})，10秒后重试...`);
                await new Promise(resolve => setTimeout(resolve, 1000 * 10));
                continue;
            }

            // 非 Axios 错误（如代码逻辑错误），直接抛出
            throw err;
        }
    }
    console.log(`下载AssetBundleInfo完成: ${result.filePath}`);

    console.log('─'.repeat(60));

    console.log('对比文件中...');
    let outFile: string, summary: {added: number, changed: number}, versions: {verOld: string, verNew: string};
    try {
        ({outFile, summary, versions} = await compareVersions());
    }catch(err) {
        const inputQ2 = await rl.question("未找到已下载版本，请输入被比较的另一版本：\n> ");
        const result = await downloadAB(inputQ2 || undefined);
        console.log(`下载AssetBundleInfo完成: ${result.filePath}`);
        console.log('─'.repeat(60));
        console.log('对比文件中...');
        ({outFile, summary, versions} = await compareVersions());
    }

    console.log(`\n✔ 对比完成: ${versions.verOld} → ${versions.verNew}`);
    console.log(`新增: ${summary.added}, 修改: ${summary.changed}`);
    console.log(`结果已保存到: ${outFile}`);
    rl.close();

    console.log('─'.repeat(60));

    console.log('下载更改的文件...');
    await downloadDiffAssets(PROJECT_ROOT);

    console.log('─'.repeat(60));

    console.log('开始进行解包...');
    await exportLatestAssets();

    console.log('─'.repeat(60));

    console.log('文件去重中...')
    const {input, output} = getDefaultPaths();
    const categoryFolders = getCategoryPaths(input);
    // 处理 change 与 change_old
    if (categoryFolders.includes("change") && categoryFolders.includes("change_old")) {
        await removeUnchangedFiles(
            path.join(output, "change_old"),
            path.join(output, "change"),
            REMOVE_OLD_FILES === 'true'
        );
    } else {
        console.log("未找到 change/change_old 文件夹，跳过比较。");
    }

    console.log('─'.repeat(60));

    console.log('合并分段acb文件...');
    await mergeAllSegmentedAcbFiles(output);

    console.log('─'.repeat(60));

    console.log('解析acb文件...');
    await decodeLatestAssets();

    console.log('─'.repeat(60));

    console.log('扁平化路径...')
    await flatFolder(output)

    console.log('─'.repeat(60));

    if (REMOVE_ANALYSING_FILES === 'true') {
        console.log('清理中间文件中...')
        await fs.promises.rm(getDefaultPaths().input, { recursive: true, force: true });
        console.log('─'.repeat(60));
    }

    console.log('解包完成')







}
if (isMainProcess)
    main();
