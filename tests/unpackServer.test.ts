import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { compareAssetMaps, parseAssetBundleInfo } from "../src/compare.js";
import { buildPreviewInfo } from "../src/unpackServer/master.js";
import { OneBotNotifier } from "../src/unpackServer/onebot.js";
import type { UnpackServerConfig } from "../src/unpackServer/config.js";
import { emptyServerState, ensureCycle, loadServerState, saveServerState } from "../src/unpackServer/state.js";
import { pickTargetFiles, resourceSetsFromDiff, selectBundleTargets } from "../src/unpackServer/targets.js";
import { indexFilesToMemory, type UnpackedBundleIndex } from "../src/unpackServer/unpackedIndex.js";
import { incrementVersion, predictedVersion } from "../src/unpackServer/version.js";

async function temporary(t: TestContext): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "garupa-server-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

test("version prediction follows normal and 90 rollover steps", () => {
    assert.equal(incrementVersion("10.1.0.250"), "10.1.0.260");
    assert.equal(incrementVersion("10.1.0.290"), "10.1.0.310");
    assert.throws(() => incrementVersion("10.1.bad.20"), /Invalid/);
    assert.throws(() => incrementVersion("20"), /Invalid/);
});

test("in-memory manifests compare without writing a temporary diff", () => {
    const hashA = "a".repeat(64), hashB = "b".repeat(64), hashC = "c".repeat(64);
    const previous = parseAssetBundleInfo(`x/path @${hashA}\nsame/path @${hashB}`);
    const current = parseAssetBundleInfo(`x/path @${hashC}\nsame/path @${hashB}\nnew/path @${hashA}`);
    assert.deepEqual(compareAssetMaps(current, previous), { new: ["new/path"], change: ["x/path"] });
});

test("target selection includes requested resources and excludes unrelated bundles", () => {
    const diff = {
        new: ["characters/resourceset/res123456", "event/new_event/slide", "sound/bgm807", "other/data"],
        change: ["stamp/01", "sound/voice_stamp", "thumb/chara/card800", "musicjacket/musicjacket820", "thumb/degree"],
    };
    assert.deepEqual(resourceSetsFromDiff(diff), new Set(["res123456"]));
    const targets = selectBundleTargets(diff);
    assert.equal(targets.length, 8);
    assert.equal(targets.find(target => target.bundle === "stamp/01")?.additionsOnly, true);
    assert.equal(targets.find(target => target.bundle === "event/new_event/slide")?.kind, "event");
    assert.equal(targets.find(target => target.bundle === "sound/bgm807")?.kind, "music");
    assert.equal(targets.find(target => target.bundle === "thumb/degree")?.kind, "event-badge");
    assert.ok(!targets.some(target => target.bundle === "other/data"));
});

test("file filters keep card art and newly compared stamp media only", () => {
    const cardTarget = selectBundleTargets({ new: ["characters/resourceset/res123456"], change: [] })[0];
    const cards = pickTargetFiles(cardTarget, new Map([
        ["card_normal.png", Buffer.from("normal")],
        ["card_after_training.png", Buffer.from("trained")],
        ["trim_normal.png", Buffer.from("ignore")],
    ]), new Set(["res123456"]));
    assert.deepEqual([...cards.keys()], [
        "cards/res123456_card_normal.png",
        "cards/res123456_card_after_training.png",
    ]);

    const stampTarget = selectBundleTargets({ new: [], change: ["stamp/01"] })[0];
    const stamps = pickTargetFiles(stampTarget, new Map([
        ["stamp_new.png", Buffer.from("image")], ["metadata.json", Buffer.from("data")],
    ]), new Set());
    assert.deepEqual([...stamps.keys()], ["stamp/stamp_new.png"]);
});

