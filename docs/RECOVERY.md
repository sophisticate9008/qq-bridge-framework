# 未决操作与恢复

恢复从原操作的持久证据开始。请求被接受、网页收到了响应、进程已退出和外部动作已结束是不同事实。`unknown` 表示已有动作的结果没有得到充分确认；它不会因为刷新页面、重新安装包或换一个 operationId 自动变成安全完成。

本文中的管理路径作用于当前账号。多账号应通过下文的 dispatch 使用同一账号的 API 身份；不要把根目录旧入口的返回值当成选中账号的状态。

## 连接中断与聊天恢复

支持配套事件接口时，桥保存每个消费者完成处理的位置，重连补读断线期间的执行观察，再接收新输入。该补读不重做模型请求或工具，也不重新发送旧正文。协议、超限与游标冲突具有明确原因，修复后可重新连接；网络中断继续自动退避恢复。旧插件保持最小历史页监听，缺少持久衔接能力不会被显示为已有能力。

“连接设置”的聊天运行卡片分别列出框架处理、QQ 接收、HTTP 发送、DSH 鉴权、回复监听、工具通道和模型提问通道。前两张卡片的已保存或启用状态不代替这些实际检查；待命表示当前没有活动监听，不表示连接失败。

| 异常环节 | 核对与恢复 |
| --- | --- |
| QQ 接收 | 核对协议端登录、WebSocket 服务、地址与密钥。临时断线自动重连，也可使用连接维护；框架不启动协议端 |
| HTTP 发送 | 核对实际发送地址、HTTP 专用密钥与同一 QQ 账号。使用框架网关时另查网关状态；未知送达的消息不补发 |
| DSH 鉴权 | 本机受管 DSH 使用“一键恢复聊天”；远程 DSH 在部署端核对服务、网络与凭据 |
| 回复监听 | 说明连接关闭、心跳超时或事件校验异常等实际原因；框架按有界退避重新订阅，保留原会话，不重发旧请求 |
| 工具通道 | 网络错误只重连只读轮询，保留原票据去重；持续异常可使用“一键恢复聊天”，未知工具结果保留 |
| 模型提问 | 模型提问连接独立于普通回复；断开后使用“重新连接聊天”或“一键恢复聊天”，旧提问按原记录核对，不重复答复 |
| 框架处理 | “重新连接聊天”核验已有绑定；持续异常或旧管理操作阻塞时使用“一键恢复聊天” |

“重新连接聊天”只核验现有会话与连接，不创建新会话、不调用模型、不执行工具。DSH 桥接插件已经更换代次时，需要重启聊天或框架重新装配。页面上的“重启框架”只重启框架宿主，保留配置、历史和未知执行证据，不重启协议端或 DSH。

管理页面无法连接时，在框架运行机器执行 `qbf-cli service status` 核对进程，再用 `qbf-cli restart framework-admin` 恢复宿主。服务恢复后刷新页面；访问会话失效时使用原管理令牌重新登录。聊天按保存的运行意图和安全条件恢复，结果未知的请求继续要求核对。

## 一键恢复聊天

连接页聊天运行卡片提供“一键恢复聊天”；应用失败或等待加载的位置也提供同一入口。它独立于普通应用按钮的 busy/blocked 保护，不要求用户先逐项解锁旧管理操作。当前支持接入可信本机服务管理器的 Linux 单账号部署；多账号登记或已接管账号时明确拒绝统一重启，避免影响其他账号。

浏览器只提交一次 UUID v4 `operationId`，后台独立恢复进程负责：检查已保存设置与本机 DSH 归属、启动 DSH 以识别实际配置层、备份管理记录、停止受管框架/DSH/依赖、确认所有目标退出、回收有充分证据的遗留写锁、先恢复管理监听、启动其余依赖、最终统一核验当前全部完整健康、应用已保存设置、启动聊天并核验运行与完整链路。NapCat、SnowLuma 始终排除；协议端离线时提示用户恢复其登录，不代为启停。未保存草稿不参与修复。

