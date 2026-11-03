# 随附的排版字体

## 中文主体

`wqy-microhei.ttc` 是未经修改的文泉驿微米黑 0.2.0-beta 字体集合，包含 WenQuanYi Micro Hei 和 WenQuanYi Micro Hei Mono 常规字体，支持中日韩及拉丁文字。渲染器直接加载本地字体，无需安装系统字体或发起网络字体请求。

字体内嵌许可记录声明 Apache License 2.0，本仓库选择该许可再分发，未选择上游提供的另一种 GPL 许可。分发时应将字体、Apache 许可、作者与上游声明一并保留。字体许可独立于框架的 MIT 许可。

- 字体版权：数字化数据 © 2007 Google Corporation；© 2008–2009 WenQuanYi Board of Trustees 和 Qianqian Fang。贡献者及素材来源见随附作者与上游声明。
- 上游：[文泉驿](http://wenq.org/)；[原始发行包](https://downloads.sourceforge.net/project/wqy/wqy-microhei/0.2.0-beta/wqy-microhei-0.2.0-beta.tar.gz)。
- 原样提取自 Ubuntu `fonts-wqy-microhei` 包 `0.2.0-beta-3.1` 的 `usr/share/fonts/truetype/wqy/wqy-microhei.ttc`。
- [包下载来源](https://mirrors.bfsu.edu.cn/ubuntu-ports/pool/universe/f/fonts-wqy-microhei/fonts-wqy-microhei_0.2.0-beta-3.1_all.deb)。
- 包 SHA-256：`58d0a29af79ce1fc5c63b4276065f0fce27decf6839835f3f9c2e68d9f84ca20`。
- 字体大小：5,177,387 字节。
- 字体 SHA-256：`2420e8078af796b19a3f6ef13de527a1a91c1e7171eea115926c614ced1009b3`。

`LICENSE-WenQuanYi-Micro-Hei.txt` 保留 Apache 2.0 许可原文；`WenQuanYi-Micro-Hei-AUTHORS.txt` 与 `WenQuanYi-Micro-Hei-UPSTREAM.txt` 保留原始作者及上游声明。本仓库不包含 Debian/Ubuntu 的 fontconfig 配置。

## 数学、符号与扩展文字回退

内置渲染器先使用中文主体字体，再依次使用以下未经修改的字体补充缺失字形。正文、表格和代码共用回退；公式仍由数学排版组件生成图形。所有字体从随附文件注册，支持离线渲染。

| 文件 | 字体及用途 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| `NotoSansMath-Regular.ttf` | Noto Sans Math：数学字母、数集、关系、运算符与箭头 | 1,015,396 | `3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d` |
| `NotoSansSymbols2-Regular.ttf` | Noto Sans Symbols 2：勾选、警告及其他通用符号 | 1,233,128 | `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21` |
| `NotoSans-Regular.ttf` | Noto Sans：扩展文字、上标括号与组合符号 | 569,208 | `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5` |

前两款原样取得自 [google/fonts 的固定提交](https://github.com/google/fonts/tree/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl)：分别为 `notosansmath/NotoSansMath-Regular.ttf` 与 `notosanssymbols2/NotoSansSymbols2-Regular.ttf`，各自的 `OFL.txt` 保存为 `LICENSE-Noto-Sans-Math.txt` 和 `LICENSE-Noto-Sans-Symbols2.txt`。版权 © 2022 The Noto Project Authors。

Noto Sans 原样取得自 [notofonts/noto-fonts 的固定提交](https://github.com/notofonts/noto-fonts/tree/ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans)，文件为 `NotoSans-Regular.ttf`，仓库的 `LICENSE` 保存为 `LICENSE-Noto-Sans.txt`。版权 © 2018 The Noto Project Authors。

三款字体均依 SIL Open Font License 1.1 再分发，随附对应完整版权和许可原文；字体许可独立于框架的 MIT 许可。字体替换须同时更新此记录与源码检查中的文件身份。
