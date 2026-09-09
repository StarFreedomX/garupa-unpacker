import * as path from "node:path";

export interface UnpackServerConfig {
    projectRoot: string;
    outputRoot: string;
    stateFile: string;
    applicationPollMs: number;
    cdnPollMs: number;
    host: string;
    port: number;
    dryRun: boolean;
    historicalReplay: boolean;
    mergeBundleImages: boolean;
    oneBotBaseUrl: string;
    oneBotAccessToken?: string;
    oneBotGroupIds: string[];
    oneBotFileBaseUrl?: string;
    cdnHash?: string;
}

function booleanSetting(name: string, fallback = false): boolean {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    throw new Error(`${name} 必须是 true/false`);
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
    }
    return value;
}

function urlSetting(name: string): string | undefined {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`${name} 只支持 http/https URL`);
    return raw.replace(/\/+$/, "");
}

export function loadUnpackServerConfig(projectRoot: string, requireOneBot = true): UnpackServerConfig {
    const dryRun = booleanSetting("UNPACK_SERVER_DRY_RUN");
    const oneBotBaseUrl = urlSetting("ONEBOT_API_BASE_URL") ?? "";
    const oneBotGroupIds = (process.env.ONEBOT_GROUP_IDS ?? "")
        .split(",").map(value => value.trim()).filter(Boolean);
    if (requireOneBot && !dryRun && (!oneBotBaseUrl || oneBotGroupIds.length === 0)) {
        throw new Error("请配置 ONEBOT_API_BASE_URL 与 ONEBOT_GROUP_IDS，或设置 UNPACK_SERVER_DRY_RUN=true");
    }
    const outputRoot = path.resolve(projectRoot, process.env.UNPACK_SERVER_OUTPUT_DIR || "assets/server");
    const stateFile = path.resolve(projectRoot, process.env.UNPACK_SERVER_STATE_FILE || "out/unpack-server-state.json");
    return {
        projectRoot,
        outputRoot,
        stateFile,
        applicationPollMs: boundedInteger("UNPACK_SERVER_APPLICATION_POLL_MS", 15_000, 1_000, 3_600_000),
        cdnPollMs: boundedInteger("UNPACK_SERVER_CDN_POLL_MS", 10_000, 1_000, 3_600_000),
        host: process.env.UNPACK_SERVER_HOST?.trim() || "127.0.0.1",
        port: boundedInteger("UNPACK_SERVER_PORT", 3210, 0, 65_535),
        dryRun,
        historicalReplay: booleanSetting("UNPACK_SERVER_HISTORICAL_REPLAY"),
        mergeBundleImages: booleanSetting("ONEBOT_MERGE_BUNDLE_IMAGES"),
        oneBotBaseUrl,
        oneBotAccessToken: process.env.ONEBOT_ACCESS_TOKEN?.trim() || undefined,
        oneBotGroupIds,
        oneBotFileBaseUrl: urlSetting("ONEBOT_FILE_BASE_URL"),
        cdnHash: process.env.UNPACK_SERVER_CDN_HASH?.trim() || undefined,
    };
}
