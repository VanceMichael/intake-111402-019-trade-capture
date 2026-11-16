import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {Intake} from '../src/intake.mjs';
import {runIntake} from '../src/runner.mjs';
import {createApi} from '../src/api.mjs';
import {Archive} from '../src/archive.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('端到端：持续收件、缺号补发协作、会话重置隔离', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-e2e-'));
  const source = await createSource();
  const intake = new Intake(directory);
  const archive = new Archive(directory);
  const api = await createApi(archive, 0, intake);
  try {
    const client = createClient(source.origin);

    // normal：T1、T2 两笔成交。
    let status = await runIntake(createClient(source.origin), intake, {interval: 5, idleRounds: 1, sleep});
    assert.deepEqual(status.sessions.s1.receivedSeqNums, [1, 2]);
    assert.deepEqual(status.businessReports, ['T1', 'T2']);

    // 重复轮询不新增成交（网络抖动重复领取）。
    await runIntake(createClient(source.origin), intake, {interval: 5, idleRounds: 1, sleep});
    status = intake.status();
    assert.equal(status.businessReports.length, 2);
    assert.deepEqual(status.sessions.s1.receivedSeqNums, [1, 2]);

    // gap-and-resend：来源同时给出缺号、PossDup 重送与 GapFill 管理消息。
    await client('/__scenario', {method: 'POST', body: {name: 'gap-and-resend'}});
    status = await runIntake(createClient(source.origin), intake, {interval: 5, idleRounds: 1, sleep});
    const session = status.sessions.s1;
    assert.deepEqual(session.receivedSeqNums, [1, 2, 3, 4]);
    // 35=4 GapFill 不产生业务回报；T2 重送不新增成交；T3 为新业务身份。
    assert.deepEqual(status.businessReports, ['T1', 'T2', 'T3']);
    assert.ok(session.gapFilled.some(range => range.newSeqNo === 4));
    // GapFill 已解释传输跳过，来源不遗留待补缺口。
    assert.deepEqual(session.pendingGapRanges, []);

    // reset：新 sessionEpoch 独立编号，旧会话视图保持不变。
    await client('/__scenario', {method: 'POST', body: {name: 'reset'}});
    status = await runIntake(createClient(source.origin), intake, {interval: 5, idleRounds: 1, sleep});
    assert.deepEqual(status.sessions.s2.receivedSeqNums, [1]);
    assert.equal(status.sessions.s2.nextExpectedSeqNum, 2);
    assert.equal(status.sessions.s1.nextExpectedSeqNum, 5);
    // s2 的 T4 引用 s1 的 T1，跨会话更正关系已关联。
    assert.ok(status.resolvedLinks.some(link => link.reportId === 'T4' && link.refId === 'T1'));

    // 查询服务如实汇报三层状态；原件归档仍可用。
    const httpStatus = await (await fetch(`${api.origin}/status`)).json();
    assert.deepEqual(Object.keys(httpStatus.sessions).sort(), ['s1', 's2']);
    assert.deepEqual(httpStatus.businessReports, ['T1', 'T2', 'T3', 'T4']);
    const health = await (await fetch(`${api.origin}/health`)).json();
    assert.equal(health.status, 'ok');
  } finally {
    await Promise.all([source.close(), api.close()]);
    await rm(directory, {recursive: true, force: true});
  }
});

test('丢件导致真实缺号时，先持久化补发意图再请求 /resend，且只请求一次', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-resend-'));
  const source = await createSource();
  const intake = new Intake(directory);
  const resendCalls = [];
  try {
    const inner = createClient(source.origin);
    await inner('/__scenario', {method: 'POST', body: {name: 'gap-and-resend'}});
    // 模拟网络抖动：过滤掉序号 2 的原始回报与它的 PossDup 重送，
    // 但保留序号 3 的 GapFill 与序号 4，让缺号 2 可被检测且不被 GapFill 解释。
    const flakyClient = async (path, request) => {
      const response = await inner(path, request);
      if (path.startsWith('/messages')) {
        response.items = response.items.filter(encoded =>
          !Buffer.from(encoded, 'base64').toString('ascii').includes('34=2\u0001'));
      }
      if (path === '/resend') resendCalls.push(request.body);
      return response;
    };
    const status = await runIntake(flakyClient, intake, {interval: 5, idleRounds: 2, sleep});
    // 序号 2 被抖动过滤：恢复位置停在 2，待补缺口与补发请求都已持久化。
    assert.equal(status.sessions.s1.nextExpectedSeqNum, 2);
    assert.deepEqual(status.sessions.s1.pendingGapRanges, [[2, 2]]);
    assert.deepEqual(resendCalls, [{begin: 2, end: 2}]);
    assert.deepEqual(status.sessions.s1.resends.map(({begin, end, accepted}) =>
      ({begin, end, accepted})), [{begin: 2, end: 2, accepted: true}]);

    // 来源审计能看到适配器发出的真实补发请求。
    const audit = await inner('/__audit');
    assert.ok(audit.requests.some(entry =>
      entry.path === '/resend' && entry.body.begin === 2 && entry.body.end === 2));
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('补发请求发送失败时不伪造成功，意图与缺口仍持久化可观察', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-resend-fail-'));
  const source = await createSource();
  const intake = new Intake(directory);
  try {
    const inner = createClient(source.origin);
    await inner('/__scenario', {method: 'POST', body: {name: 'gap-and-resend'}});
    const failingClient = async (path, request) => {
      if (path === '/resend') throw new Error('connection reset');
      const response = await inner(path, request);
      if (path.startsWith('/messages')) {
        response.items = response.items.filter(encoded =>
          !Buffer.from(encoded, 'base64').toString('ascii').includes('34=2\u0001'));
      }
      return response;
    };
    const status = await runIntake(failingClient, intake, {interval: 5, idleRounds: 1, sleep});
    // 缺口与补发意图都在，但没有 accepted 结论，绝不谎报已补齐。
    assert.deepEqual(status.sessions.s1.pendingGapRanges, [[2, 2]]);
    assert.deepEqual(status.sessions.s1.resends.map(({begin, end}) => [begin, end]), [[2, 2]]);
    assert.equal(status.sessions.s1.resends[0].accepted, undefined);

    const reloaded = new Intake(directory);
    await reloaded.load();
    assert.deepEqual(reloaded.status().sessions.s1.pendingGapRanges, [[2, 2]]);
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('未接入 intake 时 /status 不伪造成功状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intake-api-'));
  const api = await createApi(new Archive(directory));
  try {
    const response = await fetch(`${api.origin}/status`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'intake not configured');
  } finally {
    await api.close();
    await rm(directory, {recursive: true, force: true});
  }
});