只在受管目标已全部停止后，旧配置应用和 DSH 维护控制记录才可备份并标记为已中断；保留原编号、版本和阶段。业务执行、未知发送、工具回执、会话绑定与历史不因此清空或改成成功。只确认进程死亡的配置写锁及全停后经 `/proc` 核验无人持有的空锁可回收，无法证明时保留错误并允许再次恢复。

停服前必须确认独立 guardian 已登记并就绪。worker 意外退出时，guardian 等待原停止阶段的运维锁后最多两次执行纯服务启动，恢复管理页面并记录 failed；救援启动抑制开机自动聊天和助手应用，不续跑旧应用或模型请求。整台运行机器掉电仍需要机器重新启动。

恢复不会随原框架退出而中止。网页重新连接后读取同一持久修复记录；失去 POST 响应时只查询原 ID，必要时核对是否受理，不自动再次发起修复。确认未受理会持久封存该 ID，拒绝迟到请求，再允许用户明确开始新一次恢复。失败记录也可再次点击，不以旧管理锁永久封死入口。

成功要求当前 `runtime.state=running`、`chatReady=true` 且健康检查通过，服务端才记录 completed。前端只用当前观察到的修复完成证据解除旧本地管理锁，不把历史成功当作当前正常。管理访问会话以私有摘要与期限持久保存，后续重启无需重新登录；从旧版内存登录首次升级时可能需要登录一次。

如果服务安装损坏、配置缺失或外部协议/供应商故障仍在，修复如实给出原因。部分停止或依赖启动失败时仍尝试恢复管理页面；它不保证底层机器故障时网页一直可达。

## 先读取，再选择明确动作

| 状态或症状 | 首先核对 | 当前允许的恢复方向 |
| --- | --- | --- |
| 配置保存冲突 | 原文档 revision、当前值与本地草稿 | 重新读取，合并后明确提交新 CAS。 |
| 保存结果未知 | 原配置域的未决记录和服务端当前 revision | 保留原草稿和请求归属；先核对，不自动重复 POST。 |
| 应用 running/unknown、apply 阶段 blocked/pending_reload | 原 operationId、phase、phaseState、reasons | 查询同一操作；明确 reconcile，不能另建请求绕开未决操作。 |
| DSH 部署 pending_reload/unknown | 托管文件、provider/preset、当前进程可见的核验结果 | 使用对应部署 reconcile；读回证据满足要求后才进入下一步。 |
| 执行 unknown/超时/丢流 | execution、session/generation、request/turn、取消状态 | 原执行只记录晚到结果；使用显式执行核对和恢复预览/提交。 |
| 历史 inbox blocked | 所属会话、原期限、已提交批次与错误 | 启动时整理旧队列；未提交且未过期的输入继续排队，结果未知的已提交输入只保留回执，不重发。 |
| 包迁移/清理 unknown | owner、内容身份、operationId、页来源或生命周期证据 | 用包的明确只读核对接口检查，再选择后续动作。 |
| legacy 接管 unknown | 原库存清单、账号身份、全部既有 DB marker | 只读核对后 CAS 完成登记；缺少原库不能按空库处理。 |
| 私有存储不可读/损坏 | 文件身份、模式、owner、原数据库及 WAL | 恢复受信任的一致备份或修复外部条件后再读取，不改成缺省空状态。 |

这些方向不提供通用“清空 unknown”操作。一键恢复重新建立受管运行环境，业务未知结果仍按原领域核对。具体领域可能没有可自动证明安全的恢复手段；这时保留 blocked/unknown，比重复外部副作用更符合原操作语义。

## 配置与持久应用

配置编辑使用各文档 revision CAS。HTTP 409 不证明保存成功，应重新读取确切领域；busy、冲突与结果未知分别处理。网页断线或账号切换保留原 API 身份下的未决写入证据；旧响应不能写入新账号草稿。

