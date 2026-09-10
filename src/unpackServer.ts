#!/usr/bin/env npx tsx
/**
 * Garupa 实时预解包服务。
 *
 * 同时轮询 /application 与推测版本 CDN；AssetBundleInfo 一旦出现便通知全解进程。
 * 本进程只消费逐 bundle 完成索引、筛选目标并通知。application 确认版本后，再读取
 * SuiteMaster 生成新曲消息及新卡三围技能总图，不在这里重复解包。
 */
import dotenv from "dotenv";
import axios from "axios";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { compareAssetMaps, parseAssetBundleInfo, type AssetDiff } from "./compare.js";
import { fetchApplication } from "./garupa/api/application.js";
import { fetchSuiteMaster } from "./garupa/api/suiteMaster.js";
import {
    buildAssetBundleUrl, findHashForDataVersion, loadStore, recordSnapshot, saveStore,
    type AssetBundleInfoStore,
} from "./garupa/assetBundleInfo.js";
import {
    assetPath,
} from "./memoryAssets.js";
import { networkGet } from "./network.js";
import { renderOverviewDirectory } from "./view/index.js";
import { loadUnpackServerConfig, type UnpackServerConfig } from "./unpackServer/config.js";
import { buildPreviewInfo, formatMusicNotice, suiteMusicIds } from "./unpackServer/master.js";
import { isImage, OneBotNotifier, type ResourceNotice } from "./unpackServer/onebot.js";
import {
    emptyServerState, ensureCycle, loadServerState, saveServerState,
    type ApplicationState, type CycleState, type ServerState,
} from "./unpackServer/state.js";
import {
    pickTargetFiles, resourceSetsFromDiff, selectBundleTargets, type BundleTarget,
} from "./unpackServer/targets.js";
import { predictedVersion } from "./unpackServer/version.js";
import { indexFilesToMemory, readBundleIndex } from "./unpackServer/unpackedIndex.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const STORE_FILE = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");
const MANIFEST_DIR = path.join(PROJECT_ROOT, "AssetBundleInfo");

function messageOf(error: unknown): string {
    if (axios.isAxiosError(error) && error.response?.status) return `HTTP ${error.response.status}: ${error.message}`;
    return error instanceof Error ? error.message : String(error);
}

function digest(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            signal.removeEventListener("abort", aborted);
            clearTimeout(timer);
            resolve();
        }
        function aborted() { done(); }
        signal.addEventListener("abort", aborted, { once: true });
    });
}

class UnpackMonitor {
    private state: ServerState = emptyServerState();
    private store!: AssetBundleInfoStore;
    private readonly notifier: OneBotNotifier;
    private persistTail: Promise<void> = Promise.resolve();
    private appPolling = false;
    private cdnPolling = false;
    private lastApplicationCheck?: string;
    private lastCdnCheck?: string;
    private lastGlobalError?: string;

    constructor(readonly config: UnpackServerConfig) {
        this.notifier = new OneBotNotifier(config);
    }

    private persist(): Promise<void> {
        this.persistTail = this.persistTail
            .catch(() => undefined)
            .then(() => saveServerState(this.config.stateFile, this.state));
        return this.persistTail;
    }

    async initialize(): Promise<void> {
        await fs.mkdir(this.config.outputRoot, { recursive: true });
        this.state = await loadServerState(this.config.stateFile);
        this.store = await loadStore(STORE_FILE);
        if (!this.state.application) {
            const latest = this.store.latest;
            if (latest.clientVersion && latest.dataVersion && latest.masterDataVersion) {
                this.state.application = latest as ApplicationState;
            }
        }
        await this.pollApplication();
        if (this.state.application && this.state.baselineMusicIds.length === 0
            && !Object.values(this.state.cycles).some(cycle => cycle.confirmed && !cycle.masterReady)) {
            try {
                const suite = await fetchSuiteMaster(this.state.application.clientVersion);
                this.state.baselineMusicIds = suiteMusicIds(suite);
                console.log(`[SuiteMaster] 建立新曲基线，共 ${this.state.baselineMusicIds.length} 首`);
                await this.persist();
            } catch (error) {
                console.warn(`[SuiteMaster] 暂时无法建立基线: ${messageOf(error)}`);
            }
        }
    }

