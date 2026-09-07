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

# 首次运行或 proto/CE.proto 更新后生成协议代码
yarn gen:proto
```

### 自动解包脚本
```shell
yarn grp
```

### 常见资源路径

* 卡牌颜色: `assets\9.4.0.120\new.assets.star.forassetbundle.asneeded.genericanimation\dream_festival_2512\name_text.png`
* 新曲: `assets\9.4.0.120\new.assets.star.forassetbundle.asneeded\sound\ingamebgm`
* 表情: `assets\9.4.0.120\change.assets.star.forassetbundle\startapp\stamp`
* 语音表情: `assets\9.4.0.120\change.assets.star.forassetbundle\startapp\sound.voice`
* 活动介绍: `assets\9.4.0.120\new.assets.star.forassetbundle.asneeded\event\challengeevent.new_year_2026\slide`

### 内存流水线

`yarn grp` 依次下载新旧 AssetBundleInfo、生成差异清单，再按 bundle 并发执行：

1. 下载一个 bundle 到 Buffer，立即用 `readAssets` 解包；其他 bundle 可以继续下载。
2. 在内存中合并同一 bundle 的 ACB / AWB 分片，直接将 ACB 音轨 Buffer 交给 HCA 解码器，得到 WAV Buffer。
3. 对变化 bundle 的新旧版本按最终文件相对路径和字节内容比较，只写新增或变化的文件；音频比较最终 WAV，完整分片会在比较前保留。
4. 写到 `assets/<新版本>/{new,change}/`，一键流程再压平分类下的目录。全部成功后更新 `nowDataVersion`。

JS 引擎不支持转换的 Shader 等对象会以 `.bin` 保留原始序列化字节（不附带外部资源流），不会导致整个包的图片等资源导出失败；解析错误仍会报错。

同一 bundle 中的同名 Unity 对象保留 ` @PathID` 后缀，避免覆盖；其余资源恢复普通文件名，以兼容图片筛选和 ACB 分片合并。

不再生成 `analysing/`、`change_old/` 或中间 ACB/HCA 文件。版本清单和 diff JSON 仍保留，编排直接传递内存中的 diff。最终文件先写入同级临时输出目录，所有任务成功后替换目标版本目录；失败保留上次成功输出及版本记录，重跑会重新下载处理。

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
yarn ff    # 可选：压平输出目录
```

`yarn exp` 仅用于已有的 `analysing/<版本>/{new,change,change_old}` 本地 bundle，也会在内存中比较、解码后输出。`yarn rmuf`、`yarn mb`、`yarn da` 继续保留用于旧磁盘产物；新流程不需要再次运行这些步骤。原来的 `REMOVE_OLD_FILES` / `REMOVE_ANALYSING_FILES` 开关不再用于新流程。

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
