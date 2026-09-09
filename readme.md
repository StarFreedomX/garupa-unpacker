# Garupa Unpack Utils

邦多利解包工具

### 关于Unity版本

仅给出安卓路径

位置在`Android/data/jp.co.craftegg.band/files/Unity/很长一串/Analytics/values`

2025年12月01日更新: `2022.3.62f1`

### 关于版本号后的哈希值

最简单的获取办法就是直接抓包，看host为content.garupa.jp的get

根据经验，版本号前三位不变时，哈希值不变

### 初始化

需要 **Node.js 22+**。Unity 解包使用 `node-asset-studio-mod-js`，无需 .NET。
音频沿用 `acb` 和 `hca-decoder`；安装依赖时需要允许 `hca-decoder` 构建本机扩展（需要相应的 C++ / node-gyp 编译环境）。

```shell
# 安装 yarn
npm i -g yarn

# 克隆仓库
git clone https://github.com/StarFreedomX/garupa-unpacker.git
cd garupa-unpacker

# 接下来可以把.env.example文件复制一份为.env，里面写Unity版本号

# 安装
yarn install

# 首次运行或 proto/CE.proto 更新后手动生成；命令会自动创建 proto/gen
yarn gen:proto
```

### 自动解包脚本
```shell
yarn grp
```

### 实时预解包 Server

实时链路拆成两个可独立重启的进程：`server:notify` 负责探测、严格筛选目标和发送，
`server:unpack` 负责把本次更新的全部新增/变化 bundle 解开。变化 bundle 会在内存中与旧包
比较，只把新增/修改文件写盘；索引只用 `new: true/false` 区分新增与修改，不保留 unchanged。
探测进程不会自己解包，
两个进程通过持久状态和逐 bundle 完成索引衔接。

`yarn server:notify` 会同时轮询游戏 `/application` 与 CDN 上的猜测版本。猜测规则为版本末段通常
`+10`，尾数为 `90` 时 `+20`。目标 `AssetBundleInfo` 提前出现后，服务只用清单差异定位下列
目标资源所在的 bundle（不会发送清单里的其他差异）。`yarn server:unpack` 随即并发处理全部
新增/变化 bundle；尚未部署的 bundle 会在之后的轮询中重试，不会挡住已经完成的 bundle。
探测进程看到某个 bundle 的完成索引后立即发送其中的目标文件，不等待整次全解结束。

```shell
cp .env.example .env
# 至少填写 GARUPA_AES_KEY / GARUPA_AES_IV / ONEBOT_API_BASE_URL / ONEBOT_GROUP_IDS
# 生产运行：一个命令同时启动探测/发送进程与全量解包进程
yarn server
curl http://127.0.0.1:3210/health
```

如需分别调试两个进程，也可以在两个终端单独运行 `yarn server:notify` 和
`yarn server:unpack`。`yarn server` 收到 Ctrl+C 时会一并停止两个子进程；其中任一进程异常退出时，
另一进程也会被停止，便于由外部进程管理器整体拉起。

OneBot 配置完全来自环境变量。图片使用 `send_group_msg` 的 base64 消息段；语音表情和普通文件
使用 `upload_group_file`，便于群内转发。未配置公开文件 URL 时以 `base64://` 跨进程传输。如果文件较大，
可设置 `ONEBOT_FILE_BASE_URL`，把 `UNPACK_SERVER_OUTPUT_DIR` 映射成 NapCat 可访问的 HTTP 目录，
让 NapCat 直接从 URL 拉取，避免 base64 的额外内存开销。
设置 `ONEBOT_MERGE_BUNDLE_IMAGES=true` 后，同一 bundle 解包批次中的多张图片会合并成一条
OneBot 消息；音频和普通文件仍单独发送。不开启时每张图片单独发送。本地联调可设置
`UNPACK_SERVER_DRY_RUN=true`，此时不会发送外部消息。
历史版本回放可在隔离的输出和状态上设置 `UNPACK_SERVER_HISTORICAL_REPLAY=true`，使用较新
SuiteMaster 时仍会按清单差异中的卡牌 resource set 和事先建立的歌曲 ID 基线过滤，不会把后续内容混入目标版本。

