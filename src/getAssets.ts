import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url'; // 引入用于路径计算的模块
import axios, { AxiosInstance, AxiosError } from 'axios';
import { glob } from 'glob';
import pLimit from 'p-limit';

// --- 配置常量 (只定义名称) ---
const MAX_CONCURRENT_DOWNLOADS = 10; // 最大并发下载数
const PER_FILE_RETRIES = 3;           // 单个文件最大重试次数
const PER_FILE_BACKOFF_SECONDS = 1.0; // 单次重试基础等待时间 (秒)
const TIMEOUT_MS = 30000;             // 单次请求超时时间 (毫秒, 30s)
const HEADERS = {
    "User-Agent": "garupa-getAssets/1.0 (+https://example.com)"
};
// 路径名称（相对于项目根目录）
const URL_JSON_NAME = "AssetBundleInfoUrl.json";
const DIFF_DIR_NAME = "compare";
const ASSETS_DIR_NAME = "assets";
const ANALYSING_DIR_NAME = "analysing";

// --- 工具函数 ---

/**
 * 将版本字符串转换为可排序的数字数组。
 * 支持四位版本号 + 递增号。
 */
function versionKey(v: string): number[] {
    let parts = v.split(".");
    // 检查是否有递增号（第五部分）
    let extraNum = 1;
    if (parts.length > 4) {
        extraNum = parseInt(parts.pop()!, 10) || 1;
    }

    const baseParts = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n));

    // 确保至少有 4 个基础版本号，没有则补 0
    while (baseParts.length < 4) {
        baseParts.push(0);
    }

    return [...baseParts.slice(0, 4), extraNum];
}

/**
 * 从 AssetBundleInfo 的 URL 中提取资源前缀。
 */
function extractPrefix(url: string): string {
    const parts = url.split("/AssetBundleInfo");
    return parts[0] + "/";
}

/**
 * 找到 compare 目录下最新修改的差异文件。
 * 接受 DIFF_DIR 的绝对路径。
 */
async function getLatestDiff(fullDiffDir: string): Promise<string> {
    // 1. 构造完整的模式路径
    const patternPath = path.join(fullDiffDir, "assetsList_from_*_to_*.txt");

    // 2. 强制将 Windows 反斜杠替换为正斜杠，确保 glob 模式能正确识别
    const globPattern = patternPath.replace(/\\/g, '/');

    const files = await glob(globPattern);

    if (files.length === 0) {
        // 报错信息中显示正确的路径
        throw new Error(`错误: ${fullDiffDir} 目录中没有差异文件 (assetsList_from_..._to_....txt)`);
    }

    // 找到最新修改的文件
    const fileStats = await Promise.all(
        files.map(async f => ({
            path: f,
            mtime: (await fs.stat(f)).mtime.getTime()
        }))
    );

    fileStats.sort((a, b) => b.mtime - a.mtime);
    return fileStats[0].path;
}

/**
 * 创建 Axios 实例 (相当于 Python 的 Session + Adapter)
 */
function prepareAxios(): AxiosInstance {
    const instance = axios.create({
        timeout: TIMEOUT_MS,
        headers: HEADERS,
        // Axios 默认会处理 4xx/5xx 状态码为错误，不需要额外的重试逻辑
    });
    return instance;
}