应用入口是 `POST /api/chat/application`，请求包含客户端生成的 UUID v4 `operationId`、当前八份 `revisions` 和明确的 `deploy`。服务端先保存 journal，再协调 `stop → prepare → apply → start`，每个阶段记录 pending/in-flight/confirmed。查询原操作：

```text
GET /api/chat/application?id=<原 operationId>
```

不传 id 时读取当前操作。重复提交同一 id 和相同意图会指向同一操作；不同意图复用 id 会冲突。浏览器关闭不会让服务端重新创建操作，进程重启也不会续跑 unknown 阶段。

正常应用遇到 `pending_reload` 时，默认额外等待最多 60 秒，只读核对 DSH 实际加载结果，仍受整次操作 180 秒期限和运行 lifetime 限制。核验通过后原链继续；已确认写入但等待结束仍未加载时，记录 blocked/pending_reload。写入本身仍不确定时保留 unknown，不能把它当作普通加载延迟。

`POST /api/chat/application/reconcile` 的 body 为 `{ "operationId": "<原 UUID>" }`，界面入口为“核对并继续更新”。对于原 apply 阶段的 unknown，或 blocked/pending_reload，它核对原配置 revision、DSH 实际预设和完整来源证据；满足条件后，保存同一操作的 running 状态并在后台继续 start，立即返回供页面查询。不会再次 stop、prepare 或 apply，也不创建另一份操作。

停止或启动阶段未知且当前已证实安全停止时，核对可以把原操作记为 blocked 并要求新的明确更新，即使当前配置版本已经变化。原 operationId、请求版本和阶段证据保持不变；它不续跑旧请求，也不执行新的应用。准备阶段未知仅在其他依赖版本未变化、至多 deployment 版本变化时采用这一路径；apply 或 migrate 跨版本未知不能据此解除。

安全停止需要实际状态为 stopped、允许应用，生命周期、控制命令、执行、引擎队列和发送等均无待排空工作，bootstrap 与功能包没有未知状态。历史 `activeRevisions` 可以继续保留，它不是在途运行证据，也不必清空。

其他未知阶段继续采用对应证据核对：确实已按原配置运行时可确认 completed；确实停止且无法证明允许续行时记录 blocked，并给出原因。普通 GET 不续行、不启动；返回 200 只表示读到了快照。明确拒绝受理和已发生动作但回执未知分别呈现，不能一概归为未知应用。

应用中的 maintenance stop 保留持久运行意图，以便成功后启动；但 journal 为 running、unknown 或 apply 阶段的 blocked/pending_reload 时，重启恢复 gate 会阻止自动 start。否则一个未确认应用可能被旧 desiredRunning 意图绕过。见 [native-application.ts](../src/host/native-application.ts)、[native-chat-lifecycle.ts](../src/admin/native-chat-lifecycle.ts)、[native-application.test.ts](../test/native-application.test.ts)。

观察读取失败或迟到时，已知原操作的只读查询与明确核对仍保持可用。运行中的原操作只允许读取进度，不创建第二份应用。旧手动部署请求未知时，可明确“恢复操作”：先核验实际加载证据，再恢复管理入口并保留草稿；证据不完整或读取失败时保留保护。旧手动启停请求则只在上述安全停止证据齐全后恢复操作，检查不会重放启停。

## DSH 部署与助手目标

主聊天部署通过 `/api/chat/deployment/prepare`、`/apply` 和 `/reconcile` 管理。准备结果绑定配置与外部目标 revision，应用只更新托管部分。写入、读回或 reload 结果不确定时保留 journal/backup 信息，先核对原操作，不盲目重复 apply 或覆盖外部非托管设置。

公开 reconcile DTO 中的 verified、missingReasons、verificationScope、unverified 和 preset 证据共同决定可继续条件。文件和托管 provider/preset provenance 通过，不等于外部进程已加载相同凭据值；公开 `credentialValueIdentityVerified` 保持 false。界面只在相应证据满足时提供明确的后续操作。

