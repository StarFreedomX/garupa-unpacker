/**
 * 下载指定歌曲的谱面文件并解包
 * 用法: npx tsx ./src/downloadChart.ts <bgmNumber>
 * 示例: npx tsx ./src/downloadChart.ts 106
 */
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { downloadBundle, unpackBundle, withStagedOutput, writeMemoryFiles } from "./memoryAssets.js";
import { mainVersion, buildAssetBundleUrl, loadStore } from "./garupa/assetBundleInfo.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const URL_JSON_PATH = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");

function extractPrefix(url: string): string {
    const parts = url.split("/AssetBundleInfo");
    return parts[0] + "/";
}

/**
 * 根据 bgmNumber 找到对应的 musicscore 包。
 * musicscore 包以10为单位，但编号是歌曲编号范围的上界（如 musicscore100 包含 91-100）
 * 所以: 找 >= bgmNumber 的最近的10的倍数
 */
function getMusicScoreBundleName(bgmNumber: number): string {
    const bundleId = Math.ceil(bgmNumber / 10) * 10;
    return `musicscore/musicscore${bundleId}`;
}

async function main() {
    const bgmNumber = parseInt(process.argv[2] || "106", 10);
    if (isNaN(bgmNumber)) {
        console.error("用法: npx tsx ./src/downloadChart.ts <bgmNumber>");
        process.exit(1);
    }

    console.log(`目标: BGM ${bgmNumber} (曲${bgmNumber})`);

    // 1. 读取版本记录，取 latest.dataVersion 作为最新版本
    const store = await loadStore(URL_JSON_PATH);
    const latestVersion = store.latest.dataVersion;
    if (!latestVersion) throw new Error("AssetBundleInfoUrl.json 缺少 latest.dataVersion，请先运行 downloadAssetBundleInfo 自动检测一次");
    const hash = store.hashes[mainVersion(latestVersion)];
    if (!hash) throw new Error(`hashes 缺少主版本 ${mainVersion(latestVersion)} 的 hash，请先运行 downloadAssetBundleInfo 粘贴一次该主版本 URL`);
    const baseUrl = extractPrefix(buildAssetBundleUrl(latestVersion, hash));
    console.log(`使用版本: ${latestVersion}`);
    console.log(`CDN 前缀: ${baseUrl}`);

    // 2. 确定 musicscore 包名
    const bundlePath = getMusicScoreBundleName(bgmNumber);
    console.log(`谱面包: ${bundlePath}`);

    // Download and decode in memory; only final chart files are written.
    const outputDir = path.join(PROJECT_ROOT, "assets", latestVersion, `chart_bgm${bgmNumber}`);
    await withStagedOutput(outputDir, async stage => {
        const files = await unpackBundle(await downloadBundle(baseUrl, bundlePath));
        await writeMemoryFiles(stage, files);
    });
    console.log(`解包完成，输出目录: ${outputDir}\n`);

    // 5. 查找 easy 谱面
    function findFiles(dir: string, pattern: RegExp): string[] {
        const results: string[] = [];
        function walk(d: string) {
            const entries = fs.readdirSync(d, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                } else if (pattern.test(entry.name)) {
                    results.push(fullPath);
                }
            }
        }
        walk(dir);
        return results;
    }

    const chartFiles = findFiles(outputDir, /easy\.txt$/i);
    const allTxtFiles = findFiles(outputDir, /\.txt$/i);

    console.log("=== 找到的 easy 谱面文件 ===");
    if (chartFiles.length > 0) {
        for (const f of chartFiles) {
            console.log(`  ${path.relative(PROJECT_ROOT, f)}`);
            // 显示文件内容前几行
            const content = fs.readFileSync(f, "utf-8").substring(0, 500);
            console.log(`\n--- 文件预览 (前500字符) ---`);
            console.log(content);
            console.log("--- 结束 ---\n");
        }
    } else {
        console.log("  未找到 easy 谱面，显示所有 .txt 文件:");
        for (const f of allTxtFiles) {
            console.log(`  ${path.relative(PROJECT_ROOT, f)}`);
        }
    }

    console.log(`\n输出目录: ${outputDir}`);
}

main().catch((err) => {
    console.error("错误:", err instanceof Error ? err.message : err);
    process.exit(1);
});