test("music targets only send the full jacket and full song audio", () => {
    const targets = selectBundleTargets({
        new: ["sound/bgm807"],
        change: ["musicjacket/musicjacket810", "musicscore/musicscore810"],
    });
    assert.ok(!targets.some(target => target.bundle.startsWith("musicscore/")));
    const jacketTarget = targets.find(target => target.bundle.startsWith("musicjacket/"))!;
    const jackets = pickTargetFiles(jacketTarget, new Map([
        ["assets/startapp/musicjacket/musicjacket810/807_song/jacket.png", Buffer.from("jacket")],
        ["assets/startapp/musicjacket/musicjacket810/807_song/thumb.png", Buffer.from("thumb")],
    ]), new Set());
    assert.deepEqual([...jackets.keys()], ["music/musicjacket810/807_song/jacket.png"]);
    const bgmTarget = targets.find(target => target.bundle === "sound/bgm807")!;
    const audio = pickTargetFiles(bgmTarget, new Map([
        ["Bgm807/bgm807.wav", Buffer.from("full")],
        ["Bgm807/metadata.json", Buffer.from("metadata")],
    ]), new Set());
    assert.deepEqual([...audio.keys()], ["music/bgm807/bgm807.wav"]);
});

test("OneBot can merge images from one bundle into one message", async t => {
    const root = await temporary(t);
    const first = path.join(root, "first.png"), second = path.join(root, "second.png");
    const voice = path.join(root, "voice.wav");
    await Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second"), fs.writeFile(voice, "voice")]);
    const received: unknown[] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
            received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ status: "ok", retcode: 0 }));
        });
    });
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const config: UnpackServerConfig = {
        projectRoot: root, outputRoot: root, stateFile: path.join(root, "state.json"),
        applicationPollMs: 1_000, cdnPollMs: 1_000, host: "127.0.0.1", port: 0,
        dryRun: false, historicalReplay: false, mergeBundleImages: true,
        oneBotBaseUrl: `http://127.0.0.1:${port}`, oneBotGroupIds: ["123"],
    };
    await new OneBotNotifier(config).sendImageBatch("123", [
        { kind: "event", version: "1.0.0.20", bundle: "event/test/slide", name: "rule1.png", file: first },
        { kind: "event", version: "1.0.0.20", bundle: "event/test/slide", name: "rule2.png", file: second },
    ]);
    assert.equal(received.length, 1);
    const body = received[0] as {
        group_id: string;
        message: Array<{ type: string; data?: { text?: string } }>;
    };
    assert.equal(body.group_id, "123");
    assert.equal(body.message.filter(segment => segment.type === "image").length, 2);
    const texts = body.message.filter(segment => segment.type === "text");
    assert.equal(texts.length, 1);
    assert.equal(texts[0].data?.text, "【Garupa 1.0.0.20】活动介绍图（2张）\n");
    assert.doesNotMatch(texts[0].data?.text ?? "", /rule\d|event\/test|first\.png|second\.png/);
    await new OneBotNotifier(config).sendResource("123", {
        kind: "voice-stamp", version: "1.0.0.20", bundle: "sound/voice_stamp",
        name: "voice-stamp/voice.wav", file: voice,
    });
    assert.equal(received.length, 3);
    const voiceMessage = received[1] as { message: string };
    assert.equal(voiceMessage.message, "【Garupa 1.0.0.20】新增语音表情");
    assert.doesNotMatch(voiceMessage.message, /voice\.wav|sound\/voice_stamp/);
    const upload = received[2] as { file: string; name: string };
    assert.equal(upload.name, "voice.wav");
    assert.match(upload.file, /^base64:\/\//);
});

test("OneBot accepts only NapCat send timeout retcodes without history lookup", async t => {
    const root = await temporary(t);
    let requestCount = 0;
    const server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
            requestCount++;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(requestCount === 1
                ? { status: "failed", retcode: 1200, message: "Timeout: NTEvent sendMsg" }
                : { status: "failed", retcode: 1200, message: "EventChecker Failed: rich media transfer failed" }));
        });
    });
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const config: UnpackServerConfig = {
        projectRoot: root, outputRoot: root, stateFile: path.join(root, "state.json"),
        applicationPollMs: 1_000, cdnPollMs: 1_000, host: "127.0.0.1", port: 0,
        dryRun: false, historicalReplay: false, mergeBundleImages: true,
        oneBotBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        oneBotGroupIds: ["123"],
    };
    const notifier = new OneBotNotifier(config);
    await notifier.sendText("123", "accepted timeout");
    await assert.rejects(() => notifier.sendText("123", "real failure"), /rich media transfer failed/);
    assert.equal(requestCount, 2);
});

