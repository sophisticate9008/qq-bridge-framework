# Windows 命令压缩包

Windows 使用预构建 ZIP、控制台启动脚本和浏览器中的现有 WebUI。运行环境为 Node.js 24.12.0 或更新版本（带 npm）、Windows PowerShell 5.1 和本地 NTFS 目录。QQ 协议端和 DSH 由用户独立安装、运行和配置。

从 v1.8.0 开始，GitHub Release 直接提供 Windows ZIP 和 SHA-256。原生 CI 在 Windows Server 2022 x64 验证安装、WebUI、重启和模拟聊天链路；Windows 10／11、Windows ARM64 和真实 QQ／DSH 联调尚未实机验证。

## 安装与启动

1. 从 [v2.0.0 Release](https://github.com/sophisticate9008/qq-bridge-framework/releases/tag/v2.0.0) 下载 `qq-bridge-framework-2.0.0-windows-x64.zip` 与 `SHA256SUMS`。
2. 用 PowerShell `Get-FileHash <压缩包> -Algorithm SHA256` 核对校验文件中的对应项，解压到自己可写的本地 NTFS 文件夹。
3. 双击根目录 `start-windows.cmd`。首次启动联网安装锁定的生产依赖，创建配置，然后启动管理端；后续启动复用依赖与原配置。
4. 保持控制台窗口打开，在浏览器打开日志给出的本机地址（默认 `http://127.0.0.1:3210`），完成首次初始化和 QQ／DSH 连接设置。DSH 使用高级手动地址及鉴权；Linux 的进程自动发现与 screen 运维不适用于 Windows。
5. 按 Ctrl+C 正常退出。再次运行同一脚本会保留配置和会话。升级前退出进程，备份并保留 `data/`、`workspace/`、`private/` 及旧安装的 `runtime/`，将程序文件更新到同一目录。

启动器的 `--install-dependencies` 参数只准备依赖，供 CI 分别验收首次安装与后续启动。也可在解压目录手动运行 `npm ci --omit=dev`、`npm run cli -- init`、`npm start`；已有配置不要重新初始化。无需托盘程序、Windows 服务、开机自启或额外桌面 GUI。启动器不自动登录 QQ，也不代替 DSH。

## 权限与持久化

Windows 通过系统 ACL 按 SID 核验所有者和授权，私有配置与数据只允许当前用户、SYSTEM 与本机管理员访问。源码允许其他主体只读，拒绝共享写权限；链接和文件身份检查继续执行。ACL 验证失败时拒绝使用数据，不以 Windows 模式位替代实际权限检查。内置代码的 ACL 批量读取并按文件身份缓存，文件元数据改变后重新核验。核验复用一个受控的本机 PowerShell 进程，通过进程内工作线程和有界共享缓冲通信；没有网络监听，退出时关闭该进程。

JSON 使用独占锁、写临时文件、文件 flush、版本检查、同目录替换和读回核对。Windows 的 Node.js 不提供 POSIX 目录 fsync 路径，因此不承诺突然断电后的目录项持久性；替换后结果无法确认时保持原有“结果未知”语义，不自动重放。数据库由 SQLite 处理事务与持久化；Windows 数据库父目录须为私有目录，以保护同目录的 WAL／SHM 文件。

## CI

版本标签自动运行发行包安装工作流，在 Linux 构建并验收后，将同一批附件交给 Windows x64 和 Linux ARM64 安装验证；发行附件取自通过验证的 `release-packages`。开发阶段也可运行 `gh workflow run windows.yml --ref main`。工作流在 Linux 的干净提交上构建框架、网页与两个配套组件，生成同源 TAR、Windows ZIP 与 SHA-256；随后由 Windows x64、Linux x64 和真实 Linux ARM64 runner 安装同一候选内容。

Windows 验收实际解压 ZIP，验证原生中文／公式排版、初始化、全套 WebUI 静态资源、首次令牌、启动器启动、正常退出、保留配置重启、缺失资源拒绝，以及 ACL 修改后的缓存失效、权限进程通信与退出、真实本地 WebSocket→DSH 适配器→持久出站→模拟 QQ HTTP 链路。Windows 定向链路使用候选包内的生产依赖与同提交源码执行，随后删除源目录验证实际编译后端；不重复安装测试依赖。测试不使用真实 QQ 登录或商业模型。包保留七天，小型报告保留三天，不上传依赖与运行目录。定位聊天问题时可追加 `-f source_only=true`，只跑 Windows 源码定向诊断，不构建或宣称安装包通过。

首次解压后，可将包含 start-windows.cmd 的程序目录命名为固定的 qq-bridge-framework，再登记启动入口。后续更新覆盖该目录，下载 ZIP 的版本号不要求改变服务路径。已有安装按更新流程操作，不为更新重复初始化。
