import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import axios, { AxiosInstance } from 'axios';
import { glob } from 'glob';
import pLimit from 'p-limit';
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const MAX_CONCURRENT_DOWNLOADS = 10;
const PER_FILE_RETRIES = 3;
const PER_FILE_BACKOFF_SECONDS = 1.0;
const TIMEOUT_MS = 30000;

const HEADERS = {
    "User-Agent": "garupa-getAssets/1.0.0"
};

const URL_JSON_NAME = "AssetBundleInfoUrl.json";
const DIFF_DIR_NAME = "compare";
const ASSETS_DIR_NAME = "analysing";

/**
 * 获取资源路径URL前缀
 * @param url
 */
function extractPrefix(url: string): string {
    const parts = url.split("/AssetBundleInfo");
    return parts[0] + "/";
}

/** 比较版本，用于排序 */
function compareVersion(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < pa.length; i++) {
        if (pa[i] !== pb[i]) return pb[i] - pa[i];
    }
    return 0;
}

/** 解析 diff 文件并返回最新版本差异文件路径 */
async function getLatestDiffByVersion(diffDir: string): Promise<string> {
    const globPattern = path.join(diffDir, "diff_*_to_*.json").replace(/\\/g, "/");
    const diffFiles = await glob(globPattern);
    if (!diffFiles.length) throw new Error(`未找到差异文件 (${DIFF_DIR_NAME}/diff_x_to_x.json)`);

    const parsed = diffFiles.map(f => {
        const name = path.basename(f);
        const match = name.match(/diff_(\d+\.\d+\.\d+\.\d+)_to_(\d+\.\d+\.\d+\.\d+)\.json$/);
        return match ? { file: f, newVer: match[2] } : null;
    }).filter(Boolean) as { file: string, newVer: string }[];

    //排序
    parsed.sort((a, b) => compareVersion(a.newVer, b.newVer));

    return parsed[0].file;
}

/**
 * 下载函数
 * @param axiosInstance
 * @param baseUrl 下载资源的网络地址前缀
 * @param saveRoot 保存根路径，如
 * @param assetPath 资源路径
 */
async function downloadFile(
    axiosInstance: AxiosInstance,
    baseUrl: string,
    saveRoot: string,
    assetPath: string
): Promise<boolean> {

    const cleanPath = assetPath.startsWith("/") ? assetPath.substring(1) : assetPath;
    const url = `${baseUrl}${cleanPath}`;
    const savePath = path.join(saveRoot, cleanPath);

    // 🟢 检查是否已存在，不重复下载
    try {
        await fs.access(savePath);
        console.log(`[跳过] 已存在: ${cleanPath}`);
        return true; // 直接成功
    } catch {
        // 文件不存在 -> 要下载
    }

    let attempt = 0;
    let backoff = PER_FILE_BACKOFF_SECONDS;

    while (attempt < PER_FILE_RETRIES) {
        attempt++;

        try {
            await fs.mkdir(path.dirname(savePath), { recursive: true });
            const response = await axiosInstance.get(url, { responseType: 'stream' });
            const writer = (await import('fs')).createWriteStream(savePath);

            await new Promise<void>((resolve, reject) => {
                response.data.pipe(writer);
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log(`完成: ${cleanPath}`);
            return true;

        } catch (e: any) {
            const status = e.response?.status;
            if (status === 403 || status === 404) {
                console.log(`[失败] ${cleanPath} -> HTTP ${status} (不重试)`);
                return false;
            }

            console.log(`[异常] ${cleanPath} -> ${status || '未知'} (第 ${attempt}/${PER_FILE_RETRIES} 次)`);

            if (attempt < PER_FILE_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, backoff * 1000));
                backoff *= 2;
            }
        }
    }

    console.log(`[最终失败] ${cleanPath}`);
    return false;
}

export async function downloadDiffAssets(PROJECT_ROOT: string): Promise<void> {

    // AssetBundleInfo下载地址的json文件路径
    const FULL_URL_JSON_PATH = path.join(PROJECT_ROOT, URL_JSON_NAME);
    // diff文件的位置
    const FULL_DIFF_DIR = path.join(PROJECT_ROOT, DIFF_DIR_NAME);
    // 导出的assets路径
    const FULL_ASSETS_DIR = path.join(PROJECT_ROOT, ASSETS_DIR_NAME);

    console.log(`读取版本 URL 映射: ${FULL_URL_JSON_PATH}`);
    const urlMap = JSON.parse(await fs.readFile(FULL_URL_JSON_PATH, "utf-8"));

    // 最新的diff文件路径
    const diffFile = await getLatestDiffByVersion(FULL_DIFF_DIR);
    console.log(`使用最新差异文件：${path.basename(diffFile)}`);

    // 正则匹配
    const match = diffFile.match(/diff_(\d+\.\d+\.\d+\.\d+)_to_(\d+\.\d+\.\d+\.\d+)\.json$/);
    if (!match) throw new Error("diff 文件格式错误!");

    const oldVersion = match[1];
    const newVersion = match[2];

    console.log(`旧版本: ${oldVersion}`);
    console.log(`新版本: ${newVersion}`);

    const diffJson: {"new": string[], "change": string[]} = JSON.parse(await fs.readFile(diffFile, "utf8"));

    const axiosInstance = axios.create({
        timeout: TIMEOUT_MS,
        headers: HEADERS
    });
    const baseUrlNew = extractPrefix(urlMap[newVersion]);
    const baseUrlOld = extractPrefix(urlMap[oldVersion]);

    const newRoot = path.join(FULL_ASSETS_DIR, newVersion);
    const dirNew = path.join(newRoot, "new");
    const dirChange = path.join(newRoot, "change");
    const dirChangeOld = path.join(newRoot, "change_old");

    await fs.mkdir(dirNew, { recursive: true });
    await fs.mkdir(dirChange, { recursive: true });
    await fs.mkdir(dirChangeOld, { recursive: true });

    const limit = pLimit(MAX_CONCURRENT_DOWNLOADS);

    const tasks = [
        ...diffJson.new.map((f: string) => limit(() => downloadFile(axiosInstance, baseUrlNew, dirNew, f))),
        ...diffJson.change.map((f: string) => limit(() => downloadFile(axiosInstance, baseUrlNew, dirChange, f))),
        ...diffJson.change.map((f: string) => limit(() => downloadFile(axiosInstance, baseUrlOld, dirChangeOld, f)))
    ];

    console.log(`开始下载 NEW(${diffJson.new.length}) + CHANGE(${diffJson.change.length * 2}) ...\n`);

    await Promise.all(tasks);

    console.log(`下载完成 -> assets/${newVersion}/`);
}



async function main() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const PROJECT_ROOT = path.resolve(__dirname, '..');

    await downloadDiffAssets(PROJECT_ROOT);
}
if (isMainProcess){
    main().catch(err => {
        console.error("程序错误:", err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
