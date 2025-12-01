import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import {fileURLToPath} from "url";
const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);

const JSON_PATH = "AssetBundleInfoUrl.json";
const BASE_NAME = "AssetBundleInfo";
const OUT_DIR = BASE_NAME;

/** 从 URL 提取版本号 */
function extractVersion(url: string): string | null {
    const match = url.match(/\/Release\/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}

/** 给 URL 加时间戳避免 403 */
function ensureTimestamp(url: string): string {
    if (url.includes("t=")) return url;
    const sep = url.includes("?") ? "&" : "?";
    const stamp = new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
    return `${url}${sep}t=${stamp}`;
}

/** 版本号递增最后一段 (+10) */
function incrementVersion(version: string): string {
    const parts = version.split('.');
    const last = Number(parts.pop());
    parts.push((last + 10).toString());
    return parts.join('.');
}

/**
 * 核心下载逻辑
 * @param inputUrl 可为空，为空时自动检查更新
 */
export async function downloadAB(inputUrl?: string) {
    inputUrl = inputUrl?.trim();
    let url = "";
    let version = "";
    let urlMap: Record<string, string> = {};

    // 读取历史 JSON
    try {
        urlMap = JSON.parse(await fs.readFile(JSON_PATH, "utf-8"));
    } catch {}

    // 输入/推测版本号
    if (inputUrl) {
        url = ensureTimestamp(inputUrl);
        const extracted = extractVersion(url);
        if (!extracted) throw new Error("无法识别 URL 中的版本号！");
        version = extracted;
        console.log(`手动模式 → 版本: ${version}`);
    } else {
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
    // 如果已有同版本文件 → 跳过
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
        const sorted = Object.fromEntries(
            Object.entries(urlMap).sort((a, b) => b[0].localeCompare(a[0]))
        );

        await fs.writeFile(JSON_PATH, JSON.stringify(sorted, null, 2), "utf-8");
        console.log(`URL 记录已更新: ${JSON_PATH}`);
    }

    return { version, filePath: finalPath, url };
}

/**
 * CLI 启动入口
 */
async function main() {
    const readline = await import('readline/promises');
    const process = await import('process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const input = await rl.question("请输入 AssetBundleInfo URL（留空自动检测更新）：\n> ");
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
