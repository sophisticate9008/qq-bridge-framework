# 内置 HTML 图片排版

`qbf_render_html` 将静态 HTML/CSS 排版为一张 PNG，后台发送到当前 QQ 会话。模型可在完成查询后直接调用此工具，无需启动助手或浏览器。Markdown 图片继续使用原有排版后端。

```json
{
  "html": "<h1 style=\"color:#7134c4\">本周安排</h1><div style=\"display:grid;grid-template-columns:1fr 1fr;gap:20px\"><section style=\"padding:24px;background:#e6f5ef;border-radius:16px\">周一：整理资料</section><section style=\"padding:24px;background:#e8eaff;border-radius:16px\">周二：完成初稿</section></div>",
  "title": "可选标题"
}
```

`html` 接受正文片段或完整 HTML 文档，最多 32000 个 UTF-16 码元且不超过 64 KiB；`title` 可选，最多 120 个码元，作为正文标题显示。目标会话、账号和资源目录由宿主绑定，工具不接受目标 QQ 号、输出路径、网址截图或任意进程参数。

支持中文、彩色文字与背景、圆角、表格、Flex/Grid、代码样式和静态 SVG 路径。通过 `<style>` 或 `style` 设置版式，字体由框架随附。渲染的是静态布局，不执行脚本、不获取网络或本机文件资源；外部 CSS、图片、字体、SVG 图片引用和依赖脚本生成的图表不在此入口加载。SVG 文字使用可用的静态图形能力，复杂公式适合先转为 SVG 路径，或使用已有 Markdown 公式排版。

默认宽 1080 像素，高度按完整文档布局增长，不按固定页高拆分。整图最多 16777216 像素、PNG 最多 8 MiB，单次渲染最长 12 秒，同一服务最多两项并发。像素、输出大小与超时分别报告，不静默裁掉超限内容。用户 HTML 中显式设置的尺寸、裁切或隐藏样式仍按其布局生效。

## 后台与发送

工具返回 `queued` 只表示持久队列已受理，DSH 随即结束本轮；图片稍后通过既有权限、资源登记和 outbox 发送。后续聊天或原模型轮次超时不取消已受理文档。HTML 与 Markdown 共用最多 32 项的待处理队列，排队任务不设自动过期时间；队列满时明确拒绝新任务。

发送前重新核验原账号、会话绑定版本和当前白名单。纯渲染中断可在恢复服务后重做；发送结果未知或发送中进程退出时不自动重发。权限撤销、会话主动换绑与重置阻止旧任务发送。最近活动区分 HTML 排队、实际发送确认和失败，保留具体错误码；排版任务失败不会关闭聊天。

`qbf_reply` 也可显式提交同一后台格式：

```json
{"content":{"schema":"qbf.output/1","format":"html-image","body":"<h1 style=\"color:purple\">静态 HTML</h1>"}}
```

## 安装与诊断

完整发行包包含 Linux x64、Linux ARM64 和 Windows x64 原生组件与许可资料，用户无需安装 Rust。框架构建时把原生组件复制到 `dist/assets/native/html-renderer`；源码仓库仅保存封装和构建脚本，二进制放在发行包中。

- `NATIVE_HTML_COMPONENT_MISSING`：缺少本平台组件，重新安装完整框架包。
- `NATIVE_HTML_COMPONENT_INVALID`：组件版本或校验不符，重新安装完整包，不替换为来源不明的可执行文件。
- `NATIVE_HTML_TIMEOUT`：本次布局超过时间预算，简化内容后重新提交。
- `NATIVE_HTML_PIXEL_LIMIT` / `NATIVE_HTML_OUTPUT_LIMIT`：缩小文档实际尺寸或内容，原任务不会自动切图。
- `NATIVE_HTML_RENDER_FAILED`：检查 HTML/CSS 及文档布局；原失败任务与原因保留。

开发构建使用 `HTML 原生渲染组件` Actions，在原生 runner 编译并保存各平台附件。将下载的附件放入一个目录后，运行 `node scripts/install-html-renderer.ts /附件目录 --all` 安装到忽略的本机原生资源目录，再构建框架。正式发行流程自动完成这些步骤，并核对原生组件与当前源码的组件指纹一致。组件保留原始构建提交，框架升级时允许复用经过验证的同指纹组件。完整复建流程见 [原生组件构建与复用](HTML_BUILD.md)。

来源与许可见 [NOTICE.md](../NOTICE.md)。后台恢复语义与 Markdown 共用，见 [图片排版](MARKDOWN.md)。
