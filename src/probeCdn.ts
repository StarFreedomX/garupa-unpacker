#!/usr/bin/env npx tsx
/** 一次性探测指定 dataVersion 的 CDN AssetBundleInfo 是否已经部署。 */
import axios from "axios";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAssetBundleInfo } from "./compare.js";
import {
    buildAssetBundleUrl,
    findHashForDataVersion,
    loadStore,
} from "./garupa/assetBundleInfo.js";
import { networkGet } from "./network.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE_FILE = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");

function validDataVersion(version: string): boolean {
    return /^\d+\.\d+\.\d+\.\d+$/.test(version);
}

function elapsed(started: number): string {
    return `${Date.now() - started}ms`;
}

export async function probeCdnVersion(version: string): Promise<boolean> {
    if (!validDataVersion(version)) {
        throw new Error(`无效 dataVersion：${version || "<空>"}（应为四段版本号，如 10.1.0.310）`);
    }

    const store = await loadStore(STORE_FILE);
    const hash = process.env.UNPACK_SERVER_CDN_HASH?.trim()
        || findHashForDataVersion(store, version, store.latest.clientVersion);
    if (!hash) {
        throw new Error(`找不到 ${version} 对应的 CDN hash，可在 .env 配置 UNPACK_SERVER_CDN_HASH`);
    }

    const started = Date.now();
    try {
        const response = await networkGet<ArrayBuffer>(
            `${buildAssetBundleUrl(version, hash)}?t=${Date.now()}`,
            {
                responseType: "arraybuffer",
                timeout: 20_000,
                decompress: false,
                headers: {
                    "Accept-Encoding": "identity",
                    Range: "bytes=0-0",
                },
            },
        );
        const bytes = Buffer.from(response.data);
        if (response.status === 206) {
            const match = String(response.headers["content-range"] ?? "").match(/^bytes 0-0\/(\d+)$/i);
            const total = Number(match?.[1]);
            if (bytes.length !== 1 || !Number.isSafeInteger(total) || total < 1) {
                throw new Error("CDN 返回的 Range 响应无效");
            }
            console.log(`[存在] ${version}：HTTP 206，AssetBundleInfo ${total} bytes，${elapsed(started)}`);
            return true;
        }
        const bundles = response.status === 200 ? parseAssetBundleInfo(bytes) : new Map();
        if (bundles.size === 0) {
            throw new Error(`HTTP ${response.status}，但 AssetBundleInfo 内容无法解析`);
        }
        console.log(`[存在] ${version}：HTTP ${response.status}，${bundles.size} 个 bundle，${bytes.length} bytes，${elapsed(started)}`);
        return true;
    } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 403 || status === 404) {
            console.log(`[未就绪] ${version}：HTTP ${status}，${elapsed(started)}`);
            return false;
        }
        const detail = axios.isAxiosError(error)
            ? [error.code, error.message].filter(Boolean).join(" ")
            : error instanceof Error ? error.message : String(error);
        throw new Error(`探测 ${version} 失败（${elapsed(started)}）：${detail}`);
    }
}

async function main(): Promise<void> {
    const version = process.argv[2]?.trim() ?? "";
    if (!version) {
        console.error("用法：yarn probe:cdn <dataVersion>\n示例：yarn probe:cdn 10.1.0.310");
        process.exitCode = 2;
        return;
    }
    const ready = await probeCdnVersion(version);
    if (!ready) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[探测失败] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 2;
    });
}
