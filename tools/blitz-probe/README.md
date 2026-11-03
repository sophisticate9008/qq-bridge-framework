# HTML 渲染编译调研

独立开发探针，不注册框架能力、不替换现有 Markdown 排版，也不修改运行服务。

`HTML 渲染组件编译调研` Actions 在 Linux x64、Linux ARM64 和 Windows x64 原生 runner 上编译固定提交的 CPU 渲染组件，并运行公开的中文彩色布局和超过 4000 像素的长文档。只保存三天保留的 Actions artifact，不创建标签或 Release。

源仓库只保存封装与构建脚本；上游源码放在忽略的 `.cache/blitz-source`，编译结果、样图与报告放在忽略的 `runtime/blitz-probe`。不上传编译缓存、依赖目录、会话或本机配置。

产物报告分别列出优化后可执行文件字节数、中文字体字节数、包含字体的压缩包字节数和实际渲染耗时。压缩包包括用于本轮测量的中文字体，因此其大小与渲染器单体不同；正式集成可以复用框架已有字体。

入口只接受显式指定的本地 HTML、输出文件、宽度与字体，不启用页面脚本、网络资源提供器或桌面窗口。高度按内容增长，沿用 16777216 像素和 8 MiB PNG 的资源上限。进程隔离、宿主超时、持久队列接入、完整许可证清单及任意输入防护仍属于正式集成工作，本探针不作为生产渲染接口。

