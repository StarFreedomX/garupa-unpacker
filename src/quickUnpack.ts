/**
 * 快捷解包：只解最新版本，产出当期活动卡池（含梦限）、新卡面、新表情（图+语音）、当期活动介绍、新卡面技能。
 * bundle、音频转换及筛选在内存中完成，只写 assets/<ver>-preview/ 最终汇总。
 * 绝不写 analysing/，不改动全量流程任何文件。
 * 用法: npx tsx ./src/quickUnpack.ts
 */
import dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as path from "path";
import pLimit from "p-limit";
import { integerSetting } from "./network.js";
import { downloadBundle, pipelineConcurrency, unpackBundle, withStagedOutput, createMemoryWriter, type MemoryFiles } from "./memoryAssets.js";
import { fileURLToPath } from "url";
import readline from "node:readline/promises";
import { downloadAB } from "@/downloadAssetBundleInfo.js";
import { compareVersions, listDownloadedVersions } from "@/compare.js";
import { fetchSuiteMaster } from "@/garupa/api/suiteMaster.js";
import { mainVersion, buildAssetBundleUrl, loadStore } from "@/garupa/assetBundleInfo.js";

dotenv.config();

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const STORE_JSON = path.join(PROJECT_ROOT, "AssetBundleInfoUrl.json");
const PREVIEW_BASE = path.join(PROJECT_ROOT, "assets");

const IMAGE_EXTS = [".png", ".jpg", ".jpeg"];

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
        // 旧版本 = AssetBundleInfo/ 目录里比新版本旧且最接近的已下载版本
        const downloaded = await listDownloadedVersions();
        const idx = downloaded.indexOf(version);
        if (idx <= 0) throw new Error(`版本 ${version} 没有更旧版本可比较`);
        const { outFile, versions, diff: compared } = await compareVersions(version, downloaded[idx - 1]);
        console.log(`对比完成: ${versions.verOld} → ${versions.verNew}`);
        console.log(`差异文件: ${outFile}`);
        diff = compared;
    } catch {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const inputQ2 = await rl.question("前一个版本文件缺失，请输入被比较的前一版本 dataVersion：\n> ");
        rl.close();
        await downloadAB(inputQ2.trim() || undefined);
        const { outFile, versions, diff: compared } = await compareVersions(version, inputQ2.trim());
        console.log(`对比完成: ${versions.verOld} → ${versions.verNew}`);
        diff = compared;
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

    const previewOutput = path.join(PREVIEW_BASE, `${version}-preview`);
    await withStagedOutput(previewOutput, async previewRoot => {
        const writeFiles = createMemoryWriter(previewRoot);
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

        // 6–8. Download each selected bundle, decode, then pick final files immediately.
        console.log("[6–8/9] 边下载边解包并汇总筛选结果 ...");
        const store = await loadStore(STORE_JSON);
        const hash = store.hashes[mainVersion(version)];
        if (!hash) throw new Error(`hashes 缺少主版本 ${mainVersion(version)} 的 hash`);
        const baseUrl = buildAssetBundleUrl(version, hash).split("/AssetBundleInfo")[0] + "/";
        const limit = pLimit(pipelineConcurrency(process.env.QUICK_UNPACK_CONCURRENCY ?? process.env.ASSET_PIPELINE_CONCURRENCY));
        const unpack = pLimit(integerSetting('UNPACK_CONCURRENCY', 4));
        const monthlyBundles = new Set(monthlyRankings.filter(m => m.assetBundleName)
            .map(m => `event/${m.assetBundleName}/topscreen`));
        const tasks = [...downloadSet].map(bundle => limit(async () => {
            try {
                const bytes = await downloadBundle(baseUrl, bundle);
                const files = await unpack(() => unpackBundle(bytes));
                const picked: MemoryFiles = new Map();
                for (const [name, data] of files) {
                    const base = path.posix.basename(name);
                    const ext = path.posix.extname(base).toLowerCase();
                    const stem = base.slice(0, base.length - ext.length);
                    const isImage = IMAGE_EXTS.includes(ext);
                    if (isImage && ((hasDreamFestival && bundle.startsWith('genericanimation/dream_festival_') && /^name_text\./i.test(base))
                        || (!hasDreamFestival && bundle.startsWith('gacha/screen/') && /^pickup\d*_name\./i.test(base)))) {
                        picked.set(`gacha/${base}`, data);
                    }
                    const res = bundle.match(/^characters\/resourceset\/([^/]+)$/)?.[1];
                    if (res && newResSet.has(res) && ['card_normal.png', 'card_after_training.png'].includes(base.toLowerCase())) {
                        picked.set(`cards/${res}_${base.toLowerCase()}`, data);
                    }
                    const thumbRes = base.match(/^(res\d{6})_/)?.[1];
                    if (isImage && bundle.startsWith('thumb/chara/card') && thumbRes && newResSet.has(thumbRes)) {
                        picked.set(`thumbnail/${base}`, data);
                    }
                    if (stampWhitelist.has(stem) && ((bundle === 'stamp/01' && isImage)
                        || (bundle === 'sound/voice_stamp' && ext === '.wav'))) {
                        picked.set(`stamp/${base}`, data);
                    }
                    if (isImage && eventAssetBundle && bundle.startsWith(`event/${eventAssetBundle}/`)) {
                        const sub = `${bundle}/${name}`.slice(`event/${eventAssetBundle}/`.length).split('/')[0];
                        picked.set(`event/${sub}_${base}`, data);
                    }
                    if (monthlyBundles.has(bundle) && base.toLowerCase() === 'bg_eventtop.png') {
                        picked.set('monthlyranking/bg_eventtop.png', data);
                    }
                }
                await writeFiles(picked);
                console.log(`[完成] ${bundle}: 汇总 ${picked.size} 个文件`);
            } catch (error) {
                throw new Error(`${bundle}: ${error instanceof Error ? error.message : error}`);
            }
        }));
        const results = await Promise.allSettled(tasks);
        const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
        if (errors.length) {
            for (const error of errors) console.error(error.message);
            throw new AggregateError(errors, `${errors.length} 个 bundle 处理失败，保留原预览输出`);
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

    });
    console.log(`[9/9] 汇总完成: ${previewOutput}`);
}

if (isMainProcess) {
    main().catch((err) => {
        console.error("错误:", err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
