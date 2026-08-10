#!/usr/bin/env npx tsx
/**
 * 简易更新探测：只拉取 SuiteMaster，输出最新 10 张卡、最新 2 个活动、最新 10 首歌曲。
 * 无版本挑选、无 diff、无资源下载，每次覆盖 assets/quick-master/。
 * 用法: npx tsx ./src/quickMaster.ts
 */
import * as fs from "node:fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { getClientVersion } from "./garupa/version.js";
import { fetchSuiteMaster } from "./garupa/api/suiteMaster.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(PROJECT_ROOT, "assets", "quick-master");
const OUT_FILE = path.join(OUT_DIR, "master.json");

const TOP_CARDS = 10;
const TOP_EVENTS = 2;
const TOP_MUSICS = 10;
/** 2100-01-01（毫秒）：游戏对比赛用非正常卡（如ガルパ杯）使用远未来占位 releasedAt，需过滤 */
const PLACEHOLDER_RELEASE_THRESHOLD = 4102444800000;

/** uint64(字符串) → YYYY-MM-DD */
function dateStr(ts: string | number | undefined | null): string | null {
    if (ts == null || ts === "") return null;
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n).toISOString().slice(0, 10);
}

async function main() {
    console.log("简易更新探测：只拉取 SuiteMaster → 最新卡/活动/歌曲");
    console.log("─".repeat(60));

    const clientVersion = await getClientVersion();
    const suite = await fetchSuiteMaster(clientVersion);

    const situations: Record<string, any> = suite.masterCharacterSituationMap?.entries ?? {};
    const charInfos: Record<string, any> = suite.masterCharacterInfoMap?.entries ?? {};
    const events: Record<string, any> = suite.masterEventMap?.entries ?? {};
    const musicList: any[] = suite.masterMusicList?.entries ?? [];
    const bands: Record<string, any> = suite.masterBandMap?.entries ?? {};
    const musicDifficulty: any[] = suite.masterMusicDifficultyList?.entries ?? [];
    const skillDefs: Record<string, any> = suite.masterSituationSkillMap?.entries ?? {};
    const skillList: any[] = suite.masterSkillList?.entries ?? [];
    const skillOnceEffects: any[] = Object.values(suite.masterSkillOnceEffectList?.entries ?? {});
    const skillActEffects: any[] = Object.values(suite.masterSkillActivateEffectList?.entries ?? {});
    console.log(
        `SuiteMaster 就绪 (situations=${Object.keys(situations).length}, events=${Object.keys(events).length}, musics=${musicList.length})`
    );
    console.log("─".repeat(60));

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

    // 1. 最新 10 张卡：按 releasedAt 倒序（过滤远未来占位日期的比赛用非正常卡）
    const cards = Object.values(situations)
        .filter((s: any) => Number(s.releasedAt ?? 0) < PLACEHOLDER_RELEASE_THRESHOLD)
        .sort((a: any, b: any) => Number(b.releasedAt ?? 0) - Number(a.releasedAt ?? 0))
        .slice(0, TOP_CARDS)
        .map((sit: any) => {
            const charInfo = charInfos[String(sit.characterId)];
            // 最高级三围：parameterMap 中 level 最大的一档
            const paramEntries = sit.parameterMap ? Object.values(sit.parameterMap) : [];
            const maxParam = paramEntries.reduce<any>((best, cur: any) =>
                !best || (cur?.level ?? 0) > (best.level ?? 0) ? cur : best, null);
            // 技能：situationSkillId → skillDef → skillList(lv1) → 占位符填充描述
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
            return {
                situationId: sit.situationId,
                characterId: sit.characterId,
                characterName: charInfo?.characterName ?? "",
                colorCode: charInfo?.colorCode ?? "",
                rarity: sit.rarity,
                attribute: sit.attribute,
                prefix: sit.prefix,
                resourceSetName: sit.resourceSetName,
                releasedAt: dateStr(sit.releasedAt),
                maxLevel: maxParam?.level ?? null,
                parameters: maxParam
                    ? {
                        performance: maxParam.performance,
                        technique: maxParam.technique,
                        visual: maxParam.visual,
                    }
                    : null,
                skill,
            };
        });

    // 2. 最新 2 个活动：按 startAt 倒序
    const topEvents = Object.values(events)
        .sort((a: any, b: any) => Number(b.startAt ?? 0) - Number(a.startAt ?? 0))
        .slice(0, TOP_EVENTS)
        .map((ev: any) => ({
            eventId: ev.eventId,
            eventType: ev.eventType,
            eventName: ev.eventName,
            assetBundleName: ev.assetBundleName,
            startAt: dateStr(ev.startAt),
            endAt: dateStr(ev.endAt),
        }));

    // 3. 最新 10 首歌曲：按 publishedAt 倒序，附各难度等级
    const songs = musicList
        .sort((a: any, b: any) => Number(b.publishedAt ?? 0) - Number(a.publishedAt ?? 0))
        .slice(0, TOP_MUSICS)
        .map((m: any) => ({
            musicId: m.musicId,
            title: m.musicTitle ?? "",
            bandName: bands[String(m.bandId)]?.bandName ?? "",
            publishedAt: dateStr(m.publishedAt),
            howToGet: m.howToGet ?? "",
            levels: musicDifficulty
                .filter((d: any) => d.musicId === m.musicId)
                .map((d: any) => ({ difficulty: d.difficulty, playLevel: d.playLevel }))
                .sort((a: any, b: any) => a.playLevel - b.playLevel),
        }));

    const payload = {
        fetchedAt: new Date().toISOString(),
        clientVersion,
        cards,
        events: topEvents,
        songs,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf-8");

    console.log(`最新卡片 ${cards.length}:`);
    for (const c of cards) {
        const skillDesc = (c.skill?.simpleDescription || c.skill?.skillName || "").replace(/\s+/g, " ");
        console.log(`  [${c.releasedAt ?? "?"}] ${c.characterName} ${c.prefix ?? ""} ★${c.rarity} ${c.attribute ?? ""} | 技能: ${skillDesc}`);
    }
    console.log(`最新活动 ${topEvents.length}:`);
    for (const e of topEvents) console.log(`  [${e.startAt ?? "?"}] ${e.eventName} (${e.eventType ?? "?"})`);
    console.log(`最新歌曲 ${songs.length}:`);
    for (const s of songs) console.log(`  [${s.publishedAt ?? "?"}] ${s.title} (${s.bandName || "?"})`);
    console.log("─".repeat(60));
    console.log(`已输出: ${OUT_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        console.error("错误:", err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
