# 安装教程

本教程对应当前发行包与锁文件。完整框架包包含已构建的后端和 WebUI、中文字体、公开源码、启动入口及 `components/` 中的配套 SDK／DSH 桥接插件。安装后无需本地构建；这些包通过 GitHub Release 提供。

## 1. 准备运行环境

| 组件 | 要求 |
| --- | --- |
| Node.js | 24.12.0 或更新版本，附带 npm；框架使用 Node.js 原生 TypeScript 与 SQLite 能力 |
| Git | 仅源码开发安装需要；使用完整框架包无需 Git |
| QQ 协议端 | 已登录 QQ、提供 OneBot v11 HTTP API 与正向 WebSocket 的独立服务；可接入 NapCat 或 SnowLuma |
| DSH | 独立运行的 DSH web 实例，桥接插件当前匹配 SDK `0.2.1-rc.2`、Cordis `4.0.5` |
| 可选组件 | 视频观察需要 FFmpeg 和 FFprobe；语音转写、生图、搜索等按已安装扩展提供 |

优先在 Linux 上部署；本机 DSH 发现依赖同用户进程及 `/proc`。Windows/macOS 可使用手动高级接入，服务管理器的 screen 运维面向 Linux。普通安装、构建和运行无需 Playwright。

检查本机版本：

```sh
node --version
npm --version
git --version
```

先按各外部项目的安装方式准备协议端及 DSH。DSH 的版本、插件打包、Loader 加载及鉴权见 [DSH 接入](DSH.md)。两项服务需要先能独立正常工作，框架不会代为安装或登录 QQ。

## 2. 下载完整框架包并安装依赖

从 [v1.7.2 Release](https://github.com/sophisticate9008/qq-bridge-framework/releases/tag/v1.7.2) 下载 `qq-bridge-framework-1.7.2.tar.gz` 与 `SHA256SUMS`。在保存下载文件的目录运行：

```sh
sha256sum --ignore-missing --check SHA256SUMS
tar -xzf qq-bridge-framework-1.7.2.tar.gz
cd qq-bridge-framework-1.7.2
npm ci --omit=dev
```

校验命令核对当前目录实际下载的附件。完整包中的 `npm start` 和 `npm run cli` 使用编译后的后端与网页，无需运行构建命令。依赖按照锁文件安装到目标机器；保留平台可选依赖，供图片与排版所需的原生模块使用，不复制其他机器的 `node_modules`。

SDK 供扩展开发；DSH 桥接插件安装到独立 DSH 项目。两者可单独下载，也可直接使用完整包中 `components/` 的同版附件。QQ 协议端、DSH、Node.js 和个人配置由部署机器提供。

开发者也可从源码安装：

```sh
git clone https://github.com/sophisticate9008/qq-bridge-framework.git
cd qq-bridge-framework
npm ci
npm run build
```

源码安装中的 `npm ci` 包含构建工具，`npm run build` 生成后端和网页。

## 3. 初始化并启动框架

```sh
npm run cli -- init
npm start
```

默认管理配置为 `runtime/admin/config.json`。初始化创建私有网关配置与令牌，并拒绝覆盖现有部署；升级时继续使用原配置，不重复执行 `init`。

| 地址 | 用途 |
| --- | --- |
| `http://127.0.0.1:3210` | 框架管理控制台 |
| `127.0.0.1:3131` | 独立出站网关监听端口 |
| `http://127.0.0.1:3000` | 初始化写入的 OneBot 上游示例；需与实际协议端一致 |

网页聊天适配器的 QQ 收发地址需要单独保存。独立出站网关不提供 QQ 登录，也不是接收消息的 WebSocket 地址。

打开控制台完成管理令牌初始化并保存在私有位置。服务器部署可通过 SSH 转发访问默认回环监听，例如在自己的电脑上执行 `ssh -L 3210:127.0.0.1:3210 <服务器用户>@<服务器地址>`，再打开本机控制台。监听和远程访问设置见 [运行手册](OPERATIONS.md)。

## 4. 配置 QQ 收发

在协议端启用 OneBot v11 HTTP 服务和正向 WebSocket 服务，记录它们实际监听的地址与 Access Token。框架主动连接该 WebSocket；这里不需要向协议端填写反向 WebSocket 上报地址。

在控制台“连接设置”分别保存：

- **HTTP 发送连接**：协议端的 HTTP API 地址及对应密钥，例如 `http://127.0.0.1:3000`。
- **WebSocket 接收连接**：协议端的正向 WebSocket 地址及对应密钥，例如 `ws://127.0.0.1:3001`。这只是示例，端口与路径以协议端配置为准。

若使用独立出站 API，同时核对初始化生成的网关配置中的 `upstreamEndpoint` 与实际 HTTP 服务一致；该 API 的授权独立配置。普通聊天按控制台保存的聊天适配器发送。

连接后确认实际机器人账号正确。WebSocket 已连接、QQ 已登录和聊天已启用是不同状态；用“连接与概览”查看各自结果。不要把管理令牌、DSH 凭据与 OneBot 密钥混用。

## 5. 准备 DSH 桥接插件

按照 [DSH 接入的版本与安装](DSH.md#版本与安装)，使用完整框架包 `components/qq-bridge-framework-dsh-bridge-plugin-1.7.2.tgz` 或 Release 单独下载的同版插件，在所管理的 DSH Node 项目中安装，并将插件加载到已有 Cordis Context。仅安装 npm 包不会自动加载插件。

确认独立 DSH web 已启动，并在控制台“连接设置”选择自动连接本机 DSH。本机自动鉴权要求 DSH 与框架由同一系统用户运行，凭据文件归该用户所有且权限为 `0600` 或 `0400`。默认无需手填地址、令牌和凭据路径。远程实例使用高级手动接入。

## 6. 保存模型、人设、访问范围并应用

1. 在“模型服务”登记提供方、接口类型、凭据和实际模型 ID。核对容量、输入模态与推理档位；模型名称本身不能证明这些能力。
2. 在“人设编辑”创建人设，或填入内置“小鲸鱼”模板后修改并保存。
3. 在“聊天方案”创建方案，或填入日常聊天模板，选择已保存的人设与模型。
4. 在“访问与设置”保存真实主人 QQ 账号及允许参与的群聊、私聊白名单。
5. 返回“聊天方案”应用当前方案，核对加载结果并启动聊天。助手是独立可选配置，初次可以只启用聊天。

实际按钮会随保存和运行状态显示“应用”“应用并启动”等文字。应用仅处理当前方案，其他人设、模型和连接草稿需要先保存。现有会话需要加载新提示词时，受控本机管理器可能重启 DSH；已有历史保留。远程或未受管实例按缺失条件手动加载，随后核对原应用。

## 7. 在 QQ 验证首次回复

在白名单会话内 @ 机器人并发送一句简单问题。随后核对 QQ 收到的回复及“会话与日志”里的执行、发送回执。启动检查不调用模型，“配置已通过”不能代替一次实际回复。

没有回复时按 [使用教程的排查步骤](USAGE.md#不回复时检查什么) 处理。确认普通聊天后，再逐项启用媒体、助手或扩展，按各自条件验证。

后台常驻需自行配置进程管理器。仓库提供 `ops/qqbridge-framework`，它依赖你创建的私有服务清单，不会从安装命令自动注册整套系统服务，见 [服务运维](SERVICE_MANAGER.md)。