/**
 * 下载单个文件，包含重试和退避逻辑。
 * @returns 成功返回 true, 最终失败返回 false
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

    let attempt = 0;
    let backoff = PER_FILE_BACKOFF_SECONDS;

    while (attempt < PER_FILE_RETRIES) {
        attempt += 1;
        try {
            await fs.mkdir(path.dirname(savePath), { recursive: true });

            // 使用 axios 下载文件流
            const response = await axiosInstance.get(url, {
                responseType: 'stream',
            });

            // 使用动态导入 'fs' 解决一些 TS/Node ESM 的兼容性问题
            const writer = (await import('fs')).createWriteStream(savePath);

            // 将响应流通过管道写入文件
            await new Promise<void>((resolve, reject) => {
                response.data.pipe(writer);

                // 使用匿名函数包装 resolve，以匹配 finish 事件的 () => void 签名
                writer.on('finish', () => resolve());

                writer.on('error', reject);
            });

            console.log(`完成: ${cleanPath}`);
            return true;

        } catch (e) {
            if (axios.isAxiosError(e)) {
                const status = e.response?.status;

                // 403 / 404 等客户端错误，不重试
                if (status === 403 || status === 404) {
                    console.log(`[失败] ${cleanPath} -> HTTP ${status} (不重试)`);
                    return false;
                }

                // 其他网络或服务器错误，准备重试
                console.log(`[请求异常] ${cleanPath} -> 状态码 ${status || '无'} (尝试 ${attempt}/${PER_FILE_RETRIES})`);

            } else {
                console.log(`[未知错误] ${cleanPath} -> ${(e as Error).message} (尝试 ${attempt}/${PER_FILE_RETRIES})`);
            }

            // 如果还有重试次数，等待并翻倍退避时间
            if (attempt < PER_FILE_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, backoff * 1000));
                backoff *= 2;
            } else {
                break; // 达到最大重试次数，退出循环
            }
        }
    }

    console.log(`[最终失败] ${cleanPath}`);
    return false;
}

// --- 主函数 ---

async function main() {
    // 1. 确定项目根目录 (Project Root)
    // 脚本路径是 /project/src/getAssets.ts，我们需要 /project/
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const PROJECT_ROOT = path.resolve(__dirname, '..');

    // 2. 解析所有关键文件的绝对路径
    const FULL_URL_JSON_PATH = path.join(PROJECT_ROOT, URL_JSON_NAME);
    const FULL_DIFF_DIR = path.join(PROJECT_ROOT, DIFF_DIR_NAME);
    const FULL_ASSETS_DIR = path.join(PROJECT_ROOT, ASSETS_DIR_NAME);
    const FULL_ANALYSING_DIR = path.join(PROJECT_ROOT, ANALYSING_DIR_NAME);

    console.log(`正在读取 ${URL_JSON_NAME} (${FULL_URL_JSON_PATH}) ...`);
    let urlMap: { [key: string]: string };
    try {
        const content = await fs.readFile(FULL_URL_JSON_PATH, { encoding: 'utf-8' });
        urlMap = JSON.parse(content);
    } catch (e) {
        console.error(`错误：找不到或无法解析 ${URL_JSON_NAME}`);
        return;
    }

    if (Object.keys(urlMap).length === 0) {
        console.error(`${URL_JSON_NAME} 为空`);
        return;
    }

    // 找到最新版本
    const sortedVersions = Object.keys(urlMap).sort((a, b) => {
        const keyA = versionKey(a);
        const keyB = versionKey(b);
        for (let i = 0; i < keyA.length; i++) {
            if (keyA[i] !== keyB[i]) {
                return keyA[i] - keyB[i];
            }
        }
        return 0;
    });

    const latestVersion = sortedVersions[sortedVersions.length - 1];
    const latestUrl = urlMap[latestVersion];

    console.log(`检测到最新版本：${latestVersion}`);
    console.log(`源地址：${latestUrl}`);

    const baseUrl = extractPrefix(latestUrl);
    console.log(`资源前缀：${baseUrl}`);

    let diffFile: string;
    try {
        // 使用绝对路径调用 getLatestDiff
        diffFile = await getLatestDiff(FULL_DIFF_DIR);
    } catch (e) {
        console.error((e as Error).message);
        return;
    }

    console.log(`使用差异文件：${diffFile}`);

    // 提取 diff 文件目标版本号
    const match = diffFile.match(/_to_(\d+\.\d+\.\d+\.\d+(?:\.\d+)?)\.txt$/);
    if (!match) {
        throw new Error("无法从差异文件解析版本号");
    }
    const diffVersion = match[1];
    console.log(`将下载差异资源：${diffVersion}`);

    const saveRoot = path.join(FULL_ASSETS_DIR, diffVersion);
    const analyseRoot = path.join(FULL_ANALYSING_DIR, diffVersion);
    await fs.mkdir(saveRoot, { recursive: true });
    await fs.mkdir(analyseRoot, { recursive: true });

    // 读取差异文件
    const diffContent = await fs.readFile(diffFile, { encoding: 'utf-8' });
    const assetPaths = diffContent.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));

    console.log(`资源数量：${assetPaths.length}`);
    console.log(`开始下载到：${saveRoot}\n`);

    const axiosInstance = prepareAxios();

    // 使用 p-limit 控制并发数
    const limit = pLimit(MAX_CONCURRENT_DOWNLOADS);

    const downloadPromises = assetPaths.map(assetPath =>
        limit(() => downloadFile(axiosInstance, baseUrl, saveRoot, assetPath))
    );

    const results = await Promise.all(downloadPromises);

    const failedPaths: string[] = [];
    results.forEach((success, index) => {
        if (!success) {
            failedPaths.push(assetPaths[index]);
        }
    });

    if (failedPaths.length > 0) {
        // 使用绝对路径创建 compare 目录
        await fs.mkdir(FULL_DIFF_DIR, { recursive: true });
        const failedFile = path.join(FULL_DIFF_DIR, `failed_downloads_${diffVersion}.txt`);
        await fs.writeFile(failedFile, failedPaths.join('\n') + '\n', 'utf-8');
        console.log(`\n部分资源下载失败 (${failedPaths.length} 个)，已写入: ${failedFile}`);
    } else {
        console.log("\n全部资源下载成功。");
    }
}

main().catch(err => {
    console.error("程序执行错误:", err instanceof Error ? err.message : err);
    process.exit(1);
});