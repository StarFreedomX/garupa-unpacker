/**
 * 快捷解包：只解最新版本，产出当期活动卡池（含梦限）、新卡面、新表情（图+语音）、当期活动介绍、新卡面技能。
 * 目录完全隔离：quick-tmp/<ver>/download|unpack 为中间产物，assets/<ver>-preview/ 为最终汇总。
 * 绝不写 analysing/，不改动全量流程任何文件。
 * 用法: npx tsx ./src/quickUnpack.ts
 */
import dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "path";
import axios from "axios";
import pLimit from "p-limit";
import { glob } from "glob";
import { fileURLToPath } from "url";
import readline from "node:readline/promises";
import { downloadAB } from "@/downloadAssetBundleInfo.js";
import { compareVersions } from "@/compare.js";
import { fetchSuiteMaster } from "@/garupa/api/suiteMaster.js";
import { mainVersion, buildAssetBundleUrl, loadStore } from "@/garupa/assetBundleInfo.js";
import { decodeSingleAcb } from "@/decodeAcb.js";
import { AssetExporter } from "node-asset-studio-mod";

dotenv.config();

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const STORE_JSON = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");
const QUICK_TMP_DIR = path.join(PROJECT_ROOT, "quick-tmp");
const PREVIEW_BASE = path.join(PROJECT_ROOT, "assets");

const MAX_CONCURRENT_DOWNLOADS = 10;
const MAX_UNPACK_CONCURRENCY = parseInt(process.env.QUICK_UNPACK_CONCURRENCY ?? "4", 10) || 4;
const PER_FILE_RETRIES = 3;
const TIMEOUT_MS = 30000;
const DOWNLOAD_HEADERS = { "User-Agent": "garupa-getAssets/1.0.0" };

const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];

/** 下载单个 bundle（每次覆盖下载，不做"已存在跳过"；403/404 不重试，其他错误指数退避） */
async function downloadBundle(baseUrl: string, saveRoot: string, assetPath: string): Promise<boolean> {
    const cleanPath = assetPath.startsWith("/") ? assetPath.substring(1) : assetPath;
    const url = `${baseUrl}${cleanPath}`;
    const savePath = path.join(saveRoot, cleanPath);

    for (let attempt = 1; attempt <= PER_FILE_RETRIES; attempt++) {
        try {
            await fs.mkdir(path.dirname(savePath), { recursive: true });
            const response = await axios.get(url, {
                responseType: "stream",
                timeout: TIMEOUT_MS,
                headers: DOWNLOAD_HEADERS,
            });
            const writer = fsSync.createWriteStream(savePath);
            await new Promise<void>((resolve, reject) => {
                response.data.pipe(writer);
                writer.on("finish", resolve);
                writer.on("error", reject);
            });
            console.log(`[下载完成] ${cleanPath}`);
            return true;
        } catch (e: any) {
            const status = e.response?.status;
            if (status === 403 || status === 404) {
                console.log(`[失败] ${cleanPath} -> HTTP ${status} (不重试)`);
                return false;
            }
            if (attempt < PER_FILE_RETRIES) {
                const backoff = Math.pow(2, attempt - 1) * 1000; // 1s, 2s
                console.log(`[异常] ${cleanPath} -> ${status || "未知"} (第 ${attempt}/${PER_FILE_RETRIES} 次，${backoff / 1000}s 后重试)`);
                await new Promise((r) => setTimeout(r, backoff));
            } else {
                console.log(`[最终失败] ${cleanPath}`);
            }
        }
    }
    return false;
}

/** 递归收集目录下所有文件 */
async function collectFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...await collectFiles(full));
        else if (entry.isFile()) results.push(full);
    }
    return results;
}

/** 递归 glob 指定根目录下的文件（按扩展名过滤） */
async function globFiles(root: string, exts: string[]): Promise<string[]> {
    if (!fsSync.existsSync(root)) return [];
    const pattern = path.join(root, "**", "*").replace(/\\/g, "/");
    const files = await glob(pattern);
    return files.filter((f) => exts.includes(path.extname(f).toLowerCase()));
}