    async pollApplication(): Promise<void> {
        if (this.appPolling) return;
        this.appPolling = true;
        this.lastApplicationCheck = new Date().toISOString();
        try {
            const app = await fetchApplication();
            const next: ApplicationState = {
                clientVersion: app.clientVersion,
                dataVersion: app.dataVersion,
                masterDataVersion: app.masterDataVersion,
            };
            const previous = this.state.application;
            if (previous && previous.dataVersion !== next.dataVersion) {
                ensureCycle(this.state, previous.dataVersion, next.dataVersion, true);
                console.log(`[application] 确认更新 ${previous.dataVersion} → ${next.dataVersion}`);
            } else if (!previous) {
                console.log(`[application] 当前版本 ${next.dataVersion}`);
            }
            this.state.application = next;
            this.store.latest = { ...next };
            recordSnapshot(this.store, next.clientVersion, {
                dataVersion: next.dataVersion,
                masterDataVersion: next.masterDataVersion,
            });
            await Promise.all([saveStore(this.store, STORE_FILE), this.persist()]);
            this.lastGlobalError = undefined;
        } catch (error) {
            this.lastGlobalError = `application: ${messageOf(error)}`;
            console.warn(`[application] ${messageOf(error)}`);
        } finally {
            this.appPolling = false;
        }
    }

    private hashFor(version: string): string | null {
        return this.config.cdnHash
            || findHashForDataVersion(this.store, version);
    }

    private manifestFile(version: string): string {
        return path.join(MANIFEST_DIR, `AssetBundleInfo_${version}.txt`);
    }

    private async fetchManifest(version: string, allowCached: boolean): Promise<Buffer> {
        const file = this.manifestFile(version);
        if (allowCached) {
            const cached = await fs.readFile(file).catch(() => null);
            if (cached) return cached;
        }
        const hash = this.hashFor(version);
        if (!hash) throw new Error(`没有 ${version} 对应的 CDN hash（可配置 UNPACK_SERVER_CDN_HASH）`);
        const response = await networkGet<ArrayBuffer>(`${buildAssetBundleUrl(version, hash)}?t=${Date.now()}`, {
            timeout: 20_000,
            headers: { "Accept-Encoding": "identity" },
        });
        const bytes = Buffer.from(response.data);
        if (parseAssetBundleInfo(bytes).size === 0) throw new Error("AssetBundleInfo 内容无法解析");
        await fs.mkdir(MANIFEST_DIR, { recursive: true });
        await fs.writeFile(file, bytes);
        return bytes;
    }

    private outputDirectory(version: string): string {
        return path.join(this.config.outputRoot, version);
    }

    private async writeFile(version: string, relative: string, bytes: Buffer): Promise<string> {
        const clean = assetPath(relative);
        const destination = path.join(this.outputDirectory(version), clean);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
        return destination;
    }

    private async notifyResource(cycle: CycleState, notice: ResourceNotice, bytes: Buffer): Promise<void> {
        const sha = digest(bytes);
        for (const group of this.notifier.destinations) {
            const key = `${group}|${notice.kind}|${notice.name}`;
            if (cycle.sent[key] === sha) continue;
            await this.notifier.sendResource(group, notice);
            cycle.sent[key] = sha;
            await this.persist();
        }
    }

    private async notifyImageBatch(
        cycle: CycleState,
        resources: Array<{ notice: ResourceNotice; bytes: Buffer }>,
    ): Promise<void> {
        for (const group of this.notifier.destinations) {
            const pending = resources.filter(({ notice, bytes }) => {
                const key = `${group}|${notice.kind}|${notice.name}`;
                return cycle.sent[key] !== digest(bytes);
            });
            if (pending.length === 0) continue;
            await this.notifier.sendImageBatch(group, pending.map(({ notice }) => notice));
            for (const { notice, bytes } of pending) {
                cycle.sent[`${group}|${notice.kind}|${notice.name}`] = digest(bytes);
            }
            await this.persist();
        }
    }

