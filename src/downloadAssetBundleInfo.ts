import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import { fileURLToPath } from "url";

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const JSON_PATH = "AssetBundleInfoUrl.json";
const BASE_NAME = "AssetBundleInfo";
const OUT_DIR = BASE_NAME;

/** 从 URL 提取版本号 */
function extractVersion(url: string): string | null {
    const match = url.match(/\/Release\/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}

/** 输入是否为纯版本号 9.3.0.210 */
function isVersionFormat(input: string): boolean {
    return /^\d+\.\d+\.\d+\.\d+$/.test(input);
}

/** 取版本前三段：9.3.0 */
function mainVersion(version: string) {
    return version.split(".").slice(0, 3).join(".");
}

/** 给 URL 加时间戳避免 403 */
function ensureTimestamp(url: string): string {
    if (url.includes("t=")) return url;
    const sep = url.includes("?") ? "&" : "?";
    const stamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    return `${url}${sep}t=${stamp}`;
}

/** 自动推测下一个版本号 */
function incrementVersion(version: string): string {
    const parts = version.split('.');
    const lastNum = parts.pop();
    if (!lastNum) throw new Error("Invalid version number");
    let last = Number(lastNum);
    // 90 → +20，否则 +10
    last += last % 100 === 90 ? 20 : 10;
    parts.push(last.toString());
    return parts.join('.');
}



/** 根据输入版本号 在 JSON 中找到同主版本 的模板 URL */
function findTemplateUrl(version: string, urlMap: Record<string,string>): string | null {
    const targetMain = mainVersion(version);

    for (const v in urlMap) {
        if (mainVersion(v) === targetMain) {
            return urlMap[v];
        }
    }
    return null;
}

/**
 * 核心下载逻辑
 * @param inputAssetBundlePath URL 或版本号，例如 "9.3.0.200"
 */
export async function downloadAB(inputAssetBundlePath?: string) {
    inputAssetBundlePath = inputAssetBundlePath?.trim();
    let url = "";
    let version = "";
    let urlMap: Record<string, string> = {};

    // 读取历史 JSON
    try {
        urlMap = JSON.parse(await fs.readFile(JSON_PATH, "utf-8"));
    } catch {}

    // 输入了内容
    if (inputAssetBundlePath) {
        // 输入的是版本号（非 URL）
        if (isVersionFormat(inputAssetBundlePath)) {
            version = inputAssetBundlePath;
            const template = findTemplateUrl(version, urlMap);

            if (!template)
                throw new Error(`无法在 JSON 中找到与 ${version} 主版本 (${mainVersion(version)}) 匹配的模板 URL！`);

            // 去掉旧时间戳
            const clean = template.replace(/\?t=\d+$/, "");
            // 替换版本号
            url = ensureTimestamp(clean.replace(/Release\/\d+\.\d+\.\d+\.\d+/, `Release/${version}`));

            console.log(`使用版本号模式 → 主版本模板匹配成功`);
            console.log(`构造 URL: ${url}`);
        }
        // 输入的是真 URL
        else {
            url = ensureTimestamp(inputAssetBundlePath);
            const extracted = extractVersion(url);
            if (!extracted) throw new Error("无法识别 URL 中的版本号！");
            version = extracted;

            console.log(`手动 URL 模式 → 版本: ${version}`);
        }
    }

    // 未输入 → 自动推测下一版本号
    else {
        const latest = Object.keys(urlMap)[0];
        if (!latest) throw new Error("JSON 中无历史记录，无法自动生成 URL");

        version = incrementVersion(latest);
        const template = urlMap[latest].replace(/\?t=\d+$/, "");
        url = ensureTimestamp(template.replace(latest, version));

        console.log(`自动推测下一版本 → ${latest} → ${version}`);
        console.log(`推测 URL: ${url}`);
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
            throw new Error(`下载失败: ${(err as any).message}`);
        }
    }

    // 更新 JSON
    if (downloaded) {
        urlMap[version] = url;

        // 按版本名逆序排序
        const sorted = Object.fromEntries(
            Object.entries(urlMap).sort((a, b) => b[0].localeCompare(a[0]))
        );

        await fs.writeFile(JSON_PATH, JSON.stringify(sorted, null, 2), "utf-8");
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
