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

请确保已安装好如下两个环境

- **Node.js**
  - 需要勾选额外工具包
  - [Node.js](https://nodejs.org/zh-cn)
- **.NET 9 Runtime required**
  - **Windows**: [.NET Desktop Runtime 9.0](https://dotnet.microsoft.com/download/dotnet/9.0)
  - **Linux / Mac**: [.NET Runtime 9.0](https://dotnet.microsoft.com/download/dotnet/9.0)


```shell
# 安装 yarn
npm i -g yarn

# 克隆仓库
git clone https://github.com/StarFreedomX/garupa-unpacker.git
cd garupa-unpacker

# 接下来可以把.env.example文件复制一份为.env，里面写Unity版本号

# 安装
yarn install
```

### 自动解包脚本
```shell
yarn grp
```

### 解包步骤流程：
```shell
# download AssetBundleInfo
yarn dab
```
```shell
# compare diff
yarn com
```
```shell
# get new & changed assets
yarn geta
```
```shell
# export assets
yarn exp
```
```shell
# remove unchanged files
yarn rmuf
```
```shell
# merge acb bytes files
yarn mb
```
```shell
# decode acb -> hca -> wav
yarn da
```
```shell
# flatFolder
yarn ff
```

## 致谢

本项目由Gemini、ChatGPT、Grok、DeepSeek协作完成