服务处理并实时发送：新卡面、当期卡牌角色及颜色、新增表情和语音表情（聚合包按新旧最终文件
比较，修改项不会发送）、活动介绍图、新曲完整 jacket/完整音频（缩略图、chorus 试听和原始谱面不发送）、`thumb/degree` 中新增且
文件名为 `degree_event*` 的当期活动牌子。官方
`application` 更新后，服务再访问 SuiteMaster，发送新曲文字信息并直接用已解包的缩略图
生成 `view/overview.png` 三围技能图；这一阶段不会调用 quick/view CLI，也不会重复解包。

输出位于 `assets/server/<dataVersion>/`，发送去重和失败状态持久化在
`out/unpack-server-state.json`。进程重启后只补失败项。健康接口提供当前 application 版本、
猜测版本、各周期完成数与最近错误。

### 常见资源路径

* 卡牌颜色: `assets\9.4.0.120\assets\star\forassetbundle\asneeded\genericanimation\dream_festival_2512\name_text.png`
* 新曲: `assets\9.4.0.120\assets\star\forassetbundle\asneeded\sound\ingamebgm`
* 表情: `assets\9.4.0.120\assets\star\forassetbundle\startapp\stamp`
* 语音表情: `assets\9.4.0.120\assets\star\forassetbundle\startapp\sound\voice`
* 活动介绍: `assets\9.4.0.120\assets\star\forassetbundle\asneeded\event\challengeevent\new_year_2026\slide`

### 内存流水线

`yarn grp` 依次下载新旧 AssetBundleInfo、生成差异清单，再按 bundle 并发执行：

1. 下载一个 bundle 到 Buffer，立即用 `readAssets` 解包；其他 bundle 可以继续下载。
2. 在内存中合并同一 bundle 的 ACB / AWB 分片，直接将 ACB 音轨 Buffer 交给 HCA 解码器，得到 WAV Buffer。
3. 对变化 bundle 的新旧版本按最终文件相对路径和字节内容比较，只写新增或变化的文件；音频比较最终 WAV，完整分片会在比较前保留。
4. 将最终文件直接写到 `assets/<新版本>/`，保留资源原有目录结构，不区分 `new` / `change` 输出目录，也不压平路径。全部成功后更新 `nowDataVersion`。

JS 引擎 0.1.2 起，Shader 正常导出为内存中的 `.shader` 文本，参与最终文件比较；这是供检查的 ShaderLab 文本，不保证能作为原始源码重新编译。仍不支持转换的 Texture2DArray、MovieTexture、Animator 会以 `.bin` 保留原始序列化字节（不附带外部资源流）；解析错误仍会报错。

同一 bundle 中的同名 Unity 对象保留 ` @PathID` 后缀，避免覆盖；其余资源恢复普通文件名，以兼容图片筛选和 ACB 分片合并。

不再生成 `analysing/`、`change_old/` 或中间 ACB/HCA 文件。版本清单和 diff JSON 仍保留，编排直接传递内存中的 diff。每个 bundle 完成后直接写入结果目录，可立即读取；部分资源下载或解包失败不删除已写出的文件，也不清空已有结果目录，`nowDataVersion` 仅在全部成功后更新。重跑仍会重新下载处理整批差异包，覆盖本次产出的同路径文件并补齐资源，其余已有文件保留。同一轮中多个 bundle 输出相同路径时，内容相同只写一次，内容不同则报重名错误。

这里的“边下载边解包”以 **bundle 为单位**：当前接口需要完整 bundle Buffer，不能在同一个 bundle 只下载了一部分时解析。每个任务完成后释放数据，不缓存整批下载结果。变化包的新旧版本同时下载、分别解包，完成后在内存比较。默认最多 4 个 bundle / 版本对在途（变化包最多 8 份数据），快捷流程可用 `QUICK_UNPACK_CONCURRENCY` 单独覆盖这个上限。

`yarn quick` 同样在内存解包、解码并筛选，只写 `assets/<版本>-preview/` 的所选资源和 JSON。谱面下载也直接输出最终文件：

