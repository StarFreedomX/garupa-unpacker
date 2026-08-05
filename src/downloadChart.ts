/**
 * 下载指定歌曲的谱面文件并解包
 * 用法: npx tsx ./src/downloadChart.ts <bgmNumber>
 * 示例: npx tsx ./src/downloadChart.ts 106
 */
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { fileURLToPath } from "url";
import { AssetExporter } from "node-asset-studio-mod";
import { mainVersion, buildAssetBundleUrl, loadStore } from "./garupa/assetBundleInfo.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const URL_JSON_PATH = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");
const UNITY_VERSION = process.env.UNITY_VERSION!;

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

async function downloadFile(
    baseUrl: string,
    saveRoot: string,
    assetPath: string
): Promise<string> {
    const cleanPath = assetPath.startsWith("/") ? assetPath.substring(1) : assetPath;
    const url = `${baseUrl}${cleanPath}`;
    const savePath = path.join(saveRoot, cleanPath);

    if (fs.existsSync(savePath)) {
        console.log(`[跳过] 已存在: ${cleanPath}`);
        return savePath;
    }

    console.log(`[下载] ${url}`);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });

    const response = await axios.get(url, {
        responseType: "stream",
        timeout: 30000,
        headers: { "User-Agent": "garupa-getAssets/1.0.0" },
    });

    const writer = fs.createWriteStream(savePath);
    await new Promise<void>((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
    });

    console.log(`[完成] ${cleanPath}`);
    return savePath;
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
    const assetFileName = path.basename(bundlePath);
    console.log(`谱面包: ${bundlePath}`);

    // 3. 下载到 analysing
    const downloadDir = path.join(PROJECT_ROOT, "analysing", latestVersion);
    const savedPath = await downloadFile(baseUrl, downloadDir, bundlePath);
    console.log(`已保存到: ${savedPath}`);

    // 4. 导出解包
    const bundleId = Math.ceil(bgmNumber / 10) * 10;
    const outputDir = path.join(PROJECT_ROOT, "assets", latestVersion, `chart_bgm${bgmNumber}`);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`\n解包中... (Unity ${UNITY_VERSION})`);
    const exporter = new AssetExporter({
        unityVersion: UNITY_VERSION,
        assetType: ["all"],
        overwrite: true,
        group: "container",
        audioFormat: "wav",
    });

    // 输入是 analysing/{version}/{musicscore/musicscore100} 这个文件
    // 但 AssetExporter 需要的是目录路径...
    // 实际上 node-asset-studio-mod 的 exportAssets 接收 input 目录或文件
    // 我们需要把文件放到正确结构的目录里
    // 直接导出 asset bundle 文件
    const inputFileDir = path.dirname(savedPath);
    const inputFileName = path.basename(savedPath);

    // 我们将文件放入一个临时目录，让 AssetExporter 处理
    const tempInputDir = path.join(PROJECT_ROOT, "analysing", latestVersion, `_chart_extract_bgm${bgmNumber}`);
    if (fs.existsSync(tempInputDir)) {
        fs.rmSync(tempInputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempInputDir, { recursive: true });
    // 复制原始文件过去 (或创建硬链接)
    fs.copyFileSync(savedPath, path.join(tempInputDir, inputFileName));

    await exporter.exportAssets(tempInputDir, outputDir);

    // 清理临时目录
    fs.rmSync(tempInputDir, { recursive: true, force: true });

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