    /** 消费全解进程写出的 bundle 索引；这里只筛选并发送目标白名单。 */
    private async consumeBundle(
        cycle: CycleState,
        target: BundleTarget,
        resourceSets: Set<string>,
    ): Promise<void> {
        if (cycle.completedBundles.includes(target.bundle)) return;
        try {
            const index = await readBundleIndex(this.config.outputRoot, cycle.targetVersion, target.bundle);
            if (!index) return; // 解包进程还没完成这个 bundle。
            const candidates = await indexFilesToMemory(index, target.additionsOnly);
            const picked = pickTargetFiles(target, candidates, resourceSets);
            const resources: Array<{ notice: ResourceNotice; bytes: Buffer }> = [];
            for (const [relative, data] of picked) {
                const destination = await this.writeFile(cycle.targetVersion, relative, data);
                if (target.kind !== "thumbnail") {
                    resources.push({
                        notice: {
                            kind: target.kind,
                            version: cycle.targetVersion,
                            bundle: target.bundle,
                            name: relative,
                            file: destination,
                        },
                        bytes: data,
                    });
                }
            }
            const batch = this.config.mergeBundleImages
                ? resources.filter(({ notice }) => isImage(notice.file)) : [];
            if (batch.length > 1) await this.notifyImageBatch(cycle, batch);
            const batched = new Set(batch.length > 1 ? batch.map(({ notice }) => notice.name) : []);
            for (const resource of resources) {
                if (!batched.has(resource.notice.name)) {
                    await this.notifyResource(cycle, resource.notice, resource.bytes);
                }
            }
            cycle.completedBundles.push(target.bundle);
            delete cycle.lastErrors[target.bundle];
            console.log(`[目标消费] ${cycle.targetVersion} ${target.bundle}: 输出 ${picked.size}`);
            await this.persist();
        } catch (error) {
            cycle.lastErrors[target.bundle] = messageOf(error);
            console.warn(`[目标消费:待重试] ${cycle.targetVersion} ${target.bundle}: ${messageOf(error)}`);
            await this.persist();
        }
    }

    private async notifyTextOnce(cycle: CycleState, logicalKey: string, text: string): Promise<void> {
        for (const group of this.notifier.destinations) {
            const key = `${group}|${logicalKey}`;
            if (cycle.textSent.includes(key)) continue;
            await this.notifier.sendText(group, text);
            cycle.textSent.push(key);
            await this.persist();
        }
    }

    private async processMaster(cycle: CycleState, diff: AssetDiff): Promise<void> {
        if (!cycle.confirmed || cycle.masterReady
            || (!this.config.historicalReplay
                && this.state.application?.dataVersion !== cycle.targetVersion)) return;
        try {
            const suite = await fetchSuiteMaster(this.state.application.clientVersion);
            const info = buildPreviewInfo(
                suite,
                cycle.targetVersion,
                resourceSetsFromDiff(diff),
                this.state.baselineMusicIds,
            );
            const expectedCards = resourceSetsFromDiff(diff);
            const resolvedCards = new Set(info.cards.map(card => card.resourceSetName));
            const missingCards = [...expectedCards].filter(resourceSet => !resolvedCards.has(resourceSet));
            if (missingCards.length) {
                throw new Error(`SuiteMaster 尚未包含新卡: ${missingCards.join(", ")}`);
            }
            await fs.mkdir(this.outputDirectory(cycle.targetVersion), { recursive: true });
            await fs.writeFile(
                path.join(this.outputDirectory(cycle.targetVersion), "info.json"),
                JSON.stringify(info, null, 2),
                "utf-8",
            );
            for (const music of info.musics) {
                await this.notifyTextOnce(cycle, `music:${music.musicId}`, formatMusicNotice(cycle.targetVersion, music));
            }
            this.state.baselineMusicIds = suiteMusicIds(suite);
            cycle.masterReady = true;
            delete cycle.lastErrors.master;
            console.log(`[SuiteMaster] ${cycle.targetVersion}: 卡 ${info.cards.length} / 新曲 ${info.musics.length}`);
            await this.persist();
        } catch (error) {
            cycle.lastErrors.master = messageOf(error);
            console.warn(`[SuiteMaster:待重试] ${cycle.targetVersion}: ${messageOf(error)}`);
            await this.persist();
        }
    }

    private async processOverview(cycle: CycleState): Promise<void> {
        if (!cycle.masterReady || cycle.textSent.includes("overview:none")) return;
        const dir = this.outputDirectory(cycle.targetVersion);
        try {
            const info = JSON.parse(await fs.readFile(path.join(dir, "info.json"), "utf-8")) as { cards?: any[] };
            if (!info.cards?.length) {
                cycle.textSent.push("overview:none");
                await this.persist();
                return;
            }
            for (const card of info.cards) {
                const normal = path.join(dir, "thumbnail", `${card.resourceSetName}_normal.png`);
                const trained = path.join(dir, "thumbnail", `${card.resourceSetName}_after_training.png`);
                if (!await fs.stat(normal).then(() => true, () => false)
                    && !await fs.stat(trained).then(() => true, () => false)) return;
            }
            const overview = await renderOverviewDirectory(dir);
            if (!overview) return;
            const bytes = await fs.readFile(overview);
            await this.notifyResource(cycle, {
                kind: "card-overview",
                version: cycle.targetVersion,
                name: "view/overview.png",
                file: overview,
            }, bytes);
            cycle.textSent.push("overview:none");
            await this.persist();
        } catch (error) {
            cycle.lastErrors.overview = messageOf(error);
            console.warn(`[view:待重试] ${cycle.targetVersion}: ${messageOf(error)}`);
            await this.persist();
        }
    }

