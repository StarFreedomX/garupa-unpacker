import { fileURLToPath } from "url";
import { downloadAB } from "@/downloadAssetBundleInfo.js";
import { compareVersions } from "@/compare.js";
import { downloadDiffAssets } from "@/getAssets.js";
import { exportLatestAssets, getCategoryPaths, getDefaultPaths } from "@/export.js";
import { removeUnchangedFiles } from "@/removeUnchangedFiles.js";
import { mergeAllSegmentedAcbFiles } from "@/mergeBytes.js";
import { decodeLatestAssets } from "@/decodeAcb.js";
import { flatFolder } from "@/flatFolder.js";
import path from "path";

const isMainProcess = process.argv[1] === fileURLToPath(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function main() {
    console.log('正在执行完整流程......')
    const readline = await import('readline/promises');
    const process = await import('process');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const inputQ1 = await rl.question("请输入 AssetBundleInfo URL或版本号（留空自动检测更新）：\n> ");


    const result = await downloadAB(inputQ1 || undefined);
    console.log(`下载AssetBundleInfo完成: ${result.filePath}`);

    console.log('─'.repeat(60));

    console.log('对比文件中...');
    let outFile: string, summary: {added: number, changed: number}, versions: {verOld: string, verNew: string};
    try {
        ({outFile, summary, versions} = await compareVersions());
    }catch(err) {
        const inputQ2 = await rl.question("未找到已下载版本，请输入被比较的另一版本：\n> ");
        const result = await downloadAB(inputQ2 || undefined);
        console.log(`下载AssetBundleInfo完成: ${result.filePath}`);
        console.log('─'.repeat(60));
        console.log('对比文件中...');
        ({outFile, summary, versions} = await compareVersions());
    }

    console.log(`\n✔ 对比完成: ${versions.verOld} → ${versions.verNew}`);
    console.log(`新增: ${summary.added}, 修改: ${summary.changed}`);
    console.log(`结果已保存到: ${outFile}`);
    rl.close();

    console.log('─'.repeat(60));

    console.log('下载更改的文件...');
    await downloadDiffAssets(PROJECT_ROOT);

    console.log('─'.repeat(60));

    console.log('开始进行解包...');
    await exportLatestAssets();

    console.log('─'.repeat(60));

    console.log('文件去重中...')
    const {input, output} = getDefaultPaths();
    const categoryFolders = getCategoryPaths(input);
    // 处理 change 与 change_old
    if (categoryFolders.includes("change") && categoryFolders.includes("change_old")) {
        await removeUnchangedFiles(
            path.join(output, "change_old"),
            path.join(output, "change")
        );
    } else {
        console.log("未找到 change/change_old 文件夹，跳过比较。");
    }

    console.log('─'.repeat(60));

    console.log('合并分段acb文件...');
    await mergeAllSegmentedAcbFiles(output);

    console.log('─'.repeat(60));

    console.log('解析acb文件...');
    await decodeLatestAssets();

    console.log('─'.repeat(60));

    console.log('扁平化路径...')
    await flatFolder(output)

    console.log('─'.repeat(60));

    console.log('解包完成')







}
if (isMainProcess)
    main();
