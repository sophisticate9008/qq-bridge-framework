# 安装、验证与移除框架扩展

框架扩展由当前框架配套 SDK 编写，安装在管理配置旁的 `extensions/`。源码目录、安装版本、运行状态和实际调用分别核验；无需往 DSH 安装业务代码。已有可信 bootstrap 与新扩展共同装配，安装命令保留原选择。

## 开发与安装

```sh
qbf-cli extensions init private/extensions/my-extension --id my-extension
# 按需求修改 index.ts 与 qbf.extension.json
qbf-cli extensions install private/extensions/my-extension --config data/admin/config.json
qbf-cli extensions verify my-extension --config data/admin/config.json
```

所有命令可用 `node scripts/cli.ts` 代替 `qbf-cli`。省略 `--config` 时使用当前安装的管理配置选择；开发和测试建议明确指定隔离配置。先运行 `qbf-cli init --config <配置>` 创建管理配置。

`init` 生成 SDK 功能包与一个状态工具的模板。使用 SDK 的 `host`、`contracts` 等公开导出；工具通过宿主服务注册，服务使用显式契约声明，订阅和资源随包生命周期回收。SDK 用法见 [扩展开发](EXTENDING.md) 和 [服务规范](SERVICE_CONVENTIONS.md)。常用导出按职责区分：bootstrap、包和服务 helper 从 `sdk/host` 导入，`JsonObject` 等数据契约从 `sdk/contracts` 导入，`EffectScope` 从 `sdk/core` 导入；以当前配套 SDK 的公开声明为准。

`qbf.extension.json` 是显式文件清单：

```json
{"schema":1,"id":"my-extension","version":"1.0.0","displayName":"我的扩展","entry":"index.ts","files":["index.ts","package.json"],"packages":["my-extension"]}
```

`files` 包含入口、本地依赖源码、资源和 `package.json`；已有 `package-lock.json` 时也加入清单。包必须采用 ESM，入口为扩展根目录中的 TypeScript 文件，本地辅助模块可放子目录。文件名区分大小写冲突、路径穿越、链接、凭据、运行数据目录和 Windows 保留名称会被拒绝。最多 128 个文件，入口 256 KiB、其他每个 1 MiB、合计 8 MiB；登记最多 32 个扩展，每个至多 32 个功能包。

安装自动准备当前框架配套 SDK，将外部 npm 依赖安装到候选版本，关闭 npm 生命周期脚本，并执行严格 TypeScript 检查、受限时长的独立进程导入预检及完整源码／依赖锁指纹核对。SDK 无需助手寻找 tgz 或猜测版本。需要原生安装脚本或 Python 环境的扩展，应自行明确准备与核验其运行依赖；npm 检查不代替这部分验收。

候选通过后保存为独立版本并登记。已配置受信 `serviceManager` 的安装会应用：仅重启对应框架宿主，再核对实际登记指纹、包运行、工具注册与服务就绪。框架重启可能短暂中断聊天，应选择合适时机；此流程不重启 DSH 或 QQ 客户端。配置没有管理器或指定 `--stage` 时只登记，输出 `runtimeVerified:false`，启动此配置后核对原操作：

```sh
qbf-cli extensions apply <操作编号> --config <配置>
qbf-cli extensions reconcile <操作编号> --config <配置>
```

`verify` 读取安装内容和真实宿主状态，不导入扩展，不调用模型。`invocationVerified:false` 表示仍需在获准的会话中实际调用：用能力目录找到工具，经 `qbf_capability_call` 验证输入、结果及副作用。服务就绪不代表模型自动获得同名工具；工具仍受当前会话、主人身份与 policy 约束。实际调用验收需另行保留证据。

## 更新、停用与移除

修改原源码目录后再次 `install`，使用完整新快照；源码和配套依赖内容完全一致的重复安装返回 unchanged，保留原操作记录并且不重启框架；直接修改安装版本会导致指纹失败。运行数据写入宿主数据目录或明确的任务工作区，源码版本中不放会变化的配置、缓存或成果。

```sh
qbf-cli extensions list --config <配置>
qbf-cli extensions disable my-extension --config <配置>
qbf-cli extensions enable my-extension --config <配置>
qbf-cli extensions remove my-extension --config <配置>
```

停用保留登记；移除取消登记，应用完成后撤销工具和服务。两者均保留原源码、业务状态和历史版本，避免误删用户数据。版本与历史记录在管理配置旁的 `extensions/`，选择记录是 `<配置文件>.extensions.json`；它们随该框架安装管理，不污染 DSH 目录。

实现热重载和完整装配是不同操作：`extensions reload <标识>` 仍用于主动登记了重载管理器、同一工具协议的实现更新；工具 schema、固定入口、依赖或注册结构变化使用重新安装与完整应用。`list` 的 `reloadableExtensions` 另列已登记的重载实例，读取失败时为 null；受管安装列表、重载目录与实际包清单分别呈现。

## 失败与恢复

依赖、类型或导入预检失败时，原登记与运行版本保留。错误包含标准码；依赖、类型和导入诊断保存在配置旁 `extensions/install-logs/`，按需读取相关文件。

应用前持久保存操作编号与前后选择，每个配置同时只进行一项安装操作，并与整套框架更新、卸载共用维护锁；未决整套维护须先核对。确认候选已经加载但验收失败时，恢复旧选择并只执行一次框架恢复启动；返回 `rolled-back` 和失败码，不能当作新版本安装成功。重启或状态结果未知时，保留原操作并禁止再次安装；用 `reconcile <原编号>` 只读核对已有结果，不自动重复重启或插件写操作。未知结果还须取得加载过原操作编号的宿主证据，旧进程仍在线不能证明重启已结束；未应用的 prepared 选择继续等待 apply 或明确启动。历史终态操作可查询，不会覆盖后续新选择。

扩展是受信本机代码，在宿主权限内执行；导入预检不是恶意代码沙箱。预检不会执行包的安装生命周期，运行时依赖和业务行为仍须真实验收。SDK 自身生命周期和 policy 不会为任意恶意代码提供进程隔离。