    private async processCycle(cycle: CycleState): Promise<void> {
        // 猜错后不再继续错误候选；已经由 application 确认的周期不受影响。
        const observed = this.state.application?.dataVersion;
        if (!cycle.confirmed && (!observed || predictedVersion(observed, Object.keys(this.store.hashes)) !== cycle.targetVersion)) return;
        try {
            const targetManifest = await this.fetchManifest(cycle.targetVersion, cycle.manifestReady);
            const baseManifest = await this.fetchManifest(cycle.baseVersion, true);
            if (!cycle.manifestReady) {
                cycle.manifestReady = true;
                console.log(`[CDN] 发现 ${cycle.targetVersion} AssetBundleInfo`);
                await this.persist();
            }
            const diff = compareAssetMaps(parseAssetBundleInfo(targetManifest), parseAssetBundleInfo(baseManifest));
            const targets = selectBundleTargets(diff);
            const resourceSets = resourceSetsFromDiff(diff);
            await Promise.all(targets.map(target => this.consumeBundle(cycle, target, resourceSets)));
            await this.processMaster(cycle, diff);
            await this.processOverview(cycle);
            delete cycle.lastErrors.manifest;
        } catch (error) {
            cycle.lastErrors.manifest = messageOf(error);
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            if (cycle.manifestReady || (status !== 403 && status !== 404)) {
                console.warn(`[CDN:待重试] ${cycle.targetVersion}: ${messageOf(error)}`);
            }
            await this.persist();
        }
    }

    async pollCdn(): Promise<void> {
        if (this.cdnPolling) return;
        this.cdnPolling = true;
        this.lastCdnCheck = new Date().toISOString();
        try {
            const app = this.state.application;
            if (!app) return;
            const predicted = predictedVersion(app.dataVersion, Object.keys(this.store.hashes));
            ensureCycle(this.state, app.dataVersion, predicted, false);
            const cycles = Object.values(this.state.cycles).filter(cycle =>
                cycle.confirmed || (cycle.baseVersion === app.dataVersion && cycle.targetVersion === predicted),
            );
            for (const cycle of cycles) await this.processCycle(cycle);
        } finally {
            this.cdnPolling = false;
        }
    }

    health(): Record<string, unknown> {
        return {
            ok: !this.lastGlobalError,
            application: this.state.application,
            predictedVersion: this.state.application ? predictedVersion(this.state.application.dataVersion, Object.keys(this.store.hashes)) : null,
            lastApplicationCheck: this.lastApplicationCheck,
            lastCdnCheck: this.lastCdnCheck,
            error: this.lastGlobalError,
            cycles: Object.values(this.state.cycles).map(cycle => ({
                baseVersion: cycle.baseVersion,
                targetVersion: cycle.targetVersion,
                confirmed: cycle.confirmed,
                manifestReady: cycle.manifestReady,
                masterReady: cycle.masterReady,
                completedBundles: cycle.completedBundles.length,
                sent: Object.keys(cycle.sent).length,
                errors: cycle.lastErrors,
            })),
        };
    }
}

function startHealthServer(monitor: UnpackMonitor): Server {
    const server = createServer((request, response) => {
        if (request.method !== "GET" || !["/", "/health"].includes(request.url ?? "")) {
            response.writeHead(404).end("not found");
            return;
        }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(monitor.health(), null, 2));
    });
    server.listen(monitor.config.port, monitor.config.host, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : monitor.config.port;
        console.log(`[server] health: http://${monitor.config.host}:${port}/health`);
    });
    return server;
}

async function repeat(action: () => Promise<void>, interval: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
        const started = Date.now();
        await action().catch(error => console.error(`[loop] ${messageOf(error)}`));
        await delay(Math.max(0, interval - (Date.now() - started)), signal);
    }
}

export async function main(): Promise<void> {
    const config = loadUnpackServerConfig(PROJECT_ROOT);
    const monitor = new UnpackMonitor(config);
    await monitor.initialize();
    const healthServer = startHealthServer(monitor);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`[server] 实时预解包已启动${config.dryRun ? "（dry-run）" : ""}`);
    await Promise.all([
        repeat(() => monitor.pollApplication(), config.applicationPollMs, controller.signal),
        repeat(() => monitor.pollCdn(), config.cdnPollMs, controller.signal),
    ]);
    await new Promise<void>((resolve, reject) => healthServer.close(error => error ? reject(error) : resolve()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`[server] ${messageOf(error)}`);
        process.exitCode = 1;
    });
}
