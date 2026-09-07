import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import axios, { AxiosError } from 'axios';
import {
    assetPath, changedFiles, createMemoryWriter, decodeAcbBuffer, decodeHcaBuffer,
    downloadBundle, finalizeAssets, mergeAudioSegments, pipelineConcurrency,
    unpackBundle, withStagedOutput, writeMemoryFiles,
} from '../src/memoryAssets.js';
import { downloadDiffAssets } from '../src/getAssets.js';
import { decodeSingleAcb } from '../src/decodeAcb.js';
import { audioArchive, silenceHca, textAssets } from './fixtures.js';

async function temporary(t: TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garupa-memory-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

function assertWav(wav: Buffer, rate = 44100) {
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
    assert.equal(wav.readUInt32LE(24), rate);
    assert.equal(wav.length, 44 + 1024 * 2);
    assert.ok(wav.subarray(44).every(b => b === 0));
}

test('HCA slices decode exactly their own bytes, without archive/pool prefix or suffix', async () => {
    const hca = silenceHca();
    const archive = Buffer.concat([Buffer.alloc(53, 0xfe), hca, Buffer.alloc(31, 0xfe)]);
    assertWav(await decodeHcaBuffer(archive.subarray(53, 53 + hca.length)));
});

test('ACB → cue HCA slices → final WAV uses the real parsers', async () => {
    const { acb } = audioArchive([{ name: 'voice_01', data: silenceHca() }]);
    const files = await decodeAcbBuffer(acb);
    assert.deepEqual([...files.keys()], ['voice_01.wav']);
    assertWav(files.get('voice_01.wav')!);
});

test('merge complete ACB fragments before comparing final WAV tracks', async () => {
    const old = audioArchive([{ name: 'same', data: silenceHca() }, { name: 'changed', data: silenceHca(22050) }]);
    const current = audioArchive([{ name: 'same', data: silenceHca() }, { name: 'changed', data: silenceHca(48000) }]);
    const split = (acb: Buffer) => new Map([
        ['sound/live-002.acb', acb.subarray(32)], ['sound/live-001.acb', acb.subarray(0, 32)],
        ['image.png', Buffer.from('same image')],
    ]);
    assert.ok(old.acb.subarray(0, 32).equals(current.acb.subarray(0, 32)));
    const files = changedFiles(await finalizeAssets(split(current.acb)), await finalizeAssets(split(old.acb)));
    assert.deepEqual([...files.keys()], ['sound/live/changed.wav']);
    assertWav(files.get('sound/live/changed.wav')!, 48000);
});

test('external, segmented AWB bytes connect to an in-memory ACB', async () => {
    const { acb, awb } = audioArchive([{ name: 'external', data: silenceHca() }], true);
    const files = await finalizeAssets(new Map([
        ['voice.acb', acb], ['voice-001.awb', awb.subarray(0, 40)], ['voice-002.awb', awb.subarray(40)],
    ]));
    assert.deepEqual([...files.keys()], ['voice/external.wav']);
    assertWav(files.get('voice/external.wav')!);
});

test('non-HCA cue formats and unrelated AWBs are retained', async () => {
    const data = Buffer.from('ADX bytes');
    const { acb } = audioArchive([{ name: 'effect', data, codec: 0 }]);
    const files = await finalizeAssets(new Map([['sound.acb', acb], ['unrelated.awb', data]]));
    assert.deepEqual([...files.keys()], ['sound/effect.adx', 'unrelated.awb']);
    assert.deepEqual(files.get('sound/effect.adx'), data);
});

test('invalid segments, ambiguous outputs and traversal fail visibly', async () => {
    assert.throws(() => mergeAudioSegments(new Map([['a-001.acb', Buffer.alloc(1)], ['a-003.acb', Buffer.alloc(1)]])), /分片/);
    assert.throws(() => mergeAudioSegments(new Map([['a-002.acb', Buffer.alloc(1)]])), /分片/);
    for (const name of ['../escape', 'a/../../escape', '/absolute', 'C:\\absolute', 'a\\..\\escape']) {
        assert.throws(() => assetPath(name), /非法资源路径/);
    }
    const bad = audioArchive([{ name: '../escape', data: silenceHca() }]);
    await assert.rejects(decodeAcbBuffer(bad.acb), /非法资源路径/);
    await assert.rejects(decodeAcbBuffer(Buffer.from('invalid data')), /acb/);
});

test('standalone ACB deletes source only after successful decode/write, and does not stage HCA', async t => {
    const root = await temporary(t);
    const { acb } = audioArchive([{ name: 'voice', data: silenceHca() }]);
    const input = path.join(root, 'sound.acb');
    await fs.writeFile(input, acb);
    const output = await decodeSingleAcb(input);
    assert.deepEqual(await fs.readdir(root), ['sound']);
    assert.deepEqual(await fs.readdir(output), ['voice.wav']);
    await fs.writeFile(input, Buffer.from('invalid data'));
    await assert.rejects(decodeSingleAcb(input));
    assert.equal(await fs.readFile(input, 'utf8'), 'invalid data');
});

test('memory worker exports real serialized TextAssets and propagates parser errors', async () => {
    const files = await unpackBundle(textAssets({ chart: '#BPM 180', text: 'hello' }));
    assert.equal(files.get('chart.txt')?.toString(), '#BPM 180');
    assert.equal(files.get('text.txt')?.toString(), 'hello');
    await assert.rejects(unpackBundle(Buffer.from('not a bundle')));
});

test('memory comparison retains additions and changes, drops identical and removed files', () => {
    const previous = new Map([['same', Buffer.from('same')], ['edited', Buffer.from('old')], ['removed', Buffer.alloc(0)]]);
    const current = new Map([['same', Buffer.from('same')], ['edited', Buffer.from('new')], ['added', Buffer.alloc(0)]]);
    assert.deepEqual([...changedFiles(current, previous).keys()], ['edited', 'added']);
});

test('same-name Unity objects keep PathIDs while unique assets retain their original filenames', async () => {
    const input = textAssets([['_empty_', 'first'], ['_empty_', 'second'], ['chart', '#BPM 180']]);
    const files = await unpackBundle(input);
    assert.deepEqual([...files.keys()], ['_empty_ @1.txt', '_empty_ @2.txt', 'chart.txt']);
    assert.equal(files.get('_empty_ @1.txt')?.toString(), 'first');
    assert.equal(files.get('_empty_ @2.txt')?.toString(), 'second');
    const explicit = await unpackBundle(input, { filenameFormat: 'pathID' });
    assert.deepEqual([...explicit.keys()], ['1.txt', '2.txt', '3.txt']);
});

test('unsupported Shader conversion retains exact serialized bytes instead of failing or dropping it', async () => {
    const input = textAssets({ shader: '' }, 48);
    const expected = input.subarray(input.readUInt32BE(12));
    const files = await unpackBundle(input);
    assert.deepEqual([...files.keys()], ['shader.bin']);
    assert.deepEqual(files.get('shader.bin'), expected);
    const shaderOnly = await unpackBundle(input, { assetType: 'shader' });
    assert.deepEqual(shaderOnly.get('shader.bin'), expected);
});

test('concurrent output collisions are compared in memory and identical writes finish together', async t => {
    const root = await temporary(t);
    const write = createMemoryWriter(root);
    const files = new Map([['nested/file', Buffer.alloc(1024 * 1024, 42)]]);
    await Promise.all([write(files), write(files)]);
    assert.deepEqual(await fs.readFile(path.join(root, 'nested/file')), files.get('nested/file'));
    await assert.rejects(write(new Map([['nested/file', Buffer.from('different')]])), /重名/);
});

test('staged final output replaces stale files; failure preserves last success and cleans staging', async t => {
    const root = await temporary(t);
    const output = path.join(root, 'version');
    await fs.mkdir(output); await fs.writeFile(path.join(output, 'old'), 'old');
    await assert.rejects(withStagedOutput(output, async stage => {
        await writeMemoryFiles(stage, new Map([['partial', Buffer.from('partial')]]));
        throw new Error('decode failed');
    }), /decode failed/);
    assert.deepEqual(await fs.readdir(output), ['old']);
    assert.deepEqual(await fs.readdir(root), ['version']);
    await withStagedOutput(output, stage => writeMemoryFiles(stage, new Map([['new', Buffer.from('new')]])));
    assert.deepEqual(await fs.readdir(output), ['new']);
    assert.deepEqual(await fs.readdir(root), ['version']);
});

test('download retries transient failure, but 403/404 immediately reject', async () => {
    let attempts = 0;
    const client = axios.create({ adapter: async config => {
        attempts++;
        if (attempts === 1) throw new AxiosError('reset', 'ECONNRESET', config);
        return { data: Buffer.from('bundle'), status: 200, statusText: 'OK', headers: {}, config };
    } });
    assert.equal((await downloadBundle('https://example.invalid/', 'bundle', client)).toString(), 'bundle');
    assert.equal(attempts, 2);
    for (const status of [403, 404]) {
        attempts = 0;
        client.defaults.adapter = async config => {
            attempts++;
            throw new AxiosError('missing', 'ERR_BAD_REQUEST', config, undefined,
                { status, statusText: 'missing', data: '', headers: {}, config });
        };
        await assert.rejects(downloadBundle('https://example.invalid/', 'bundle', client));
        assert.equal(attempts, 1);
    }
});

test('diff pipeline pins both versions, unpacks completed downloads, deduplicates in memory, and keeps failures uncommitted', async t => {
    const root = await temporary(t);
    const oldVersion = '1.0.0.1', newVersion = '1.0.0.2';
    await fs.writeFile(path.join(root, 'AssetBundleInfoUrl.json'), JSON.stringify({ latest: {}, hashes: { '1.0.0': 'a'.repeat(64) } }));
    const diffFile = path.join(root, `diff_${oldVersion}_to_${newVersion}.json`);
    // No diff file is created: orchestration passes the in-memory diff directly.
    const originalAdapter = axios.defaults.adapter;
    const originalConcurrency = process.env.ASSET_PIPELINE_CONCURRENCY;
    process.env.ASSET_PIPELINE_CONCURRENCY = '2';
    t.after(() => {
        axios.defaults.adapter = originalAdapter;
        if (originalConcurrency === undefined) delete process.env.ASSET_PIPELINE_CONCURRENCY;
        else process.env.ASSET_PIPELINE_CONCURRENCY = originalConcurrency;
    });
    const requests: string[] = [];
    let releaseOld!: () => void;
    const oldDownload = new Promise<void>(resolve => { releaseOld = resolve; });
    axios.defaults.adapter = async config => {
        requests.push(config.url!);
        const old = config.url!.includes(`/${oldVersion}_`);
        const added = config.url!.endsWith('/added');
        if (old) await oldDownload;
        const data = added ? textAssets({ addition: 'new resource' })
            : textAssets({ same: 'stable', edited: old ? 'old text' : 'new text', ...(old ? {} : { newfile: 'new file' }) });
        return { data, status: 200, statusText: 'OK', headers: {}, config };
    };
    const diff = { new: ['added'], change: ['changed'] };
    const pending = downloadDiffAssets(root, diffFile, diff);
    try {
        // Keep one response pending and prove the other bundle is already unpacked/written.
        let completedWhileDownloading = false;
        for (let i = 0; i < 200; i++) {
            const stages = await fs.readdir(path.join(root, 'assets')).catch(() => [] as string[]);
            const stage = stages.find(name => name.startsWith(`.${newVersion}-`));
            if (stage) {
                const text = await fs.readFile(path.join(root, 'assets', stage, 'new/addition.txt'), 'utf8').catch(() => '');
                if (text === 'new resource') { completedWhileDownloading = true; break; }
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(completedWhileDownloading, 'the completed bundle should unpack before all downloads finish');
    } finally {
        releaseOld();
    }
    const result = await pending;
    assert.equal(result.failed, 0); assert.equal(result.total, 2);
    assert.equal(requests.length, 3);
    assert.equal(requests.filter(url => url.includes(`/${oldVersion}_`)).length, 1);
    assert.deepEqual((await fs.readdir(path.join(result.output, 'change'))).sort(), ['edited.txt', 'newfile.txt']);
    assert.equal(await fs.readFile(path.join(result.output, 'new/addition.txt'), 'utf8'), 'new resource');
    assert.deepEqual((await fs.readdir(root)).sort(), ['AssetBundleInfoUrl.json', 'assets']);
    axios.defaults.adapter = async config => ({ data: Buffer.from('broken bundle'), status: 200, statusText: 'OK', headers: {}, config });
    const failed = await downloadDiffAssets(root, diffFile, diff);
    assert.equal(failed.failed, 2);
    assert.equal(await fs.readFile(path.join(result.output, 'new/addition.txt'), 'utf8'), 'new resource');
    assert.deepEqual(await fs.readdir(path.join(root, 'assets')), [newVersion]);
});

test('pipeline concurrency cannot accidentally become unbounded', () => {
    assert.equal(pipelineConcurrency('2'), 2);
    for (const value of ['0', '-1', '1.5', 'NaN', '100']) assert.throws(() => pipelineConcurrency(value));
});

test('optional real card bundle produces four PNGs from a Buffer', { skip: !process.env.ASSET_STUDIO_TEST_INPUT }, async () => {
    const files = await unpackBundle(await fs.readFile(process.env.ASSET_STUDIO_TEST_INPUT!));
    assert.equal(files.size, 4);
    for (const [name, data] of files) {
        assert.match(name, /\.png$/);
        assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }
});
