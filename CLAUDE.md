## 当前工作：Garupa 游戏 API 工具集（TypeScript）

### 位置
`E:\JetBrainProjects\WebStormProjects\garupa-getAssets`

### 文件
```
proto/
├── CE.proto                      # 权威 schema（proto3，package CE，~9755 行，含 SuiteMasterGetResponse 全部字段）
└── gen/
    ├── CE.js                     # 由 CE.proto 编译生成（protobufjs pbjs 静态模块，~30 MB，勿手改）
    └── CE.d.ts                   # 由 CE.js 生成（pbts，~9.6 MB）
src/
├── index.ts                      # 一键流程：下载→对比→下载差异资源→解包→去重→合并→解码→扁平化
├── downloadAssetBundleInfo.ts    # CLI：下载 AssetBundleInfo（留空 = 自动检测最新版）
├── getAssets.ts                  # CLI：按 diff 下载差异资源到 analysing/<版本>/{new,change,change_old}
├── compare.ts                    # CLI：对比 AssetBundleInfo 两个版本 → compare/diff_<旧>_to_<新>.json
├── export.ts                     # CLI：解包（node-asset-studio-mod）+ getDefaultPaths(version?)
├── removeUnchangedFiles.ts       # CLI：比对 change_old/change 删除内容未变的文件
├── mergeBytes.ts                 # CLI：合并分段 .acb（-001/-002 分片）
├── decodeAcb.ts                  # CLI：解 .acb 并解码 HCA → wav，change 与 change_old 同步解码去重
├── flatFolder.ts                 # CLI：把「只有单个子文件夹」的层级压平
├── downloadChart.ts              # CLI：按 bgmNumber 下载对应 musicscore 谱面包并解包
├── suiteMaster.ts                # CLI：拉取 SuiteMaster → 写 JSON（编排用）
└── garupa/
    ├── assetBundleInfo.ts        # AssetBundleInfoUrl.json 存取 + URL 构造（共享模块）
    ├── config.ts                 # dotenv、AES 密钥懒加载、常量、请求头
    ├── http.ts                   # 通用 download() 工具
    ├── version.ts                # getClientVersion() / getDataVersion() / getAppVersions()
    ├── parser/
    │   └── index.ts              # 公共解析器：decryptAes / decompressBzip2 / decodeSuiteMaster / decodeAppGet
    └── api/
        ├── application.ts        # fetchApplication() → AppGetResponse
        └── suiteMaster.ts        # fetchSuiteMaster() → 完整管线 → JSON 对象
```

### 运行
```bash
npx tsx src/index.ts                                        # 一键完整流程（交互式输入版本/URL）
npx tsx src/downloadAssetBundleInfo.ts                      # AssetBundleInfo（留空自动检测最新版）
npx tsx src/compare.ts                                      # 对比（交互式输入目标版本）
npx tsx src/getAssets.ts                                    # 按最新 diff 下载差异资源
npx tsx src/downloadChart.ts <bgmNumber>                    # 下载并解包指定歌曲谱面
npx tsx src/suiteMaster.ts --output out/suite_master.json   # SuiteMaster → JSON
```
（package.json scripts：`yarn grp` = index、`yarn dab` = downloadAssetBundleInfo、`yarn com` = compare、`yarn geta` = getAssets、`yarn exp` = export、`yarn rmuf` = removeUnchangedFiles、`yarn mb` = mergeBytes、`yarn da` = decodeAcb、`yarn ff` = flatFolder）

### 一键流程（index.ts）
1. `downloadAB(输入)` 确定本次运行的版本（输入版本号 / 完整 URL / 留空自动检测）→ 下载 AssetBundleInfo
2. `compareVersions(result.version)` 对比「输入版本 vs 其前一个版本」→ `compare/diff_<旧>_to_<新>.json`
3. `downloadDiffAssets(PROJECT_ROOT, outFile)` 按本次 diff 下载 → `analysing/<新版本>/{new,change,change_old}`
4. `exportLatestAssets(undefined, versions.verNew)` 解包 → `assets/<新版本>/`
5. `removeUnchangedFiles` 去重（change_old vs change）→ 合并分段 acb → `decodeAssets(versions.verNew)` 解码 → `flatFolder` 压平
6. 可选 `REMOVE_ANALYSING_FILES=true` 清理 analysing/