```shell
npx tsx src/downloadChart.ts 106
```

HCA 音轨输出 WAV；其他 ACB 编码保留原扩展名。Unity AudioClip 的转换能力由 JS 引擎决定，`audioFormat: wav` 不会强制将 OGG/MP3 转为 WAV。ACB 引用的外部 AWB 需与其位于同一 bundle 的对应输出目录。

### 代理与并行下载

在项目 `.env` 配置（也可使用同名环境变量覆盖）：

```dotenv
GARUPA_PROXY_URL="" # 自动读取环境变量或 macOS 系统代理
DOWNLOAD_CONCURRENCY=8
DOWNLOAD_THREADS=4
DOWNLOAD_CHUNK_SIZE_MB=4
UNPACK_CONCURRENCY=4
ASSET_PIPELINE_CONCURRENCY=4
```

代理支持 `http://`、`https://`、`socks5://` 和 `socks5h://` 等协议，以及 URL 用户名/密码。地址留空时先读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（含小写形式），没有适用代理时再检测 macOS 系统代理；自动选择遵守 `NO_PROXY`。显式 `GARUPA_PROXY_URL` 覆盖这些变量及 `NO_PROXY`，设置为 `direct` 则强制直连。资源包、版本清单、游戏 API、App Store 查询和预览图片下载均使用此配置。

macOS 自动检测读取 `scutil --proxy`，支持 HTTP、HTTPS、SOCKS、显式 PAC 地址以及系统绕过列表（含内网 CIDR、通配域名和本地主机）。配置缓存 30 秒后刷新，不会扫描本机端口或修改系统设置。其他操作系统目前使用显式地址或环境变量；未配置代理时直连。

`DOWNLOAD_CONCURRENCY` 限制全局同时进行的 HTTP 请求（1–64），`DOWNLOAD_THREADS` 限制单包连接数（1–16）。默认先请求 4 MiB 分段，再并行下载剩余分段并在内存中按偏移组装；会验证范围、长度和 ETag / Last-Modified，服务器不支持分段或资源发生变化时回退为整包下载。设置 `DOWNLOAD_THREADS=1` 关闭分段，多文件仍可并行下载。

`UNPACK_CONCURRENCY` 单独限制解包和音频解码任务（1–32）。`ASSET_PIPELINE_CONCURRENCY` 控制等待下载/解包/比较的数据量（1–32）；内存紧张时同时降低这两个值。网络并行使用多个异步连接，解包使用 JS 引擎的独立 Worker。

### 分步运行与旧文件兼容

```shell
yarn dab   # 下载版本清单
yarn com   # 比较清单并保存 diff
yarn geta  # 下载 + 内存解包 + 去重 + 音频解码，直接输出最终文件
yarn ff    # 可选：手动压平输出目录，完整流程不自动调用
```

`yarn exp` 仅用于已有的 `analysing/<版本>/{new,change,change_old}` 本地 bundle，也会在内存中比较、解码后直接输出到 `assets/<版本>/`，失败保留成功结果。`yarn rmuf`、`yarn mb`、`yarn da` 继续保留用于旧磁盘产物；新流程不需要再次运行这些步骤。原来的 `REMOVE_OLD_FILES` / `REMOVE_ANALYSING_FILES` 开关不再用于新流程。

### 耗时统计

每个版本的 bundle 都会记录下载秒数、下载大小、解包与资源转换秒数、内存后处理秒数和资源数量。`downloadDiffAssets` 返回的 `timings` 还包含每个任务的启动延迟、内存比较、最终写出及总耗时。并发任务的耗时会重叠，不能直接求和当作整轮墙钟时间；下载计时包含请求排队、网络重试及退避等待；`unpackQueueMs` 单独记录等待解包槽位的时间。

### 验证

```shell
yarn typecheck
yarn test
# 可选：额外验证真实 res014089 卡面 bundle（不随仓库提交）
ASSET_STUDIO_TEST_INPUT=/path/to/res014089 yarn test
```

## 致谢

本项目由Gemini、ChatGPT、Grok、DeepSeek协作完成
