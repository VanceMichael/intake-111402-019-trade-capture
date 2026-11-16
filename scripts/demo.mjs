import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {Archive} from '../src/archive.mjs';
import {Intake} from '../src/intake.mjs';
import {runIntake} from '../src/runner.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await createSource({scenario: process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const intake = new Intake(directory);
const api = await createApi(archive, 0, intake);
const client = createClient(source.origin);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  console.log('本地来源', source.origin, '查询服务', api.origin);

  const run = async scenario => {
    if (scenario) await client('/__scenario', {method: 'POST', body: {name: scenario}});
    const status = await runIntake(createClient(source.origin), intake, {
      interval: 10, idleRounds: 1, sleep,
      onBatch: result => console.log(`${scenario ?? 'normal'} 批次`, JSON.stringify(result)),
    });
    const session = Object.values(status.sessions).at(-1);
    console.log(`${scenario ?? 'normal'} 会话`, JSON.stringify({
      epoch: session.epoch,
      已收序号: session.receivedSeqNums,
      GapFill跳过: session.gapFilled,
      待补区间: session.pendingGapRanges,
      补发请求: session.resends,
    }));
  };

  await run('normal');
  // 网络抖动：再跑一轮，来源重复发放同样的报文，业务身份不应新增成交。
  await run(null);
  await run('gap-and-resend');
  await run('reset');

  const status = intake.status();
  console.log('业务回报身份', JSON.stringify(status.businessReports));
  console.log('更正关系', JSON.stringify({已关联: status.resolvedLinks, 待关联: status.pendingLinks}));
  const response = await fetch(`${api.origin}/status`);
  console.log('查询 /status', await response.text());
  console.log('来源审计（含真实补发请求）', JSON.stringify((await client('/__audit')).requests
    .filter(request => request.path === '/resend')));
} finally {
  await Promise.all([source.close(), api.close()]);
  await rm(directory, {recursive: true, force: true});
}
