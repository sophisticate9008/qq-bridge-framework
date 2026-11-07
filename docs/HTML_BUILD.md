# HTML 原生组件构建与复用

完整安装包已经内嵌组件，运行者无需安装 Rust。本文用于从公开仓库恢复组件、开发安装及维护发行流程，不依赖本机缓存、私人配置或其他会话记录。

## 固定构建输入

- 上游为 `DioxusLabs/blitz`，提交固定在 `tools/html-renderer/config.json`，当前为 `16ebc29363826d43917d2e3cb91d37f7d2156fdd`。
- Rust 固定为 `1.92.0`；Node.js 构建环境为 `24.12.0`；Cargo 使用仓库中的 `tools/html-renderer/Cargo.lock` 和 `--locked`，不自动升级依赖。
- 原生入口：`tools/html-renderer/main.rs`。准备步骤缩减桌面依赖，并禁止 SVG 内嵌图片读取网络、本机文件或 data URL；不要省略准备脚本。
- Release profile 为 `production`，启用上游优化、LTO 和 strip；Windows 使用静态 CRT。配置及参数同步维护于 `config.json` 和 `html-renderer.yml`。
- 原生平台：Ubuntu 24.04 x64、Ubuntu 24.04 ARM64、Windows Server 2022 x64。每个平台在真实同架构 runner 编译及运行，不用交叉编译替代安装验收。

`node tools/html-renderer/fingerprint.ts` 计算组件指纹，包含入口、准备、打包脚本、Cargo.lock、固定构建配置及共用准备逻辑。框架版本、其他源码和发布提交不属于组件指纹；组件的 `sourceCommit` 保留最初构建来源。修改上游、Rust、参数或任何指纹输入后才产生新组件。

## 从干净仓库恢复

先安装 Git、GitHub CLI 和 Node.js，并完成 GitHub 登录：

```sh
git clone https://github.com/sophisticate9008/qq-bridge-framework.git
cd qq-bridge-framework
gh api user --jq .login
gh workflow run html-renderer.yml --ref main
gh run list --workflow html-renderer.yml --limit 5
```

取得对应运行 ID 后检查三个平台均成功，再下载：

```sh
gh run view RUN_ID
gh run download RUN_ID --pattern 'html-renderer-*' --dir private/maintenance/html-renderer-components
node scripts/install-html-renderer.ts private/maintenance/html-renderer-components --all
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

组件安装在 Git 忽略的 `assets/native/html-renderer/<平台>/`，编译后复制到 `dist/assets/native/html-renderer/<平台>/`。不要提交生成的二进制、依赖目录或运行数据。

本机部署编译快照时使用 `dist/scripts/gateway-admin.js` 等编译入口，并保留整个 `dist/assets/`。源码入口从源码树的 `assets/` 查找组件，编译入口从 `dist/assets/` 查找；只复制 Git 跟踪文件及 `dist/` 后运行源码入口，会遗漏未跟踪的原生组件。部署前用实际入口所在树的渲染模块完成 HTML 与 Markdown 排版核验，检查 PNG 内容；源码目录中单独渲染成功不能证明运行快照已具备组件。

工作流先查精确指纹的 Actions 缓存，再查正式 Release 中同名独立组件附件，最后才从源码编译。复用也会在原生 runner 核验二进制 SHA-256，并实际验证系统字体缺失时的中文回退、长图和 SVG 文件资源隔离。缓存或七天保留的 Actions artifact 丢失不影响从正式 Release 取回组件。

需要刻意重建时：

```sh
gh workflow run html-renderer.yml --ref main -f force_rebuild=true
```

## 从 Release 附件恢复

正式附件名称为 `qbf-html-renderer-<完整组件指纹>-<平台>.tgz`，并列入该 Release 的 `SHA256SUMS`。在 Release 页面选择对应文件，或使用 `gh release download` 下载三个平台的文件及校验表。先按校验表核对下载文件，分别解压到 `private/maintenance/html-renderer-components/<平台>/`，再执行上述安装脚本。平台名为 `linux-x64`、`linux-arm64`、`win32-x64`。

每个归档含二进制、`component.json`、固定 `Cargo.lock`、`licenses/` 和 `verification.json`。安装器核对组件指纹、平台、协议和二进制校验值；错误或混用其他源码版本时拒绝安装。普通用户下载完整框架包即可，无需单独处理组件。

## 本机手动编译（开发者）

准备 Rust 1.92.0；Linux 另需 `build-essential pkg-config python3 libclang-dev`，Windows 需 MSVC C++ Build Tools 和 Git Bash。在上述干净仓库中执行：

```sh
git clone https://github.com/DioxusLabs/blitz.git .cache/blitz-source
git -C .cache/blitz-source checkout 16ebc29363826d43917d2e3cb91d37f7d2156fdd
rustup toolchain install 1.92.0 --profile minimal
rustup override set 1.92.0
node tools/html-renderer/prepare.ts
cargo build --locked --manifest-path .cache/blitz-source/Cargo.toml --profile production --example qbf-html-probe
```

Windows Git Bash 在 Cargo 命令前设置 `export RUSTFLAGS='-C target-feature=+crt-static'`；Linux 不设置此项。打包步骤需要设置 `BLITZ_REV` 为上述上游提交、`GITHUB_SHA` 为框架实际完整提交 SHA，然后运行：

```sh
node tools/html-renderer/package.ts
node tools/html-renderer/smoke.ts
node scripts/install-html-renderer.ts private/maintenance/html-renderer
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

只安装本平台时不带 `--all`；正式发行必须有全部三个平台，使用 GitHub 托管流程。准备脚本修改固定上游工作树，重复准备前应重新检出一份干净的上游副本。

## 正式发行

`release.yml` 和 `windows.yml` 调用同一可复用组件工作流；新框架提交可以复用旧提交产出的同指纹组件。完整包打包器再次核对三个平台组件指纹及校验值，拒绝缺失或错配。发行附件包含完整框架 TAR、Windows ZIP、SDK、DSH 插件、三个独立原生组件和统一 SHA-256。

每次发布仍需等待该完整框架提交的全部 CI 和三平台安装验收成功。组件复用只节省 Rust 编译，不能跳过新框架的验证；发布顺序见 [版本规则](VERSIONING.md)。

附件上传速度受本机网络限制时，可调用 `upload-release.yml`，直接把已通过标签验收的 `release-packages` 上传到同版本的现有草稿。输入 `tag`、完整 `source_commit` 和标签验收的 `artifact_run`；工作流再次核验该提交全部必要 CI、标签、归档来源及 SHA-256。它复用现成附件，不构建、不修改标签、不创建或公开 Release。已发布版本不接受覆盖。

```sh
gh workflow run upload-release.yml --ref main -f tag=v1.10.0 -f source_commit=完整提交SHA -f artifact_run=标签验收运行ID
```
