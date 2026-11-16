import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Intake} from '../src/intake.mjs';
import {tradeReport, gapFill} from '../test-support/fix-builder.mjs';

let directory;
test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'intake-unit-')); });
test.afterEach(async () => { await rm(directory, {recursive: true, force: true}); });

test('PossDupFlag 重送不再记一笔成交；新业务身份即使数值相同也保留', async () => {
  const intake = new Intake(directory);
  const first = await intake.ingest('s1', [tradeReport({seqNum: 1, reportId: 'T1'})]);
  assert.deepEqual(first.newBusinessReports, ['T1']);

  // 同一传输序号重放（PossDupFlag=Y，内容相同）：只计重复观测，不新增业务回报。
  const replay = await intake.ingest('s1', [tradeReport({
    seqNum: 1, reportId: 'T1', possDup: true, origSendingTime: '20261101-00:00:00',
  })]);
  assert.equal(replay.duplicates, 1);
  assert.deepEqual(replay.newBusinessReports, []);
  assert.equal(intake.status().businessReports.length, 1);

  // 新业务身份 T5，数值与 T1 完全相同：业务身份不同，不能被内容去重。
  const distinct = await intake.ingest('s1', [tradeReport({seqNum: 2, reportId: 'T5'})]);
  assert.deepEqual(distinct.newBusinessReports, ['T5']);
  assert.deepEqual(intake.status().businessReports, ['T1', 'T5']);
});

test('传输序号、业务身份、更正关系分别管理，待关联可在引用到达后解析', async () => {
  const intake = new Intake(directory);
  await intake.ingest('s1', [tradeReport({seqNum: 1, reportId: 'T4', refId: 'T1'})]);
  let status = intake.status();
  assert.equal(status.pendingLinks.length, 1);
  assert.equal(status.pendingLinks[0].refId, 'T1');
  assert.equal(status.resolvedLinks.length, 0);

  await intake.ingest('s1', [tradeReport({seqNum: 2, reportId: 'T1'})]);
  status = intake.status();
  assert.equal(status.pendingLinks.length, 0);
  assert.equal(status.resolvedLinks.length, 1);
  assert.equal(status.resolvedLinks[0].resolved, true);
  assert.equal(status.resolvedLinks[0].refId, 'T1');
  // 传输视图与业务视图独立：两个序号、两个业务身份。
  assert.deepEqual(status.sessions.s1.receivedSeqNums, [1, 2]);
});

test('GapFill 只表示传输序号跳过，不产生业务记录', async () => {
  const intake = new Intake(directory);
  const result = await intake.ingest('s1', [
    tradeReport({seqNum: 1, reportId: 'T1'}),
    gapFill(3, 4), // 序号 3 是 GapFill，跳过的是传输序号而非业务回报
    tradeReport({seqNum: 4, reportId: 'T3'}),
  ]);
  const status = intake.status();
  assert.deepEqual(status.businessReports, ['T1', 'T3']);
  // 35=4 GapFill：传输序号 3 被跳过（NewSeqNo=4），不产生业务记录。
  assert.deepEqual(status.sessions.s1.gapFilled.map(({from, to}) => [from, to]), [[4, 3]]);
  // 恢复位置只沿实际收件推进：序号 2 仍缺，停在 2；GapFill 仅解释序号 3。
  assert.equal(status.sessions.s1.nextExpectedSeqNum, 2);
  assert.deepEqual(status.sessions.s1.pendingGapRanges, [[2, 2]]);
  assert.equal(result.accepted, 3);
});

