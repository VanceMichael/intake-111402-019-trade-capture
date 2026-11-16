# 交易回报补发通道的会话采集

成交回报归档器。已支持单消息框架检查，不做下单。来源是本地 FIX 网关的演练通道。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，依次跑通 normal、重复领取、gap-and-resend、reset，实际领取并打印三层收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /status 返回会话/业务/更正三层状态，GET /health 检查服务。

```sh
docker build --network=none -t trade-capture .
docker run --rm --network=none trade-capture npm test
docker run --rm --network=none trade-capture npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 收件语义（三层身份分别管理）

所有材料均为本地虚构交易，不连接行情或交易账户，也不实现下单。

1. 传输会话层（sessions，按 sessionEpoch 隔离）：以 MsgSeqNum(34) 登记每个实际收到的序号，维护恢复位置 nextExpectedSeqNum、已收序号、GapFill 跳过说明与待补区间。会话重置后新 epoch 的序号从 1 重新计数，绝不接到旧会话上。
2. 业务回报层（reports）：以 TradeReportID(571) 作为业务身份。PossDupFlag(43=Y) 的重送只增加同一身份的观测计数，不再记一笔成交；业务身份不同、即使数值完全相同的回报也各自保留，不做内容去重。
3. 更正关系层（links）：TradeReportRefID(572) 指向被更正的 TradeReportID。引用先到、原报后到时先记为待关联（pendingLinks），原报到达后自动解析（resolvedLinks）；更正关系跨会话仍可关联。

其他规则：

- GapFill（35=4、123=Y、NewSeqNo 36）只说明传输序号被跳过，不产生任何业务记录或业务身份。
- 缺号先在本地持久化补发意图，再 POST /resend；崩溃重启后同一区间不会重复发起，待补缺口仍可在 /status 观察。
- 只有批次成功落盘后恢复位置才推进；网络错误不会被当作业务内容，断线重连后仍能说明哪些消息已收到、哪些业务回报待关联。
- BodyLength(9) 与 CheckSum(10) 逐帧校验，PossDup 重送必须带 OrigSendingTime(122)，校验失败的原件被隔离记录，不影响同批其他消息。

## 工程结构

- src/fix.mjs 是严格 FIX 4.4 解析器：字段表、BodyLength/CheckSum 校验、传输属性与业务身份分别取值。
- src/intake.mjs 是持久化收件状态机：三层身份、GapFill、待补区间、补发意图与原子落盘（intake.json）。
- src/runner.mjs 实现持续收件循环：登录、轮询、缺号补发协作、断线重试与空闲退出。
- src/reader.mjs 保留一次性 collect(client) 兼容入口，校验逻辑复用 fix.mjs。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存原件与内容摘要（records.json）；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。未接入 intake 时 /status 返回 404，不伪造状态。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