上游 [Blitz](https://github.com/DioxusLabs/blitz) 使用 MIT OR Apache-2.0 许可，本封装参考其 `examples/screenshot.rs` 的解析、CPU 绘制与 PNG 输出流程。具体提交由工作流固定，依赖使用该提交的 Cargo.lock 并保留构建后的锁文件供核对；正式分发前需整理全部传递依赖许可。

## 原生 CI 实测（2026-11-03）

实验提交 `5436cd2a23e0b111d218519060a6c5e972600d10` 的 [三平台编译运行](https://github.com/sophisticate9008/qq-bridge-framework/actions/runs/41653757424) 与 [框架检查](https://github.com/sophisticate9008/qq-bridge-framework/actions/runs/41653757886) 全部成功。远端仅推送独立实验分支，未修改主分支、版本号或 Release。

上游固定为 `16ebc29363826d43917d2e3cb91d37f7d2156fdd`。采用 `production` 优化配置：`opt-level=3`、LTO、单代码生成单元、去除调试符号。Windows 额外静态链接 C 运行库。

| 原生环境 | 可执行文件 | 含中文字体的 tar.gz | 彩色图耗时 | 长图耗时 |
| --- | ---: | ---: | ---: | ---: |
| Ubuntu 24.04 x64 | 16.25 MiB | 9.97 MiB | 94 ms | 157 ms |
| Ubuntu 24.04 ARM64 | 14.51 MiB | 9.42 MiB | 85 ms | 193 ms |
| Windows Server 2022 x64 | 17.04 MiB | 9.98 MiB | 1558 ms | 229 ms |

上述时间各取一个独立进程样例，受宿主调度、文件扫描和冷启动影响，不用于跨平台性能排名。中文字体文件为 5177387 字节，正式框架可复用已有字体，避免重复打包。

三平台使用相同的构建后 Cargo.lock，SHA-256 为 `c9b7821799d48ebf74e2f35c8f5b2cd73d56c52a485f464cbd4ab5c3a04b8869`。彩色样图均为 1080 × 808、68122 字节；长图均为 1080 × 9841、981909 字节；同一样图在三个平台的文件 SHA-256 一致。这只说明所测版式一致，不代表任意 HTML/CSS 的完整兼容性。

Linux `ldd` 仅列出系统加载器、libc、libm 和 libgcc_s，不需要桌面窗口或 GPU 库；ARM64 产物观测到最高 GLIBC 版本符号为 2.35，本机 glibc 2.39 可直接运行，未验收更旧系统。Windows `dumpbin /dependents` 只列出系统 DLL，不依赖额外的 VC 运行库 DLL。报告、可执行文件压缩包、样图、构建日志和动态依赖清单在对应 Actions artifact 中保存三天。

## 本机补充验证（2026-11-03）

从首轮原生 ARM64 CI 下载的程序在本机 Linux ARM64、glibc 2.39 上脱离构建目录直接运行，中文彩色样图、表格、Grid、多色代码和静态 SVG 可显示。`pre` 的默认等宽族不会自动映射到手动注册的字体；样例已显式设置 `WenQuanYi Micro Hei Mono`，正式封装需要配置完整的通用字体回退。

38 段长文档输出为一张 1080 × 9841 PNG（981909 字节），人工查看末尾第 38 段与结束标记确认未裁切。一次独立进程测量耗时 432 ms、峰值 RSS 67020 KiB，属于该样例的观测值，不代表任意 HTML 的性能上限。

复用框架当前 MathJax 本地实现生成三条公式 SVG，导数极限、定积分、高阶导数以及紫色公式均可显示，输出为 1080 × 531 PNG。该验证说明静态 SVG 公式路径可行，不代表直接支持 MathML 或页面中的 JavaScript 排版脚本。

65537 字节 HTML、超过 16777216 像素的文档及宽度为 0 的请求均以非零状态明确退出，未写出 PNG。当前探针的 64 KiB 限制作用于最终 HTML；正式接入时须区分原始正文与公式展开后的内部 HTML，避免把内部膨胀变成公式数量限制。

后续适合接入宿主的持久后台排版队列，以独立进程执行并复用现有字体、资源登记和发送策略。仍需完善进程取消与内存预算、崩溃恢复、字体回退、受控图片资源和完整许可证清单；现有 Markdown 路径保持现状。

## Markdown 同文档对比（2026-11-03）

当前决定保留两套方案：已启用的 Markdown 继续使用 Takumi，Blitz 保留预编译组件与构建、验证入口，后续用于 HTML 排版接入。没有切换本机聊天排版后端，也没有将探针表述为已启用的框架能力。

Takumi 本身也是 Rust 核心，本项目使用 `@takumi-rs/core` 的预编译 Node 原生绑定，通过 npm 安装匹配平台的包，用户不需要自行编译。本机 Linux ARM64 上三个 `@takumi-rs` 包安装后合计约 7.15 MiB，其中原生组件约 6.71 MiB、Node 绑定及 HTML 辅助库合计约 0.44 MiB；不含共用字体、MathJax 等。Blitz 当前 ARM64 可执行文件为 14.51 MiB。两者均为安装后体积，不能拿它们与压缩包体积直接比较。

`compare-markdown.ts` 从当前 Markdown worker 的实际源码提取文档准备函数到忽略的 `runtime/research/markdown-render-comparison`，复用既有解析、转义、任务列表、高亮和数学排版规则，避免另维护一套解析器。探针将内部公式图像替换为等尺寸的静态内联 SVG，再向两个引擎提供同一份 HTML/CSS 与四份框架字体。遇到 worker 源码结构变化时明确失败，不修改运行时源码。

运行方式：

```sh
node tools/blitz-probe/compare-markdown.ts /path/to/qbf-html-probe /path/to/blitz/packages/blitz-dom/assets/moz-bullet-font.otf
```

第二个参数提供 Blitz 自带的圆点字体。默认文档上下文本会登记它，而本探针手动提供 FontContext，因此需要显式补齐；补充后列表圆点正常显示。该字体属于上游资源，不复制进项目源码仓库。

下表取本机最后一轮每类三次独立进程的中位数，交替执行两个后端。文档准备在计时外，两者均限制为 1080 像素宽、16777216 像素与 8 MiB PNG。

| 内容 | Takumi 子进程总耗时 | Blitz 子进程总耗时 | Takumi 采样 RSS | Blitz 采样 RSS |
| --- | ---: | ---: | ---: | ---: |
| 中文、代码、表格与公式混排 | 507 ms | 114 ms | 84.9 MiB | 27.0 MiB |
| 约 8880 像素长文档 | 537 ms | 431 ms | 125.5 MiB | 63.8 MiB |
| 22 行四列表格 | 479 ms | 208 ms | 90.6 MiB | 35.8 MiB |

RSS 以 5 ms 间隔采样 Linux `/proc` 的子进程 HWM，仅为下界；不包含两者共用的 Markdown/MathJax 准备进程，也不代表整个框架内存。Takumi 栏包含新 Node 进程与原生绑定加载，Blitz 栏是原生 CLI，进程启动成本不同；单看内部长图排版绘制，Takumi 中位 324 ms、Blitz 402 ms，不能据此宣称 Blitz 全面更快。之前轮次存在明显宿主负载波动，结果只用于该环境的接入评估。

人工查看确认中文、高亮代码、普通公式、数学符号与长文档末尾均可显示；字体粗细、斜体、列表样式与间距仍有差异，正式切换前需要继续适配。Blitz PNG 在所测样例中也更大，例如长文档约 1.10 MiB，Takumi 约 0.32 MiB；该结果同时受两者编码配置影响。

60 条短公式由 818 字节 Markdown 展开为 158833 字节 HTML。Takumi 可生成完整图片，当前 Blitz CLI 因自身 64 KiB 最终 HTML 上限明确拒绝；这不是公式数量限制或 Blitz 引擎不支持。正式接入必须区分原始输入和公式展开后的内部资源预算。另通过实际 `createBuiltinMarkdownRenderer()` 入口核对混排与 60 条公式，均生成一张完整 PNG；没有使用真实 QQ 会话或模型请求。