test("SuiteMaster metadata is limited to diff cards and genuinely new music IDs", () => {
    const suite = {
        masterCharacterSituationMap: { entries: {
            "1": { situationId: 1, characterId: 10, resourceSetName: "res123456", rarity: 5,
                attribute: "cool", prefix: "New", situationSkillId: 20,
                parameterMap: { 1: { level: 1, performance: 1, technique: 2, visual: 3 },
                    50: { level: 50, performance: 100, technique: 200, visual: 300 } } },
            "2": { situationId: 2, characterId: 11, resourceSetName: "res000001" },
        } },
        masterCharacterInfoMap: { entries: { "10": { characterName: "Character" } } },
        masterSituationSkillMap: { entries: { "20": { skillId: 30, skillName: "Skill" } } },
        masterSkillList: { entries: [{ skillId: 30, skillLevel: 1, description: "score {0}" }] },
        masterSkillOnceEffectList: { entries: { a: { skillId: 30, skillLevel: 1, colorDescription: "100%" } } },
        masterMusicList: { entries: [
            { musicId: 1, musicTitle: "Old" }, { musicId: 2, musicTitle: "New Song", bandId: 5 },
        ] },
        masterBandMap: { entries: { "5": { bandName: "Band" } } },
        masterMusicDifficultyList: { entries: [{ musicId: 2, difficulty: "expert", playLevel: 27 }] },
    };
    const info = buildPreviewInfo(suite, "1.0.0.20", new Set(["res123456"]), [1]);
    assert.equal(info.cards.length, 1);
    assert.deepEqual(info.cards[0].parameters, { performance: 100, technique: 200, visual: 300 });
    assert.equal(info.cards[0].skill.description, "score 100%");
    assert.deepEqual(info.musics.map(music => music.title), ["New Song"]);
});

test("server state survives restart and confirmed cycles upgrade speculative ones", async t => {
    const root = await temporary(t);
    const file = path.join(root, "state.json");
    const state = emptyServerState();
    const cycle = ensureCycle(state, "1.0.0.10", "1.0.0.20", false);
    cycle.sent["group|card|file"] = "digest";
    assert.equal(ensureCycle(state, "1.0.0.10", "1.0.0.20", true).confirmed, true);
    await saveServerState(file, state);
    assert.deepEqual(await loadServerState(file), state);
});

test("bundle index only marks new files and additions-only targets reject modifications", async t => {
    const root = await temporary(t);
    const files = { added: path.join(root, "added"), modified: path.join(root, "modified") };
    await Promise.all(Object.entries(files).map(([name, file]) => fs.writeFile(file, name)));
    const index: UnpackedBundleIndex = {
        bundle: "stamp/01", status: "change", completedAt: new Date().toISOString(),
        files: [
            { name: "added.png", relative: files.added, new: true },
            { name: "modified.png", relative: files.modified, new: false },
        ],
    };
    assert.deepEqual([...await indexFilesToMemory(index, false).then(result => result.keys())], ["added.png", "modified.png"]);
    assert.deepEqual([...await indexFilesToMemory(index, true).then(result => result.keys())], ["added.png"]);
});

test("prediction uses the newest known CDN line, then normal increments", () => {
    const lines = ["10.0.0", "10.2.0", "10.1.0"];
    assert.equal(predictedVersion("10.1.0.290", lines), "10.2.0.100");
    assert.equal(predictedVersion("10.2.0.100", lines), "10.2.0.110");
    assert.equal(predictedVersion("10.3.0.221", lines), "10.3.0.230");
    assert.equal(predictedVersion("10.1.0.290"), "10.1.0.310");
    assert.equal(predictedVersion("9.9.0.221", ["9.9.0", "10.2.0"]), "10.2.0.100");
});

test("prediction rounds patch revisions and skips whole hundreds", () => {
    for (const [version, expected] of [
        ["10.1.0.220", "10.1.0.230"],
        ["10.1.0.221", "10.1.0.230"],
        ["10.1.0.190", "10.1.0.210"],
        ["10.1.0.191", "10.1.0.210"],
        ["10.1.0.299", "10.1.0.310"],
    ]) assert.equal(predictedVersion(version), expected);
});
