import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, open} from 'node:fs/promises';
import {join} from 'node:path';
import {MSG_TYPE, TAG, parseFix} from './fix.mjs';

// 三类身份分开管理：
// 1. 会话传输序号（sessionEpoch + MsgSeqNum）
// 2. 业务回报身份（TradeReportID 571）
// 3. 更正引用关系（TradeReportRefID 572 -> TradeReportID）
// GapFill(35=4/123=Y) 只解释传输序号跳过，不产生任何业务记录。
function createState() {
  return {
    version: 1,
    sessions: {},          // epoch -> 传输层会话视图
    reports: {},           // tradeReportId -> 业务回报投影
    links: [],             // 更正关系，含待关联状态
    events: [],            // 异常与补发协作审计（有界）
    resends: [],           // 已持久化的补发请求，重启不重复发起
  };
}

function digestOf(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

function nowStamp(clock) {
  return new Date(clock()).toISOString();
}

export class Intake {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.file = join(directory, options.file ?? 'intake.json');
    this.serial = Promise.resolve();
    this.clock = options.clock ?? (() => Date.now());
    this.maxEvents = options.maxEvents ?? 500;
    this.state = createState();
    this.loaded = false;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved?.version !== 1) throw new Error('unsupported intake state version');
      this.state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = createState();
    }
    this.loaded = true;
    return this.snapshot();
  }

  async #persist() {
    await mkdir(this.directory, {recursive: true});
    const temporary = join(this.directory, `intake-${process.pid}-${this.clock()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state));
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.file); // 只有落盘成功，恢复位置才算推进
  }

  #session(epoch) {
    if (!this.state.sessions[epoch]) {
      this.state.sessions[epoch] = {
        epoch,
        received: {},         // seqNum -> 传输收件登记（不按业务内容去重）
        gapFilled: [],        // GapFill 明确跳过的序号区间
        nextExpectedSeqNum: 1,
        pendingGapRanges: [], // 仍缺的传输序号区间
        resends: [],          // 本会话已发起的补发请求
        openedAt: nowStamp(this.clock),
      };
    }
    return this.state.sessions[epoch];
  }

  #recordEvent(kind, detail) {
    this.state.events.push({at: nowStamp(this.clock), kind, ...detail});
    if (this.state.events.length > this.maxEvents) {
      this.state.events.splice(0, this.state.events.length - this.maxEvents);
    }
  }

  #upsertLink(refId, reportId, epoch) {
    const existing = this.state.links.find(link => link.refId === refId && link.reportId === reportId);
    if (existing) {
      existing.lastSeenEpoch = epoch;
      existing.resolved = Boolean(this.state.reports[refId]);
      return existing;
    }
    const link = {
      refId,
      reportId,
      firstEpoch: epoch,
      lastSeenEpoch: epoch,
      resolved: Boolean(this.state.reports[refId]),
    };
    this.state.links.push(link);
    return link;
  }

  #refreshLinkStatus(refId) {
    for (const link of this.state.links) {
      if (link.refId === refId) link.resolved = Boolean(this.state.reports[refId]);
    }
  }

  #applyBusinessReport(message, epoch) {
    const tradeReportId = message.tags[TAG.TRADE_REPORT_ID];
    if (!tradeReportId) {
      this.#recordEvent('report_missing_identity', {epoch, seqNum: message.seqNum});
      return;
    }
    const refId = message.tags[TAG.TRADE_REPORT_REF_ID] ?? null;
    const existing = this.state.reports[tradeReportId];
    if (existing) {
      // 同一业务身份再次到达：只记一次成交，重复观测计数，数值变化保留版本。
      existing.observations += 1;
      existing.lastSeqNum = message.seqNum;
      existing.lastEpoch = epoch;
      if (existing.digest !== digestOf(message.raw)) {
        existing.versions.push({
          digest: digestOf(message.raw),
          seqNum: message.seqNum,
          epoch,
          at: nowStamp(this.clock),
        });
        existing.digest = digestOf(message.raw);
        existing.fields = message.fields;
      }
    } else {
      this.state.reports[tradeReportId] = {
        tradeReportId,
        firstEpoch: epoch,
        firstSeqNum: message.seqNum,
        lastEpoch: epoch,
        lastSeqNum: message.seqNum,
        observations: 1,
        possDupFirstSeen: message.possDup,
        digest: digestOf(message.raw),
        fields: message.fields,
        versions: [],
        refId,
      };
      // 新业务身份到达时，之前指向它的待关联更正关系随之解析。
      this.#refreshLinkStatus(tradeReportId);
    }
    if (refId) this.#upsertLink(refId, tradeReportId, epoch);
  }

  // 处理一批 GET /messages 得到的 base64 原件。整个批次先在内存归并，再一次原子落盘。
  ingest(epoch, items) {
    const operation = this.serial.then(async () => {
      if (!this.loaded) await this.load();
      if (typeof epoch !== 'string' || !epoch) throw new Error('session epoch required');
      if (!Array.isArray(items)) throw new Error('items must be an array');
      const session = this.#session(epoch);
      let accepted = 0;
      let duplicates = 0;
      let invalid = 0;
      const businessIds = [];

      for (const encoded of items) {
        let message;
        try { message = parseFix(encoded); }
        catch (error) {
          invalid += 1;
          this.#recordEvent('invalid_message', {epoch, reason: error.message, rawDigest: digestOf(String(encoded))});
          continue;
        }
        const receipt = session.received[message.seqNum];
        if (receipt) {
          // 网络抖动重复领取：传输序号已登记，PossDupFlag 的重送不能再记一笔成交。
          duplicates += 1;
          if (message.possDup && !receipt.possDupObserved) receipt.possDupObserved = true;
          continue;
        }

        session.received[message.seqNum] = {
          seqNum: message.seqNum,
          msgType: message.msgType,
          possDup: message.possDup,
          origSendingTime: message.origSendingTime,
          digest: digestOf(message.raw),
          at: nowStamp(this.clock),
        };
        accepted += 1;

        if (message.msgType === MSG_TYPE.SEQUENCE_RESET && message.tags[TAG.GAP_FILL_FLAG] === 'Y') {
          // GapFill(35=4/123=Y)：序号 seqNum+1..newSeqNo-1 在传输层被跳过，
          // 不代表存在对应业务记录，因此绝不生成业务回报或业务身份。
          const newSeqNo = Number(message.tags[TAG.NEW_SEQ_NO]);
          if (!Number.isInteger(newSeqNo) || newSeqNo <= message.seqNum) {
            this.#recordEvent('invalid_gapfill', {epoch, seqNum: message.seqNum, newSeqNo});
          } else {
            session.gapFilled.push({from: message.seqNum + 1, to: newSeqNo - 1, newSeqNo, at: nowStamp(this.clock)});
          }
          continue;
        }

        if (message.msgType === MSG_TYPE.TRADE_REPORT) {
          const before = this.state.reports[message.tags[TAG.TRADE_REPORT_ID]] !== undefined;
          this.#applyBusinessReport(message, epoch);
          if (!before) businessIds.push(message.tags[TAG.TRADE_REPORT_ID]);
        } else {
          this.#recordEvent('unhandled_msg_type', {epoch, seqNum: message.seqNum, msgType: message.msgType});
        }
      }

      this.#advanceSession(session);
      await this.#persist(); // 先可靠落盘，再允许外部推进恢复位置/发起补发
      return {
        epoch,
        accepted,
        duplicates,
        invalid,
        newBusinessReports: businessIds,
        nextExpectedSeqNum: session.nextExpectedSeqNum,
        pendingGapRanges: session.pendingGapRanges,
      };
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  #gapFilledSet(session) {
    const filled = new Set();
    for (const range of session.gapFilled) {
      // 空区间（from > to）表示没有被跳过的序号，仅 NewSeqNo 本身占位。
      for (let seq = range.from; seq <= range.to; seq += 1) filled.add(seq);
      filled.add(range.newSeqNo);
    }
    return filled;
  }

  #advanceSession(session) {
    const filled = this.#gapFilledSet(session);
    const known = Object.keys(session.received).map(Number)
      .concat([...filled]).sort((a, b) => a - b);
    const maxKnown = known.at(-1) ?? 0;

    // 恢复位置：只沿“实际收到”的连续序号推进；GapFill 解释跳过，但不替缺号背书。
    let next = 1;
    while (session.received[next]) next += 1;
    session.nextExpectedSeqNum = next;

    const occupied = seqNum => Boolean(session.received[seqNum]) || filled.has(seqNum);
    // 待补区间：恢复位置与最大已知序号之间，既未收到也未被 GapFill 解释的序号。
    const ranges = [];
    let start = null;
    for (let seq = next; seq <= maxKnown; seq += 1) {
      if (occupied(seq)) {
        if (start !== null) { ranges.push([start, seq - 1]); start = null; }
      } else if (start === null) {
        start = seq;
      }
    }
    if (start !== null) ranges.push([start, maxKnown]);
    session.pendingGapRanges = ranges;
  }

  // 登记补发协作意图；先落盘再由调用方真正 POST /resend，崩溃重启不会重复发起。
  requestResend(epoch, begin, end) {
    const operation = this.serial.then(async () => {
      if (!this.loaded) await this.load();
      const session = this.#session(epoch);
      if (!Number.isInteger(begin) || !Number.isInteger(end) || begin <= 0 || end < begin) {
        throw new Error('invalid resend range');
      }
      const already = session.resends.some(r => r.begin === begin && r.end === end);
      if (already) return {epoch, begin, end, duplicated: true};
      const record = {begin, end, at: nowStamp(this.clock)};
      session.resends.push(record);
      this.state.resends.push({epoch, ...record});
      await this.#persist();
      return {epoch, begin, end, duplicated: false};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  noteResendOutcome(epoch, begin, end, accepted) {
    const operation = this.serial.then(async () => {
      if (!this.loaded) await this.load();
      const session = this.#session(epoch);
      const record = session.resends.find(r => r.begin === begin && r.end === end);
      if (record) record.accepted = Boolean(accepted);
      this.#recordEvent('resend_outcome', {epoch, begin, end, accepted: Boolean(accepted)});
      await this.#persist();
      return this.snapshot();
    });
    this.serial = operation.catch(() => {});
    return operation;
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  // 断线再连的说明视图：哪些传输消息已收到、哪些业务回报的更正关系仍待关联。
  status() {
    const sessions = Object.fromEntries(Object.entries(this.state.sessions).map(([epoch, session]) => [epoch, {
      epoch,
      nextExpectedSeqNum: session.nextExpectedSeqNum,
      receivedSeqNums: Object.keys(session.received).map(Number).sort((a, b) => a - b),
      gapFilled: session.gapFilled,
      pendingGapRanges: session.pendingGapRanges,
      resends: session.resends,
    }]));
    return {
      sessions,
      businessReports: Object.keys(this.state.reports).sort(),
      pendingLinks: this.state.links.filter(link => !link.resolved),
      resolvedLinks: this.state.links.filter(link => link.resolved),
      events: this.state.events,
    };
  }
}
