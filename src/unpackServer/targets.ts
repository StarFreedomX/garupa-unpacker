import * as path from "node:path";
import type { AssetDiff } from "../compare.js";
import type { MemoryFiles } from "../memoryAssets.js";
import type { NoticeKind } from "./onebot.js";

export type BundleKind = NoticeKind | "thumbnail";

export interface BundleTarget {
    bundle: string;
    kind: BundleKind;
    status: "new" | "change";
    /** 聚合包只保留最终文件层面的新增项。 */
    additionsOnly: boolean;
}

function classify(bundle: string): Omit<BundleTarget, "bundle" | "status"> | null {
    if (/^characters\/resourceset\/[^/]+$/.test(bundle)) return { kind: "card", additionsOnly: false };
    if (/^thumb\/chara\/card/.test(bundle)) return { kind: "thumbnail", additionsOnly: true };
    if (/^gacha\/screen\//.test(bundle) || /^genericanimation\/dream(?:_kirameki)?_festival_/.test(bundle)) {
        return { kind: "card-pool", additionsOnly: false };
    }
    if (bundle === "stamp/01") return { kind: "stamp", additionsOnly: true };
    if (bundle === "sound/voice_stamp") return { kind: "voice-stamp", additionsOnly: true };
    if (/^event\/(?!monthly_ranking_)[^/]+\/(?:images|slide)$/.test(bundle)) {
        return { kind: "event", additionsOnly: false };
    }
    if (bundle === "thumb/degree") return { kind: "event-badge", additionsOnly: true };
    if (/^musicjacket\/musicjacket\d+$/.test(bundle)
        || bundle === "sound/ingamebgm"
        || /^sound\/bgm\d+$/.test(bundle)) {
        return { kind: "music", additionsOnly: true };
    }
    return null;
}

export function selectBundleTargets(diff: AssetDiff): BundleTarget[] {
    const targets = new Map<string, BundleTarget>();
    for (const status of ["new", "change"] as const) {
        for (const bundle of diff[status]) {
            const selected = classify(bundle);
            if (selected) targets.set(bundle, { bundle, status, ...selected });
        }
    }
    return [...targets.values()].sort((a, b) => a.bundle.localeCompare(b.bundle));
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const AUDIO_EXT = /\.(wav|mp3|ogg|flac|m4a)$/i;

function tailAfterBundle(name: string, bundle: string): string {
    const normalized = name.replace(/\\/g, "/");
    const marker = `/${bundle.toLowerCase()}/`;
    const index = normalized.toLowerCase().indexOf(marker);
    return index >= 0 ? normalized.slice(index + marker.length) : path.posix.basename(normalized);
}

/** 从一个已解包 bundle 中选出需要落盘/通知的最终资源。 */
export function pickTargetFiles(target: BundleTarget, files: MemoryFiles, newResourceSets: Set<string>): MemoryFiles {
    const picked: MemoryFiles = new Map();
    const resourceSet = target.bundle.match(/^characters\/resourceset\/([^/]+)$/)?.[1];
    for (const [name, bytes] of files) {
        const base = path.posix.basename(name);
        const lower = base.toLowerCase();
        if (target.kind === "card" && resourceSet
            && ["card_normal.png", "card_after_training.png"].includes(lower)) {
            picked.set(`cards/${resourceSet}_${lower}`, bytes);
        } else if (target.kind === "thumbnail") {
            const found = base.match(/^(res\d{6})_(normal|after_training)\.png$/i)?.[1];
            if (found && newResourceSets.has(found)) picked.set(`thumbnail/${base}`, bytes);
        } else if (target.kind === "card-pool" && IMAGE_EXT.test(base)) {
            const dream = target.bundle.startsWith("genericanimation/");
            if ((dream && /^name_text\./i.test(base)) || (!dream && /^pickup\d*_name\./i.test(base))) {
                picked.set(`card-pool/${target.bundle.split("/").at(-1)}_${base}`, bytes);
            }
        } else if (target.kind === "stamp" && IMAGE_EXT.test(base)) {
            picked.set(`stamp/${base}`, bytes);
        } else if (target.kind === "voice-stamp" && AUDIO_EXT.test(base)) {
            picked.set(`voice-stamp/${base}`, bytes);
        } else if (target.kind === "event" && IMAGE_EXT.test(base)) {
            const [, eventName, section] = target.bundle.split("/");
            picked.set(`event/${eventName}/${section}/${base}`, bytes);
        } else if (target.kind === "event-badge" && /^degree_event\d+_.+\.(?:png|jpe?g|gif|webp)$/i.test(base)) {
            picked.set(`event-badge/${base}`, bytes);
        } else if (target.kind === "music"
            && ((target.bundle.startsWith("musicjacket/") && /^jacket\.(?:png|jpe?g|gif|webp)$/i.test(base))
                || (target.bundle.startsWith("sound/") && AUDIO_EXT.test(base)))) {
            picked.set(`music/${target.bundle.split("/").at(-1)}/${tailAfterBundle(name, target.bundle)}`, bytes);
        }
    }
    return picked;
}

export function resourceSetsFromDiff(diff: AssetDiff): Set<string> {
    return new Set(diff.new.flatMap(bundle => {
        const match = bundle.match(/^characters\/resourceset\/([^/]+)$/);
        return match ? [match[1]] : [];
    }));
}