test('缺号形成待补区间并驱动一次补发，重启后不重复发起', async () => {
  const intake = new Intake(directory);
  await intake.ingest('s1', [
    tradeReport({seqNum: 1, reportId: 'T1'}),
    tradeReport({seqNum: 4, reportId: 'T3'}),
  ]);
  const status = intake.status();
  assert.deepEqual(status.sessions.s1.pendingGapRanges, [[2, 3]]);
  assert.equal(status.sessions.s1.nextExpectedSeqNum, 2);

  const plan = await intake.requestResend('s1', 2, 3);
  assert.equal(plan.duplicated, false);
  const again = await intake.requestResend('s1', 2, 3);
  assert.equal(again.duplicated, true);

  // 模拟进程重启：重新加载磁盘状态，缺口与补发意图仍在，不产生新请求。
  const restarted = new Intake(directory);
  await restarted.load();
  const reloaded = restarted.status();
  assert.deepEqual(reloaded.sessions.s1.pendingGapRanges, [[2, 3]]);
  assert.deepEqual(reloaded.sessions.s1.resends.map(({begin, end}) => [begin, end]), [[2, 3]]);
  const afterRestart = await restarted.requestResend('s1', 2, 3);
  assert.equal(afterRestart.duplicated, true);
});

test('补发回来的 PossDup 原件补齐缺口，且不新增成交', async () => {
  const intake = new Intake(directory);
  await intake.ingest('s1', [
    tradeReport({seqNum: 1, reportId: 'T1'}),
    tradeReport({seqNum: 4, reportId: 'T3'}),
  ]);
  const filled = await intake.ingest('s1', [
    tradeReport({seqNum: 2, reportId: 'T2'}),
    // 补发批次里 T2 的 PossDup 重送，使用新的传输序号 3 承载：传输上要登记，业务上不新增成交。
    tradeReport({seqNum: 3, reportId: 'T2', possDup: true}),
  ]);
  assert.equal(filled.duplicates, 0);
  assert.equal(filled.accepted, 2);
  assert.deepEqual(filled.newBusinessReports, ['T2']);
  const status = intake.status();
  assert.deepEqual(status.sessions.s1.pendingGapRanges, []);
  assert.equal(status.sessions.s1.nextExpectedSeqNum, 5);
  assert.deepEqual(status.businessReports, ['T1', 'T2', 'T3']);
});

test('会话重置后新会话独立编号，不把新序号接到旧会话', async () => {
  const intake = new Intake(directory);
  await intake.ingest('s1', [
    tradeReport({seqNum: 1, reportId: 'T1'}),
    tradeReport({seqNum: 2, reportId: 'T2'}),
  ]);
  await intake.ingest('s2', [tradeReport({seqNum: 1, reportId: 'T4', refId: 'T1'})]);
  const status = intake.status();
  assert.deepEqual(status.sessions.s1.receivedSeqNums, [1, 2]);
  assert.deepEqual(status.sessions.s2.receivedSeqNums, [1]);
  assert.equal(status.sessions.s1.nextExpectedSeqNum, 3);
  assert.equal(status.sessions.s2.nextExpectedSeqNum, 2);
  // 更正关系跨会话仍可关联：T4 在 s2 引用 s1 已有的 T1。
  assert.equal(status.resolvedLinks.length, 1);
});

test('同业务身份内容变化保留版本，业务身份不因数值变化被替换', async () => {
  const intake = new Intake(directory);
  await intake.ingest('s1', [tradeReport({seqNum: 1, reportId: 'T1', lastPx: '10'})]);
  await intake.ingest('s1', [tradeReport({seqNum: 2, reportId: 'T1', lastPx: '12', possDup: true})]);
  const report = intake.snapshot().reports.T1;
  assert.equal(report.observations, 2);
  assert.equal(report.versions.length, 1);
  assert.deepEqual(intake.status().businessReports, ['T1']);
});

test('损坏报文被隔离记录，不影响同批其他消息落盘', async () => {
  const intake = new Intake(directory);
  const result = await intake.ingest('s1', ['not-a-fix', tradeReport({seqNum: 1, reportId: 'T1'})]);
  assert.equal(result.invalid, 1);
  assert.deepEqual(result.newBusinessReports, ['T1']);
  assert.equal(intake.status().events.at(-1).kind, 'invalid_message');
});