助手目标独立使用 `/api/chat/assistant/deployment` 及其 `/prepare`、`/apply`、`/reconcile`。保存并启用 `chat-assistant` 的 provider/model/reasoning 会自动准备、应用并核验独立 target；只选择但未保存时不部署，target resolver 仍检查当前配置、已应用证据与模型元数据。unknown 不在工作启动时隐式部署。只有真实主人准入的独立工作子会话才应用 `fullAccess: true`，首轮前通过 DSH 官方权限服务设置并读回全本机权限；父会话和普通聊天不改变。请求范围与实际授予证据随工作记录持久保留，冷恢复仍核验原子会话绑定。

聊天启动时对已确认的助手部署执行一次依赖同步，单账号与多账号使用相同检查。依赖路径变化后，只有原助手设置版本、供应商、模型、受管预设和路由身份均保持一致，且当前文件、实际 DSH 加载结果与凭据来源完整核验通过时，才以 CAS 更新本地部署证据。此过程不写外部配置、不创建预设或会话、不调用模型、不重放工作；检查期间配置或文件变化时拒绝更新。缺失记录、未确认或等待加载的部署均保留原状态，普通聊天可独立启动，助手异常由健康检查显示。实际模型、密钥、工具或预设变化仍需明确应用助手设置。

`qbf_work_start` 的 `ASSISTANT_DEPLOYMENT_CONFIGURATION_CHANGED` 表示部署需要同步，`ASSISTANT_DEPLOYMENT_NOT_APPLIED` 表示尚未应用，`ASSISTANT_DEPLOYMENT_RECONCILIATION_REQUIRED` 表示原操作需要核对。这些拒绝发生在助手任务受理前；修改任务措辞或附件形式不能恢复部署，模型应报告具体原因。

本机接入优先自动发现实际 profile、凭据层与所选模型元数据，不要求重复填写已知路径或容量。修改受管配置之外的文件，不应通过“重新生成全部配置”来修复。实现与核对见 [dsh-profile-deployment.ts](../src/adapters/dsh-profile-deployment.ts)、[native-assistant-target.ts](../src/host/native-assistant-target.ts)。

## DSH 重启维护