**关键约定**：本次运行的版本号（`result.version`，即输入的 dataVersion 或自动检测值）会贯穿第 2~6 步全链路——`compareVersions`、`downloadDiffAssets`、`getDefaultPaths(version)`、`decodeLatestAssets(version)` 全部固定该版本，各环节不得再从磁盘「找最新」。（历史教训：早期版本各环节各自找最新文件夹，导致下载旧版却在解包新版。）

### AssetBundleInfoUrl.json（版本记录）
```
{
  "latest":  { "clientVersion": "10.1.4", "dataVersion": "10.1.0.230", "masterDataVersion": "10.1.0.231" },
  "hashes":  { "10.1.0": "<64位hex>", "10.0.0": "<64位hex>", ... }
}
```
- URL 规律：`https://content.garupa.jp/Release/<dataVersion>_<主版本hash>/Android/AssetBundleInfo`
- `dataVersion`（如 10.1.0.230）是 `/application` 返回的 4 段资源数据版本，是 AssetBundleInfo URL 里的版本段；`clientVersion`（App Store 3 段）与 `masterDataVersion` 仅作记录，不参与 AssetBundleInfo URL
- hash 只随主版本（前三段，如 10.1.0）变化，同一主版本内所有 dataVersion 共享同一 hash
- 自动更新：粘贴完整 URL 时学习该主版本 hash；`downloadAB` 运行时经 `getAppVersions()` 刷新 latest（失败不中断）
- 共享模块 `src/garupa/assetBundleInfo.ts`：`loadStore`（兼容旧扁平格式迁移）/`saveStore`/`buildAssetBundleUrl`/`mainVersion`/`ensureTimestamp`/`extractVersionFromUrl`/`extractHashFromUrl`

### 架构
- `proto/CE.proto` 用 protobufjs 编译为 TS 静态模块（`pbjs -t static-module -w es6` + `pbts`），`yarn gen:proto` 重新生成
- `src/garuba/parser/` 是公共解析器：AES 解密 →（BZip2 解压）→ protobuf 解码
- `src/garuba/api/` 封装各接口的完整下载管线；`src/garuba/version.ts` 提供版本获取
- 解码选项：`longs: String`（int64/uint64 → 字符串）、`enums: Number`、`bytes: String`（base64）、`defaults: false`（省略未设置字段）
- `/application` 响应无 BZip2 压缩、尾部为 ISO 10126 填充（最后一位字节 = 填充长度，其余填充字节随机；`decodeAppGet` 按末尾字节直接裁剪，异常时回退 0..16 逐字节试错）

### 结构说明
- `map` 字段解成真正的映射：`{ entries: { "1": {...}, "2": {...}, ... } }`
- `repeated` 列表是包装消息：`{ entries: [...] }`

### 依赖
- `protobufjs`、`long`、`@types/protobufjs`（运行时），`protobufjs-cli`（devDependency，重新生成用）
- `tsconfig.json` 的 `exclude` 包含 `proto/gen/CE.js`（避免 tsc 对生成文件做声明合成）

### 重新生成编译文件（CE.proto 更新后）
```bash
yarn gen:proto
```

### 数据源
- Game API: `api.garupa.jp/api/suite/master`（AES-128-CBC 加密 + BZip2 压缩）、`api.garupa.jp/api/application`（加密、无压缩）
- CDN: `content.garupa.jp/Release/<dataVersion>_<hash>/Android/`（AssetBundleInfo 与资源文件）
- 配置从 `.env` 读取：`GARUPA_AES_KEY`/`GARUPA_AES_IV`（AES 密钥，必填）、`GARUPA_CLIENT_VERSION_FORCE`（强制指定版本）/`GARUPA_CLIENT_VERSION_DEFAULT`（拉取 App Store 失败时兜底）、`UNITY_VERSION`（解包用）、`REMOVE_OLD_FILES`/`REMOVE_ANALYSING_FILES`
- Schema 来源：从游戏侧导出的 `proto/CE.proto`
