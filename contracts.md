# 来源网关契约

POST /logon 返回 sessionEpoch；GET /messages?session=... 返回 base64 原始 FIX 4.4 消息；POST /resend 接受 begin/end。消息使用 SOH 分隔，BodyLength 与 CheckSum 需验证；MsgSeqNum、PossDupFlag、OrigSendingTime 是传输属性，TradeReportID/TradeReportRefID 是业务身份。GET /__audit 返回包含补发请求的网关审计。

## 本地来源操作

默认场景 normal，其他场景为 gap-and-resend, reset。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

兼容入口 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容；provenance 不随来源端口变化，进程重启后同一原件保持幂等。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态由 Intake 各自维护。

Intake（src/intake.mjs，落盘 intake.json）把三类身份分开：

- 传输身份：sessionEpoch + MsgSeqNum(34)。每收到一个新序号才登记，重复领取只计 duplicates；nextExpectedSeqNum 是第一个未实际收到的序号，仅在批次原子落盘成功后推进。
- 业务身份：TradeReportID(571)。PossDupFlag(43=Y) 重送不新增成交，只累加 observations；新业务身份即使数值相同也独立保留；同身份内容变化在 versions 留痕。
- 更正关系：TradeReportRefID(572) -> TradeReportID(571)，引用先于原报到达时进入 pendingLinks，原报到达后转为 resolvedLinks，且可跨 sessionEpoch 关联。

SequenceReset/GapFill（35=4、123=Y、NewSeqNo 36）只在传输层登记序号跳过，不写入 reports。会话重置产生新 sessionEpoch 时编号独立，不与旧会话拼接。发现未被 GapFill 解释的缺号时，先持久化补发意图（resends）再 POST /resend；重启后同区间不重复请求。GET /status 返回 sessions（已收序号、GapFill、待补区间、补发记录）、businessReports、pendingLinks/resolvedLinks 与事件；未配置 intake 时该端点返回 404，不将未知状态伪造为成功。GET /records 保留兼容。