`/api/chat/dsh/restart` 的 GET 保持只读。明确维护创建独立操作，按停止、重启、验证、恢复记录阶段；未知时不能换 ID 再次重启。`POST /api/chat/dsh/restart/reconcile` 核对原目标、配置版本、排空和加载证据，不重新执行重启命令；证据齐全才继续验证和恢复。已确认重启命令执行与当前引擎可连接分别记录，不等于模型实际生成已经成功。普通 GET 返回 operation:null 不能证明请求从未受理。只有明确核对在服务端原子登记旧 ID 不可再受理，并返回 `409 dsh_restart_not_received` 时，才可明确创建新意图；迟到的旧 ID 不会再执行。支持范围见 [DSH](DSH.md#明确重启本机-dsh)。

## 会话迁移、重置与执行核对

日常方案与人设更新复用已记录的 DSH 预设及原 sessionId，不调用会话迁移。应用仅更新受管预设、重新加载本机 DSH，并在原会话下一次提交前选择当前模型；不复制、遍历或删除会话历史。配置元数据与最新配置记录原子保存，保持会话 generation、授权锚点及同一人设资源 scope。

会话衔接按实际执行占用检查：旧执行虽然保留 unknown，但已收到模型终态、解除隔离且取消与通知均无未决动作时，不再阻止衔接。已结束分发的 `AGENT_UNKNOWN` 入站回执保留原样，不作为持续占用；其他未知入站仍阻止衔接。执行、发送、回复和任务仍分别检查，DSH 预览及提交继续核对源会话与队列空闲、历史游标和内容摘要。此判断不补发旧消息，也不将旧回执改成成功。

历史会话不因配置编辑换 ID。当前配置记录用于定位已托管预设与原 DSH 地址；提示词、模型和容量差异不再作为历史不兼容条件。DSH 地址变更、存储异常或未结束的显式迁移仍单独处理。最新记录单独保存，历史快照最多 64 条，历史额度不阻止正常更新。

**`GET /api/chat/sessions/migration` 是准备操作。** 它读取外部 DSH 的迁移预览证据，并持久保存带 migrationId/revision 的 prepared 计划，不是纯历史查询。计划提交仍需显式 `POST /api/chat/sessions/migrate`，携带预览所得计划与 revision。迁移中断后使用原计划核对，不重做 child fork 或换 operationId 掩盖已有结果。

解除绑定核对确切绑定 revision/generation，并要求目标会话没有未结束或结果未知的处理；运行中可以直接解除空闲会话的绑定。永久 sessionId ownership 保留旧 ID，不能把同一外部 sessionId 重新分配给另一会话或 generation。模型历史请到 DSH 删除，控制台禁用“删除”按钮，删除 API 返回 `session_delete_use_dsh`。已有删除维护操作继续按原操作编号查询与核对，未知结果不重复删除。

执行 journal 保留 request、外部 claim receipt、userMessage、turn、期限、取消和晚到结果。`GET /api/chat/executions/recovery?id=<id>` 读取已保存恢复计划；`POST .../preview` 和 `POST .../commit` 分别准备与明确提交，commit 要求计划 revision 和 `confirm: true`。该流程在检查外部执行证据后建立后续绑定边界，不代表原 prompt 会重新提交。普通历史读取不实例化 executor 或发起恢复。

超时后的持久核对确认外部已完成或取消时，更新外部结果并解除可释放的隔离；本轮的超时状态和期限原因继续保留，晚到完成不会改写成本轮成功。

停止或超时会阻止新投递，但不能证明外部模型已经停止。晚到 final 只进入原执行记录，默认不发回 QQ。特别是取消处于 requesting/unknown 时，旧 session 地址仍可能被迟到取消命中，不能直接复用给后继请求。见 [native-session-migration.ts](../src/host/native-session-migration.ts)、[native-execution-recovery.ts](../src/host/native-execution-recovery.ts)、[sessions.ts](../src/host/sessions.ts)。

## 队列、工作、提醒与交互

`GET /api/chat/inbox` 返回每个会话 idle/pending/dispatching/blocked、pending 数量、期限和错误，以及 `automaticReplayAvailable: false`。群聊忙碌和旧执行核对期间，已准入的新输入保存在待发区，下一批一次合并提交；`deadlineAt: null` 表示尚未开始本批执行计时。批次开始分发时按当前单轮策略计算期限，消息原始时间、身份和历史边界保留，等待前一轮不消耗下一轮的执行预算。已准入的续聊不因等待期间窗口自然结束而丢弃，派发前仍核对当前参与设置与权限。私聊保留原入站期限，过期输入结束。重启保留尚未提交的群聊输入和未过期的私聊输入；中断的提交批次记为 unknown 回执并移出待发队列，不自动重放。旧 blocked 记录启动时按同样规则整理，旧格式无法确认提交范围时不补发。执行结果未确认且有新输入等待时，后台每会话最多五秒核对一次 SDK 结束证据、全局最多四路；确认结束后自动继续。SDK 尚未确认结束时不会强行并发提交；也不自动重建或清空会话。全局 follow 池满导致的新会话拒绝也不等于已加入普通忙碌队列。

`GET /api/chat/work` 和带 id 的详情查询只读取持久工作记录，包括交付和文件回执。网页不提供工作 start/followup/interrupt/reconcile 写入口。工作指令仍通过所属 QQ 来源和功能 policy；SDK 封装也必须使用调用方 execution。

助手在开始或执行阶段失败、超时或中断，且尚未形成最终结果时，框架将任务摘要（新任务）、已知原因和最后进展交回原聊天会话，由当前模型按人设简短说明哪件事未完成；群聊中 @ 原委派主人。最后进展不代表完成，也不自动重试任务。转述只允许输出正文，发送沿现有 policy 和 outbox 链路；不读取或修改外部 DSH 程序。已由结果交付链路处理的终态继续沿原结果回传，避免重复通知。聊天模型本身不可用、转述失败或送达未知时，保留通知状态，不直接发送固定系统文案或自动重提通知。

失败通知按原工作与本次执行编号单独持久化，生成前及投递时重新核对当前主人、账号、原执行、原会话绑定与代次和访问权限；撤权或原绑定变化时拒绝。重启会检查尚未通知的失败记录及未提交的 pending 通知；sending 中断、未知送达与已结清通知均不自动重发。通知状态独立于任务结果，发送通知不会把 unknown 工作改成 failed/completed，也不会补发其附件或继续执行任务。

提醒规则和 occurrence 分开持久化。显式停止 runtime 不删除规则；下次 start 恢复规则服务。发生时核验当前访问规则与发送授权，unknown 发送不自动重试，相应规则可保留阻断证据。配置提醒不会顺带授权模型工具或开启主动话题。日历和持久任务同样先保存发生记录，重启不会把原 running/unknown 当成尚未执行。

模型问题会发到所属 QQ 会话，实际配置主人在原问题上下文中答复。外部工具确认按当前请求的真实主人来源自动允许或拒绝，不再等待逐次答复。网页只读问题摘要，没有代答或批准接口。记忆 proposal 的确认也在 QQ 中完成：`/确认记忆 memory-...`；撤销使用 `/撤销记忆 memory-...`。`/记住` 默认绑定来源会话，`/记住群` 要求群来源，`/记住全局` 是主人明确共享。记忆业务的工具与上下文由扩展接入；控制台不提供手工记忆管理表单。

## bootstrap、包状态与关闭

bootstrap `create()` 返回的 mount 在安装前处于 prepared。如果 HTTP 身份核对等安装前步骤失败，资源排空会调用 `abandonPrepared()`，即使没有 host 或还持有上次的 host，也不会误调用 stop。该接口只允许尚未安装、无 pending start/stop 的 prepared mount；abort 其 lifetime 后标 stopped，后续可创建新 mount。已安装、pending 或 unknown 不能用此接口清除状态。未 settle 的 create 会继续阻止重叠创建。

已安装扩展的 stop 有明确期限和未决标记。一次 raw hook/disposer 未结束时，不因再次 stop 而重复调用。包生命周期只读核对有独立期限，不复用已经 abort 的运行 lifetime；超时保留 unknown，晚到核对结果不能自行改写 journal。

包 owned state 使用稳定 namespace。迁移先固定目标身份，保存 operationId、cursor、来源 revision/checksum，再以最多 60 个键的页调用 converter；结果与元数据在一次 CAS batch 中提交。迁移中断/超时为 unknown，重新打开不会自动调用 converter。`reconcile(expectedRevision, operationId, signal)` 只读核对原页来源未变化，再以 CAS 转回可继续的 prepared 检查点；之后仍需明确 `applyPage()`。来源已漂移则拒绝核对，不能以目标新值盖掉冲突数据。

旧 raw 状态要显式 `prepareLegacyAdoption()`。其旧 schema 为未知的 0，原键与 TTL 保留；不能用新 namespace 假装迁移完成。内容指纹变化也不能用假的 hash 或静默更新版本绕过。完整规则与 SDK 示例见 [EXTENDING.md](EXTENDING.md)。

`runtime.close()` 返回单次缓存 Promise。即使 stop 抛出原 bootstrap unknown，仍继续关闭独立协议连接、提醒、记忆、事件与 hooks，最后向上返回原错误。未排空运行的主 store 和 lease 保留，raw control command 的 store 等 drain 后关闭。退出码为失败不意味着需要重跑 stop；关闭连接也不清除外部执行未知状态。

账号 manager 的 close 同样逐个 runtime 单次、有界执行。一个账号关闭不确认时，其他账号仍会进行独立关闭，未确认实例保留 unknown；再次 close 返回同一结果，不重复调用底层 close。见 [native-bootstrap.test.ts](../test/native-bootstrap.test.ts)、[native-package-state.test.ts](../test/native-package-state.test.ts)、[native-accounts.test.ts](../test/native-accounts.test.ts)。

## 多账号选择、接管与重启

全局 `GET /api/accounts` 读取账号清单；`POST /api/accounts` 使用 action 和 registry revision 管理 create/start/stop。创建 body 包含 `action: "create"`、revision、label 和 `{ protocolId, accountId }`，只登记账号，不连接。start 还要求当前八份原生配置 revisions；stop 是明确停止意图。

账号内请求使用真实 dispatch URL，例如在 JavaScript 中：

```js
const query = new URLSearchParams({
  account: selectedAccountId,
  path: '/api/chat/runtime',
});
const response = await fetch(`/api/accounts/dispatch?${query}`,
  { credentials: 'same-origin' });
```

这是使用现有认证会话和选中账号 ID 的局部片段。路径只接受该账号 bundle 的明确 `/api/chat/` 路由，额外 query 作为领域参数转交；POST 保持同样 URL、使用该领域原 body。不要把 path 写成任意 URL 或把全局设置通过 dispatch 转发。账号记录 ID 是 scope 哈希，不能直接用 QQ 号替换 account 参数。

旧单账号目录接管步骤如下：

1. 明确停止旧聊天，保留原目录和既有数据库。
2. 用 `POST /api/accounts` 的 `preview-legacy-adoption` action 和目标 accountScope 获取 revision、sourceFingerprint、数据库清单。
3. 明确提交 `adopt-legacy`，携带原 preview 和 label。服务端重新核对清单与 revision，并通过真实协议身份核对确认归属，然后关闭旧 runtime。
4. 接管先保存 unknown claim 和原库存，再写账号 marker/身份；完成后才转 ready。中断时使用原账号 id、当前 registry revision 和 `reconcile-legacy-adoption`，只读检查所有原库 marker 后 CAS 完成登记。

该过程保留原目录与旧业务键，不静默搬移文件。原库缺失、身份不一致或清单变更时拒绝核对，不创建替代空库。已接管后全局 legacy 原生路由返回 `native_legacy_account_adopted`，不能再启动旧未分账号 runtime。

进程重启先读取 registry；新隔离账号使用 `accounts/<scope 哈希>/`，接管账号继续使用原根目录。只有 ready 且 desiredRunning 为 true 的账号才尝试恢复，显式 stop 的账号保持停止。每个账号独立核验身份、配置 revision 和应用/包恢复 gate；某个账号失败不让其他账号共用它的会话或授权。真实双账号、错误身份、接管与重启测试见 [native-account-gateway.test.ts](../test/native-account-gateway.test.ts)。

## 存储与备份边界

不要删除 lease、journal、outbox、ownership 或 adoption inventory 来“解锁”；这些记录是防止外部动作重放和跨账号误用的证据。普通读取失败会明确报告 unavailable，不能改成空 sessions、空 grants 或默认运行成功。

现有 SQLite 查询采用只读连接和一致快照，保留 WAL 中的已提交数据。SQLite 可能使用 WAL/SHM 协调文件，所以管理“只读”不保证原目录字节完全不变，但不会借查询创建业务库、业务记录或调度恢复。备份应在明确停止并确认排空后取得，或使用能保证 DB/WAL 一致的 SQLite 备份方式；不能只复制 `.sqlite` 而忽略仍有有效数据的 WAL。

管理写入现有历史使用 `requireExisting: true`，先校验私有目录、文件身份及既有 schema，不创建 missing 库、不通过 chmod 修补任意文件。备份与恢复时保留文件权限及账号 marker，并在服务读取成功后再执行明确的业务操作。

## 有界自动恢复

框架每 30 秒检查一次已保存的运行意图与当前运行状态。用户已启动聊天、配置版本仍一致且框架持续异常 90 秒时，先通过原生命周期恢复可启动实例；需要受管恢复时复用“一键恢复聊天”的独立 worker、guardian、写屏障和操作记录。默认启用，可在服务环境设置 `QQ_BRIDGE_FRAMEWORK_AUTO_RECOVERY=0` 关闭；连接页显示开关状态。

自动恢复在发起动作前持久保存编号、时间和次数，响应丢失不重发同一操作。退避依次为 5 分钟、15 分钟、60 分钟，每小时最多三次，进程重启保留预算。短暂故障、主动停止、配置版本变化、未核清的 DSH 维护及多账号统一重启不触发此流程；多账号原有独立连接重试继续工作。配置、权限、协议端登录或外部服务问题需按实际条件处理。未提供受管入口的安装只恢复生命周期允许启动的聊天实例。

`GET /api/chat/automatic-recovery` 返回启用状态、最近观察原因、持续故障起点、尝试次数与时间、最近操作编号和下次允许尝试时间。该读取需要管理员身份。自动恢复不清空会话，不重放模型、工具或未知发送；一键恢复的原有范围限制继续适用。

受管 Linux 框架宿主或网关进程异常退出时，服务监督进程按 1、2、4、8、16 秒退避重新启动，15 分钟最多五次。正常退出或明确停止不重启。该规则只适用于框架自身两个组件；DSH、协议端与额外服务仍按其各自委托方式维护。完整发行包的 `serve`／Windows 启动器提供相同次数上限的子进程异常恢复；Docker 另外由容器重启策略管理。

执行关联通道遇到明确的传输超时或暂时不可用时，暂停新请求并每 30 秒只读核验原 DSH 插件加载代次。同一代次核验通过后恢复新会话的处理能力；原未知执行及其会话隔离保持。加载代次变化、游标缺口、持久证据故障和显式执行恢复后的隔离不走该自动放行路径，不重放原输入或工具。

### 精确取消与串行租约

执行控制器在释放原执行的持久会话占用后，以原 `sessionId + requestId` 通知串行队列。取消终态与取消回执的两种到达顺序使用同一释放路径，重复或迟到的旧事件不能释放新请求的租约。取消和失败仅关闭原请求的回复等待。

配套桥接插件的 `bridgePlugin/cancelExecution` 核验 owner、插件 epoch 和当前实际认领的请求，再同步取消该请求。缺少认领、旧请求或旧代次均不按会话地址取消。使用此入口的执行保存 `cancelScope: request`；请求取消结果未知时，仍须取得原请求对应的持久终态 checkpoint 与会话静止证据才能释放，不补发正文或重跑原请求。旧插件的地址取消与历史未知取消继续隔离，旧轮结束本身不能证明迟到地址取消已排空。

运行中的聊天生命周期主动核对未知聊天与后台工作，不需要等下一条 QQ 消息触发。观察器最多跟踪 256 项、同时发起四个查询，单次最多六秒，按 1、2、4、8、16、32、60 秒退避，每项最多 24 次；实际未结束的底层查询仍占容量。次数、下次时间、错误和耗尽状态持久保存，重启不重置次数。耗尽后保留未知与证据，明确记录需要维护；不猜测完成。

后台工作恢复核对原 child、parent、真实受理消息或最后追加请求、终态与持久 checkpoint，并重新确认子会话静止。缺少关联、未结束轮次、未核清附件或后续轮次均保留未知；核对不启动、续跑或中断子会话。取得实际终态后记录结果，投递继续标为未知，不自动补发。

执行详情的 `diagnostics` 独立保留排队、准备、模型、压缩、工具与状态转换元数据七天，每请求或轮次最多 128 个时间点。取消、超时及恢复核对不依赖 QQ 提示开关。DSH 事件只投影阶段、位置和错误类别，不传输摘要、模型思考或工具正文。发送结果继续以原 outbox 与送达回执为准。

原工作异常说明已经进入模型转述时，结果核对等待该说明结算后再更新工作终态，避免在转述途中改变其资料使合法回复被拒绝。原任务实际中断的证据可以将执行从 unknown 收敛为 failed；说明的送达与工作结果的投递继续分别记录。没有可靠附件清单的工作不把附件登记调用当成完整交付证据。
