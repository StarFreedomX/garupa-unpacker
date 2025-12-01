import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { AssetExporter, ExportAssetsDefaultConfig } from "node-asset-studio-mod";
import {fileURLToPath} from "url";

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const UNITY_VERSION = process.env.UNITY_VERSION!;

const PROJECT_ROOT = path.resolve(__dirname, ".."); // 项目根
const ASSETS_DIR = path.join(PROJECT_ROOT, "assets");
const ANALYSING_DIR = path.join(PROJECT_ROOT, "analysing");

/**
 * 获取 assets/ 下最新版本的文件夹名
 */
export function getLatestVersionFolder(baseDir: string): string | null {
    if (!fs.existsSync(baseDir)) return null;

    const dirs = fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    return dirs.length > 0 ? dirs[0] : null;
}

/**
 * 获取默认输入输出路径
 */
export function getDefaultPaths(): { input: string; output: string } {
    const latestVersion = getLatestVersionFolder(ANALYSING_DIR);
    if (!latestVersion) throw new Error(`analysing/ 下没有可用版本文件夹`);

    const input = path.join(ANALYSING_DIR, latestVersion);
    const output = path.join(ASSETS_DIR, latestVersion);

    if (!fs.existsSync(output)) fs.mkdirSync(output, { recursive: true });

    return { input, output };
}

/**
 * 获取输入文件夹的子文件夹并返回
 * @param input 输入文件夹路径
 * @return 文件夹名称，不是完整路径
 */
export function getCategoryPaths(input: string): string[] {
    // 读取 input 目录下的项目
    return fs.readdirSync(input, {withFileTypes: true})
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
}


/**
 * 使用 AssetExporter 对象导出资源
 */
export async function exportLatestAssets(config?: Partial<ExportAssetsDefaultConfig>) {
    const { input, output } = getDefaultPaths();

    // 新建对象
    const exporter = new AssetExporter({
        unityVersion: UNITY_VERSION,
        assetType: ["all"], // 默认类型
        overwrite: true,
        group: "container",
        audioFormat: "wav",
        ...config,
    });
    const categoryPaths = getCategoryPaths(input);

    for (const categoryPath of categoryPaths) {
        await exporter.exportAssets(path.join(input,categoryPath), path.join(output, categoryPath));
    }





    //await exporter.exportAssets(input, output);
}

if (isMainProcess) {
    (async () => {
        await exportLatestAssets();
    })();
}

