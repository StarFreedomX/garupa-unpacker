import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';

const JSON_PATH = "AssetBundleInfoUrl.json";
const BASE_NAME = "AssetBundleInfo";
const OUT_DIR = BASE_NAME;
/**
 * 从 URL 中提取版本号。
 * 例如：https://.../Release/9.3.0.170_xxx/Android/AssetBundleInfo
 * 返回：9.3.0.170
 */
function extractVersion(url: string): string | null {
    const match = url.match(/\/Release\/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}

/**
 * 确保 URL 中包含时间戳参数（t=...）。
 * 如果 URL 中已包含 t=，则直接返回原 URL。
 * 否则，在 URL 末尾添加当前时间的 yyyyMMddHHmmss 格式时间戳。
 *
 * @param url 需要处理的 URL 字符串。
 * @returns 包含时间戳的 URL 字符串。
 */
function ensureTimestamp(url: string): string {
    // 1. 检查 URL 中是否已包含 t= 参数，如果包含，直接返回
    if (url.includes("t=")) {
        return url;
    }

    // 2. 确定分隔符是 ? 还是 &
    const sep = url.includes("?") ? "&" : "?";

    // 3. 生成 yyyyMMddHHmmss 格式的时间字符串
    const now = new Date();

    // 辅助函数：确保数字前面有零（如 5 -> '05'）
    const pad = (num: number): string => num.toString().padStart(2, '0');

    const year = now.getFullYear().toString(); // yyyy
    const month = pad(now.getMonth() + 1);    // MM (getMonth() 是 0-11)
    const day = pad(now.getDate());           // dd
    const hours = pad(now.getHours());        // HH
    const minutes = pad(now.getMinutes());    // mm
    const seconds = pad(now.getSeconds());    // ss

    // 拼接成 yyyyMMddHHmmss 格式
    const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}`;

    // 4. 拼接 URL
    return `${url}${sep}t=${timestamp}`;
}

/**
 * 计算文件 MD5
 */
async function calcFileMD5(filePath: string): Promise<string | null> {
    try {
        await fs.access(filePath);
    } catch {
        return null; // 文件不存在
    }

    const hash = crypto.createHash('md5');
    // 使用流式读取，避免大文件占用过多内存
    const fileStream = (await import('fs')).createReadStream(filePath);

    return new Promise<string>((resolve, reject) => {
        fileStream.on('data', (data) => hash.update(data));
        fileStream.on('error', (err) => reject(err));
        fileStream.on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * 查找当前目录已有的版本号文件，返回新的文件路径。
 * 例如：如果已有 AssetBundleInfo_9.3.0.170.txt 和 AssetBundleInfo_9.3.0.170.2.txt
 * 返回 AssetBundleInfo_9.3.0.170.3.txt
 */
async function getNextVersionedPath(
    baseDir: string,
    baseName: string,
    version: string,
    ext: string = ".txt"
): Promise<string> {
    const pattern = new RegExp(`^${baseName}_${version}(?:\\.(\\d+))?${ext.replace(/\./g, '\\.')}$`);
    let existing: number[] = [];

    try {
        const files = await fs.readdir(baseDir);
        for (const f of files) {
            const match = f.match(pattern);
            if (match) {
                // 如果是 AssetBundleInfo_9.3.0.170.txt，match[1] 为 undefined，视为版本号 1
                const num = match[1] ? parseInt(match[1], 10) : 1;
                existing.push(num);
            }
        }
    } catch (e) {
        // 目录不存在或读取失败，忽略
    }

    if (existing.length === 0) {
        return path.join(baseDir, `${baseName}_${version}${ext}`);
    }

    const nextNum = Math.max(...existing) + 1;
    return path.join(baseDir, `${baseName}_${version}.${nextNum}${ext}`);
}

/**
 * 递增版本号的最后一个部分 (递增 10)。
 * 例如：9.3.0.180 -> 9.3.0.190
 *
 * @param version 版本号字符串 (例如: "9.3.0.180")
 * @returns 递增 10 后的版本号字符串
 */
function incrementVersion(version: string): string {
    const parts = version.split('.');
    if (parts.length === 0) {
        return '1.0.0.10'; // 默认起始版本
    }

    // 尝试递增最后一个数字部分
    const lastPartIndex = parts.length - 1;
    const lastPart = parts[lastPartIndex];
    const num = parseInt(lastPart, 10);

    if (isNaN(num)) {
        // 如果最后一部分不是数字，则在末尾追加 .10
        return `${version}.10`;
    }

    // 递增 10 并重新组合
    const increment = 10; // <--- 关键修改点：步长设为 10
    parts[lastPartIndex] = (num + increment).toString();
    return parts.join('.');
}


/**
 * 主函数
 */
async function main() {
    // 导入 readline 模块用于获取用户输入
    const readline = await import('readline/promises');
    const process = await import('process');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    let inputUrl = await rl.question("请输入 AssetBundleInfo 的下载地址 (留空将自动检查更新):\n> ");
    rl.close();
    inputUrl = inputUrl.trim();

    let url: string = '';
    let version: string = '';
    let urlMap: { [key: string]: string } = {};

    // 1. 预先读取 JSON 文件
    try {
        const content = await fs.readFile(JSON_PATH, { encoding: 'utf-8' });
        urlMap = JSON.parse(content);
    } catch (e) {
        if (e instanceof Error && !('code' in e && e.code === 'ENOENT')) {
            console.error("读取 JSON 文件时发生非 ENOENT 错误:", e);
        }
    }

    // -----------------------------------------------------
    // 2. 确定下载 URL 和版本号
    // -----------------------------------------------------
    if (inputUrl) {
        // A. 用户输入了 URL
        url = ensureTimestamp(inputUrl); // 确保添加时间戳
        const extractedVersion = extractVersion(url);
        if (!extractedVersion) {
            console.error("错误：无法从输入的 URL 中识别版本号！");
            return;
        }
        version = extractedVersion;
        console.log(`手动模式: 目标版本 ${version}`);

    } else {
        // B. 用户未输入 URL -> 自动检查更新
        const latestVersion = Object.keys(urlMap).shift(); // 排序后的第一个键 (最新版本)

        if (!latestVersion || !urlMap[latestVersion]) {
            console.error("错误：JSON 文件中未找到历史版本记录，无法自动推测 URL。请手动输入一个 URL。");
            return;
        }

        // 2.1 推测下一个版本号
        const nextVersion = incrementVersion(latestVersion);

        // 2.2 构造新的 URL
        // 格式: https://d2klchruasnf.cloudfront.net/Release/{version}_.../Android/AssetBundleInfo
        // 我们用旧的 URL 模板替换版本部分。

        // 查找 URL 中版本号的模式 (例如: 9.3.0.180_xxxx)
        const versionPattern = new RegExp(`/${latestVersion}(?:_.*?/AssetBundleInfo)`);

        // 假设 AssetBundleInfoUrl.json 中存储的 URL 格式是包含版本号的。
        const latestUrlTemplate = urlMap[latestVersion].replace(/\?t=\d+$/, ''); // 移除旧的时间戳

        if (!latestUrlTemplate.match(versionPattern)) {
            console.error(`错误：历史 URL 模板 [${latestUrlTemplate}] 中未找到版本号 [${latestVersion}]，无法推测新 URL。`);
            return;
        }

        url = latestUrlTemplate.replace(latestVersion, nextVersion); // 替换版本号
        url = ensureTimestamp(url); // 确保添加当前时间戳

        version = nextVersion;
        console.log(`自动模式: 最新版本 ${latestVersion} -> 推测下一版本 ${version}`);
        console.log(`推测下载 URL: ${url}`);
    }
    // -----------------------------------------------------

    const tempPath = path.join(OUT_DIR, `${BASE_NAME}_${version}.txt.tmp`);

    // ------------------------------
    // 3. 下载 AssetBundleInfo 文件 (略，与原代码相同)
    // ------------------------------
    await fs.mkdir(OUT_DIR, { recursive: true });
    // ... (下载逻辑，如果下载失败则返回)
    console.log(`正在下载版本 ${version} ...`);
    console.log(`下载 URL: ${url}`);

    // ... (下载并写入 tempPath 的 try/catch 逻辑)
    try {
        const response = await axios.get(url, {
            timeout: 20000,
            responseType: 'arraybuffer',
        });
        await fs.writeFile(tempPath, Buffer.from(response.data));
    } catch (e) {
        let errorMessage = "下载失败";
        if (axios.isAxiosError(e) && e.response) {
            errorMessage += `：HTTP 状态码 ${e.response.status}`;
        } else if (e instanceof Error) {
            errorMessage += `：${e.message}`;
        }
        console.error(errorMessage);
        return;
    }


    // ------------------------------
    // 4. 判断是否已有相同内容 (略，与原代码相同)
    // ------------------------------
    const currentMd5 = await calcFileMD5(tempPath);
    if (currentMd5 === null) {
        console.error("错误：临时文件 MD5 计算失败。");
        try { await fs.unlink(tempPath); } catch {}
        return;
    }

    let alreadyExists = false;
    try {
        const existingFiles = (await fs.readdir(OUT_DIR)).filter(f =>
            f.match(new RegExp(`^${BASE_NAME}_${version}(?:\\.\\d+)?\\.txt$`))
        );

        for (const f of existingFiles) {
            const filePath = path.join(OUT_DIR, f);
            const existingMd5 = await calcFileMD5(filePath);
            if (existingMd5 && existingMd5 === currentMd5) {
                console.log(`[MD5 校验] 相同文件已存在，跳过保存: ${filePath}`);
                alreadyExists = true;
                break;
            }
        }
    } catch (e) {
        console.warn("警告：检查现有文件时出错。继续保存。");
    }

    if (alreadyExists) {
        await fs.unlink(tempPath);
        console.log(`已删除临时文件: ${tempPath}`);
        return;
    }

    // ------------------------------
    // 5. 内容不同或没有原文件，生成唯一文件名保存 (略，与原代码相同)
    // ------------------------------
    const finalPath = await getNextVersionedPath(OUT_DIR, BASE_NAME, version);
    await fs.rename(tempPath, finalPath);
    console.log(`✅ 已保存新文件: ${finalPath}`);


    // ------------------------------
    // 6. 成功保存新文件后，更新并写入 JSON (略，与原代码相同)
    // ------------------------------

    // 插入或更新新的版本和 URL
    urlMap[version] = url;

    // a. 将对象转换为 [key, value] 数组
    const entries = Object.entries(urlMap);

    // b. 对数组进行降序排序 (版本号从大到小)
    entries.sort((a, b) => b[0].localeCompare(a[0]));

    // c. 将排序后的数组重新构建为有序的对象
    const sortedUrlMap = entries.reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
    }, {} as { [key: string]: string });

    // 写入 JSON 文件
    await fs.writeFile(
        JSON_PATH,
        JSON.stringify(sortedUrlMap, null, 2),
        { encoding: 'utf-8' }
    );
    console.log(`✅ 已更新并排序 URL 到 ${JSON_PATH}\n`);
}

main().catch(err => {
    console.error("程序发生未捕获的错误:", err);
    process.exit(1);
});