/** 拷贝挑选结果到汇总目录（自动建目录，同名覆盖） */
async function copyPicked(src: string, destDir: string, destName: string): Promise<void> {
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(src, path.join(destDir, destName));
}

async function main() {
    console.log("快捷解包：只解最新版本，输出 assets/<ver>-preview/（不触碰 analysing/ 与全量流程）");
    console.log("─".repeat(60));

    // 1. 自动检测最新版本并下载 AssetBundleInfo
    console.log("[1/9] 获取最新版本 AssetBundleInfo ...");
    const result = await downloadAB(undefined);
    const version = result.version;
    console.log(`最新版本: ${version}`);
    console.log("─".repeat(60));

    // 2. 对比生成 diff
    console.log("[2/9] 对比版本差异 ...");
    let diff: { new: string[]; change: string[] };
    try {
        const { outFile, versions } = await compareVersions(version);
        console.log(`对比完成: ${versions.verOld} → ${versions.verNew}`);
        console.log(`差异文件: ${outFile}`);
        diff = JSON.parse(await fs.readFile(outFile, "utf-8"));
    } catch {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const inputQ2 = await rl.question("前一个版本文件缺失，请输入被比较的前一版本 dataVersion：\n> ");
        rl.close();
        await downloadAB(inputQ2.trim() || undefined);
        const { outFile, versions } = await compareVersions(version);
        console.log(`对比完成: ${versions.verOld} → ${versions.verNew}`);
        diff = JSON.parse(await fs.readFile(outFile, "utf-8"));
    }
    const diffSet = new Set<string>([...diff.new, ...diff.change]);
    console.log(`diff: new ${diff.new.length} 条, change ${diff.change.length} 条`);
    console.log("─".repeat(60));

    // 3. 拉取 SuiteMaster
    console.log("[3/9] 拉取 SuiteMaster ...");
    const suiteMaster = await fetchSuiteMaster();
    const situations: Record<string, any> = suiteMaster.masterCharacterSituationMap?.entries ?? {};
    const charInfos: Record<string, any> = suiteMaster.masterCharacterInfoMap?.entries ?? {};
    const stamps: Record<string, any> = suiteMaster.masterStampMap?.entries ?? {};
    const gachas: Record<string, any> = suiteMaster.masterGachaMap?.entries ?? {};
    const skillDefs: Record<string, any> = suiteMaster.masterSituationSkillMap?.entries ?? {};
    const skillList: any[] = suiteMaster.masterSkillList?.entries ?? [];
    const skillOnceEffects: any[] = Object.values(suiteMaster.masterSkillOnceEffectList?.entries ?? {});
    const skillActEffects: any[] = Object.values(suiteMaster.masterSkillActivateEffectList?.entries ?? {});
    const events: Record<string, any> = suiteMaster.masterEventMap?.entries ?? {};
    const monthlyRankings: any[] = suiteMaster.masterMonthlyRankingList?.entries ?? [];
    const musicList: any[] = suiteMaster.masterMusicList?.entries ?? [];
    const musicDifficulty: any[] = suiteMaster.masterMusicDifficultyList?.entries ?? [];
    const bands: Record<string, any> = suiteMaster.masterBandMap?.entries ?? {};
    console.log(`SuiteMaster 就绪 (situations=${Object.keys(situations).length}, gachas=${Object.keys(gachas).length})`);
    console.log("─".repeat(60));

    // 4. 数据驱动判定
    console.log("[4/9] 数据驱动判定 ...");

    // 4.1 本期新卡面 situationId 集合（diff.new 的 characters/resourceset/<res>）
    const newResSet = new Set<string>();
    for (const p of diff.new) {
        if (p.startsWith("characters/resourceset/")) {
            const res = p.split("/").pop();
            if (res) newResSet.add(res);
        }
    }
    const newSituationIds = new Set<number>();
    for (const sit of Object.values(situations)) {
        if (newResSet.has(sit.resourceSetName)) newSituationIds.add(sit.situationId);
    }

    // 4.2 活动卡池候选
    const activityCandidates: any[] = [];
    for (const gacha of Object.values(gachas)) {
        if (gacha.gachaType !== "normal") continue;
        const viewLive2ds = gacha.viewLive2ds;
        if (!viewLive2ds || !viewLive2ds.length) continue;
        const gachaSitIds = new Set<number>(viewLive2ds.map((v: any) => v.situationId));
        if (![...gachaSitIds].some((id) => newSituationIds.has(id))) continue;
        // 排除属性定向池：rarityIndex===5 的 detail 对应 situation 的 attribute 种类数需 > 1
        const attrs = new Set<string>();
        for (const detail of gacha.details ?? []) {
            if (detail.rarityIndex !== 5) continue;
            const sit = situations[String(detail.situationId)];
            if (sit?.attribute) attrs.add(sit.attribute);
        }
        if (attrs.size <= 1) continue;
        activityCandidates.push(gacha);
    }

    // 4.3 梦限判定：存在 B 使 B.viewLive2ds.situationId 是 A 的严格真子集 → A 为梦限
    const dreamFestival = activityCandidates.filter((A) => {
        const setA = new Set<number>(A.viewLive2ds.map((v: any) => v.situationId));
        return activityCandidates.some((B) => {
            if (B === A) return false;
            const setB = new Set<number>(B.viewLive2ds.map((v: any) => v.situationId));
            if (setB.size >= setA.size) return false; // 严格真子集：必须更小
            return [...setB].every((id) => setA.has(id));
        });
    });

    // 4.4 选池
    const chosenPool = dreamFestival.length > 0 ? dreamFestival : activityCandidates;
    const hasDreamFestival = dreamFestival.length > 0;

    // 4.6 当期活动（通常唯一；优先取 diff 里存在的，兜底取第一个）
    let eventAssetBundle: string | null = null;
    let eventStartAt: string | null = null;
    for (const ev of Object.values(events)) {
        if (ev.assetBundleName && diffSet.has(`event/${ev.assetBundleName}/images`)) {
            eventAssetBundle = ev.assetBundleName;
            eventStartAt = ev.startAt ?? null;
            break;
        }
    }
    if (!eventAssetBundle) {
        const firstEv = Object.values(events).find((e: any) => e.assetBundleName);
        eventAssetBundle = firstEv?.assetBundleName ?? null;
        eventStartAt = firstEv?.startAt ?? null;
    }

    // 4.5 表情白名单：stamp/01 是聚合 bundle，解出全部历史表情。
    //   与全量流程 change/change_old 哈希去重一致的做法：
    //   只保留「当期活动开始时间之后发布」的表情（含活动批 + 例行批），丢弃历史表情。
    const stampWhitelist = new Set<string>();
    if (eventStartAt) {
        for (const stamp of Object.values(stamps)) {
            if (Number(stamp.publishedAt) >= Number(eventStartAt)) stampWhitelist.add(stamp.imageName);
        }
    }

    console.log(`本期新卡面 res: ${[...newResSet].join(", ")}`);
    console.log(`本期新卡面 situationId: ${[...newSituationIds].sort((a, b) => a - b).join(", ")}`);
    console.log(`活动卡池候选: ${activityCandidates.map((g) => `${g.gachaId}(${g.gachaName})`).join(", ")}`);
    console.log(`梦限: ${dreamFestival.map((g) => `${g.gachaId}(${g.gachaName})`).join(", ")}`);
    console.log(`选池: ${chosenPool.map((g) => `${g.gachaId}(${g.gachaName})`).join(", ")}`);
    console.log(`当期活动: ${eventAssetBundle ?? "无"}`);
    console.log("─".repeat(60));

    try {
        // 5. 下载清单（候选路径 ∩ diff）
        console.log("[5/9] 计算下载清单（候选 ∩ diff）...");
        const downloadSet = new Set<string>();
        const noteSkip = (p: string) => console.log(`[跳过] 路径不在diff: ${p}`);

        for (const gacha of chosenPool) {
            if (!gacha.resourceName) continue;
            const p = `gacha/screen/${gacha.resourceName}`;
            if (diffSet.has(p)) downloadSet.add(p);
            else noteSkip(p);
        }
        if (hasDreamFestival) {
            for (const p of [...diff.new, ...diff.change]) {
                if (p.startsWith("genericanimation/dream_festival_")) downloadSet.add(p);
            }
        }
        for (const p of diff.new) {
            if (p.startsWith("characters/resourceset/")) downloadSet.add(p);
        }
        // 卡面缩略图（绘图用）：diff 中本期变化的 thumb/chara/card* bundle
        for (const p of [...diff.new, ...diff.change]) {
            if (p.startsWith("thumb/chara/card")) downloadSet.add(p);
        }
        if (eventAssetBundle) {
            for (const suffix of ["images", "slide"]) {
                const p = `event/${eventAssetBundle}/${suffix}`;
                if (diffSet.has(p)) downloadSet.add(p);
                else noteSkip(p);
            }
        }
        // 月榜（monthlyranking）：masterMonthlyRankingList.assetBundleName → event/<name>/topscreen ∩ diff
        for (const m of monthlyRankings) {
            if (!m.assetBundleName) continue;
            const p = `event/${m.assetBundleName}/topscreen`;
            if (diffSet.has(p)) downloadSet.add(p);
        }
        if (diffSet.has("stamp/01")) downloadSet.add("stamp/01");
        else noteSkip("stamp/01");
        if (diffSet.has("sound/voice_stamp")) downloadSet.add("sound/voice_stamp");
        else noteSkip("sound/voice_stamp");

        console.log(`下载清单 ${downloadSet.size} 个 bundle`);

        // 6. 下载
        console.log("[6/9] 下载 bundle ...");
        const store = await loadStore(STORE_JSON);
        const hash = store.hashes[mainVersion(version)];
        if (!hash)
            throw new Error(`hashes 缺少主版本 ${mainVersion(version)} 的 hash，请先运行 downloadAssetBundleInfo 粘贴一次该主版本 URL`);
        const baseUrl = buildAssetBundleUrl(version, hash).split("/AssetBundleInfo")[0] + "/";
        console.log(`CDN 前缀: ${baseUrl}`);

        const downloadRoot = path.join(QUICK_TMP_DIR, version, "download");
        const limit = pLimit(MAX_CONCURRENT_DOWNLOADS);
        const failed: string[] = [];
        const tasks = [...downloadSet].map((p) =>
            limit(async () => {
                try {
                    const ok = await downloadBundle(baseUrl, downloadRoot, p);
                    if (!ok) failed.push(p);
                } catch (e: any) {
                    failed.push(p);
                    console.error(`[异常] ${p}: ${e?.message ?? e}`);
                }
            })
        );
        await Promise.all(tasks);
        console.log(`下载完成，失败 ${failed.length} 个`);
        if (failed.length > 0) {
            console.warn(`下载失败 ${failed.length} 个，解包可能不完整:`);
            for (const p of failed) console.warn(`  - ${p}`);
        }

        // 7. 解包（每个 bundle 单独解到 unpack/<相对路径>，便于按文件名挑选；并发执行）
        console.log("[7/9] 解包 bundle ...");
        const exporter = new AssetExporter({
            unityVersion: process.env.UNITY_VERSION!,
            assetType: ["all"],
            overwrite: true,
            group: "container",
            audioFormat: "wav",
        });
        const unpackRoot = path.join(QUICK_TMP_DIR, version, "unpack");
        await fs.mkdir(unpackRoot, { recursive: true });
        if (fsSync.existsSync(downloadRoot)) {
            const files = await collectFiles(downloadRoot);
            const unpackLimit = pLimit(MAX_UNPACK_CONCURRENCY);
            const unpackTasks = files.map((file) =>
                unpackLimit(async () => {
                    const rel = path.relative(downloadRoot, file);
                    const outDir = path.join(unpackRoot, rel);
                    console.log(`解包: ${rel}`);
                    try {
                        await exporter.exportAssets(file, outDir);
                    } catch (e) {
                        console.warn(`解包失败 ${rel}: ${e instanceof Error ? e.message : e}`);
                    }
                })
            );
            await Promise.all(unpackTasks);
        }

        // 7.5 解码 ACB（voice_stamp 等音频 bundle 解出的是 .acb 容器，需解码 HCA → wav）
        if (fsSync.existsSync(unpackRoot)) {
            const acbFiles = (await collectFiles(unpackRoot)).filter((f) => f.toLowerCase().endsWith(".acb"));
            if (acbFiles.length > 0) {
                console.log(`解码 ACB → WAV: ${acbFiles.length} 个`);
                const acbLimit = pLimit(MAX_UNPACK_CONCURRENCY);
                await Promise.all(
                    acbFiles.map((acb) =>
                        acbLimit(async () => {
                            console.log(`解码: ${path.relative(unpackRoot, acb)}`);
                            try {
                                await decodeSingleAcb(acb);
                            } catch (e) {
                                console.warn(`解码失败: ${e instanceof Error ? e.message : e}`);
                            }
                        })
                    )
                );
            }
        }

        // 8. 汇总挑选
        console.log("[8/9] 汇总挑选到 assets/<ver>-preview/ ...");
        const previewRoot = path.join(PREVIEW_BASE, `${version}-preview`);

        // gacha/：梦限 → 梦限动画 name_text.png；普通活动 → pickup*_name.png
        const gachaOut = path.join(previewRoot, "gacha");
        if (hasDreamFestival) {
            const genAnimRoot = path.join(unpackRoot, "genericanimation");
            if (fsSync.existsSync(genAnimRoot)) {
                const dfDirs = (await fs.readdir(genAnimRoot)).filter((d) => d.startsWith("dream_festival_"));
                for (const dfDir of dfDirs) {
                    const files = await globFiles(path.join(genAnimRoot, dfDir), IMAGE_EXTS);
                    for (const f of files) {
                        const base = path.basename(f);
                        if (/^name_text\./i.test(base)) await copyPicked(f, gachaOut, base);
                    }
                }
            }
        } else {
            const gachaScreenRoot = path.join(unpackRoot, "gacha", "screen");
            if (fsSync.existsSync(gachaScreenRoot)) {
                const files = await globFiles(gachaScreenRoot, IMAGE_EXTS);
                for (const f of files) {
                    const base = path.basename(f);
                    if (/^pickup\d*_name\./i.test(base)) await copyPicked(f, gachaOut, base);
                }
            }
        }

        // cards/：新卡面 res 的 card_normal.png / card_after_training.png（按 res 前缀避免重名）
        const cardsOut = path.join(previewRoot, "cards");
        for (const res of newResSet) {
            const resDir = path.join(unpackRoot, "characters", "resourceset", res);
            if (!fsSync.existsSync(resDir)) continue;
            const files = await globFiles(resDir, IMAGE_EXTS);
            for (const target of ["card_normal.png", "card_after_training.png"]) {
                const hit = files.find((f) => path.basename(f).toLowerCase() === target);
                if (hit) await copyPicked(hit, cardsOut, `${res}_${target}`);
            }
        }

        // thumbnail/：卡面缩略图（绘图用），解包产物 thumbnail/character.card* 下的图片，
        //   只保留本期新卡面（resourceSetName 前缀匹配 newResSet）
        const thumbOut = path.join(previewRoot, "thumbnail");
        const thumbRoot = path.join(unpackRoot, "thumb", "chara");
        if (fsSync.existsSync(thumbRoot)) {
            const dirs = (await fs.readdir(thumbRoot)).filter((d) => d.startsWith("card"));
            for (const d of dirs) {
                const files = await globFiles(path.join(thumbRoot, d), IMAGE_EXTS);
                for (const f of files) {
                    const base = path.basename(f);
                    const m = base.match(/^(res\d{6})_/);
                    if (m && newResSet.has(m[1])) await copyPicked(f, thumbOut, base);
                }
            }
        }

        // stamp/：只保留白名单内（当期活动开始后发布）的表情图与语音，丢弃历史表情
        const stampOut = path.join(previewRoot, "stamp");
        const stamp01Dir = path.join(unpackRoot, "stamp", "01");
        if (fsSync.existsSync(stamp01Dir)) {
            const imgs = await globFiles(stamp01Dir, IMAGE_EXTS);
            for (const f of imgs) {
                const name = path.basename(f, path.extname(f));
                if (stampWhitelist.has(name)) await copyPicked(f, stampOut, path.basename(f));
            }
        }
        const voiceDir = path.join(unpackRoot, "sound", "voice_stamp");
        if (fsSync.existsSync(voiceDir)) {
            const wavs = await globFiles(voiceDir, [".wav"]);
            for (const f of wavs) {
                const name = path.basename(f, ".wav");
                if (stampWhitelist.has(name)) await copyPicked(f, stampOut, path.basename(f));
            }
        }

        // event/：活动 bundle 解包产物中的图片（按子目录前缀避免重名）
        const eventOut = path.join(previewRoot, "event");
        if (eventAssetBundle) {
            const eventDir = path.join(unpackRoot, "event", eventAssetBundle);
            if (fsSync.existsSync(eventDir)) {
                const imgs = await globFiles(eventDir, IMAGE_EXTS);
                for (const f of imgs) {
                    const relPath = path.relative(eventDir, f).replace(/\\/g, "/");
                    const sub = relPath.split("/")[0];
                    await copyPicked(f, eventOut, `${sub}_${path.basename(f)}`);
                }
            }
        }

        // monthlyranking/：月榜 bundle 解包产物，只取 topscreen 的 bg_eventtop.png
        const monthlyOut = path.join(previewRoot, "monthlyranking");
        for (const m of monthlyRankings) {
            if (!m.assetBundleName) continue;
            const dir = path.join(unpackRoot, "event", m.assetBundleName, "topscreen");
            if (!fsSync.existsSync(dir)) continue;
            const files = await globFiles(dir, IMAGE_EXTS);
            for (const f of files) {
                if (path.basename(f).toLowerCase() === "bg_eventtop.png") {
                    await copyPicked(f, monthlyOut, "bg_eventtop.png");
                }
            }
        }

        // skills.json：本期新卡面每个 situationId 的技能信息
        const cards: any[] = [];

        /** 填充技能描述占位符：效果列表顺序 = [once效果..., act效果按seq...]，{n} 按编号对应效果，
         *  每个占位符填该效果各 skillLevel 的 colorDescription（/ 连接） */
        const fillSkillDescription = (template: string | undefined, skillId: number | null): string => {
            if (!template || skillId == null) return template ?? "";
            const onceEffects = skillOnceEffects.filter((s: any) => s.skillId === skillId);
            const actEffects = skillActEffects
                .filter((s: any) => s.skillId === skillId)
                .sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0) || a.skillLevel - b.skillLevel);
            const effects: Array<Map<number, string>> = [];
            // once 效果（无 seq，按 skillLevel 分组）
            const onceByLevel = new Map<number, string>();
            for (const e of onceEffects) onceByLevel.set(e.skillLevel, e.colorDescription);
            if (onceByLevel.size > 0) effects.push(onceByLevel);
            // act 效果按 seq 分组
            for (const seq of [...new Set(actEffects.map((e: any) => e.seq))]) {
                const byLevel = new Map<number, string>();
                for (const e of actEffects.filter((x: any) => x.seq === seq)) byLevel.set(e.skillLevel, e.colorDescription);
                if (byLevel.size > 0) effects.push(byLevel);
            }
            return template.replace(/\{(\d+)\}/g, (_m, idx: string) => {
                const eff = effects[Number(idx)];
                if (!eff) return _m;
                return [...eff.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("/");
            });
        };

        for (const situationId of [...newSituationIds].sort((a, b) => a - b)) {
            const sit = situations[String(situationId)];
            if (!sit) continue;
            const charInfo = charInfos[String(sit.characterId)];
            const skillDef = skillDefs[String(sit.situationSkillId)];
            const skillListRecord = skillList.find(
                (s: any) => s.skillId === skillDef?.skillId && s.skillLevel === 1
            );
            const skill = skillListRecord
                ? {
                    skillName: skillDef?.skillName ?? "",
                    skillId: skillDef?.skillId ?? null,
                    description: fillSkillDescription(skillListRecord.description, skillDef?.skillId),
                    simpleDescription: skillListRecord.simpleDescription,
                    duration: skillListRecord.duration,
                }
                : {
                    skillName: skillDef?.skillName ?? "",
                    skillId: skillDef?.skillId ?? null,
                };
            // 最高级三围：取 parameterMap 中 level 最大的一档
            const paramEntries = sit.parameterMap ? Object.values(sit.parameterMap) : [];
            const maxParam = paramEntries.reduce<any>((best, cur: any) =>
                !best || (cur?.level ?? 0) > (best.level ?? 0) ? cur : best, null);
            cards.push({
                situationId,
                characterId: sit.characterId,
                characterName: charInfo?.characterName ?? "",
                colorCode: charInfo?.colorCode ?? "",
                rarity: sit.rarity,
                attribute: sit.attribute,
                prefix: sit.prefix,
                resourceSetName: sit.resourceSetName,
                maxLevel: maxParam?.level ?? null,
                parameters: maxParam
                    ? {
                        performance: maxParam.performance,
                        technique: maxParam.technique,
                        visual: maxParam.visual,
                    }
                    : null,
                skill,
            });
        }
        // 新曲：本期（当期活动开始后 publishedAt）的新歌 → 乐队名/标题/各难度 level/发布日期/获取方式
        const musics: any[] = [];
        if (eventStartAt) {
            for (const m of musicList) {
                if (!m.publishedAt || Number(m.publishedAt) < Number(eventStartAt)) continue;
                const diffLevels = musicDifficulty
                    .filter((d: any) => d.musicId === m.musicId)
                    .map((d: any) => ({ difficulty: d.difficulty, playLevel: d.playLevel }))
                    .sort((a: any, b: any) => a.playLevel - b.playLevel);
                musics.push({
                    musicId: m.musicId,
                    title: m.musicTitle ?? "",
                    bandName: bands[String(m.bandId)]?.bandName ?? "",
                    levels: diffLevels,
                    publishedAt: new Date(Number(m.publishedAt)).toISOString().slice(0, 10),
                    howToGet: m.howToGet ?? "",
                });
            }
        }
        await fs.writeFile(
            path.join(previewRoot, "info.json"),
            JSON.stringify({ dataVersion: version, cards, musics }, null, 2),
            "utf-8"
        );

        console.log(`汇总完成: ${previewRoot}`);
        console.log("─".repeat(60));
    } finally {
        // 9. 清理临时目录
        console.log("[9/9] 清理临时目录 ...");
        await fs.rm(path.join(QUICK_TMP_DIR, version), { recursive: true, force: true });
        console.log(`已清理: quick-tmp/${version}`);
    }
}

if (isMainProcess) {
    main().catch((err) => {
        console.error("错误:", err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
