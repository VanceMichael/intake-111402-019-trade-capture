import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {Archive} from './archive.mjs';
import {Intake} from './intake.mjs';
import {runIntake} from './runner.mjs';
import {createApi} from './api.mjs';

const dataDir = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port: Number(process.env.SOURCE_PORT ?? 4010), scenario: process.env.SCENARIO ?? 'normal'});
const archive = new Archive(dataDir);
const intake = new Intake(dataDir);
const api = await createApi(archive, Number(process.env.PORT ?? 4020), intake);
console.log(JSON.stringify({source: source.origin, api: api.origin}));

const client = createClient(source.origin);
const controller = new AbortController();

// 兼容一次性格式的原件归档：传输身份 epoch:seqNum 稳定，重复领取天然幂等。
// provenance 不随来源端口变化，重启后同一原件不会因来源地址不同而重复归档。
const onBatch = async result => {
  const snapshot = intake.status().sessions[result.epoch];
  const rows = snapshot.receivedSeqNums.map(seqNum => ({
    id: `${result.epoch}:${seqNum}`,
    session: result.epoch,
    seqNum,
  }));
  if (rows.length) {
    const archived = await archive.put(rows, {adapter: 'intake', session: result.epoch});
    console.log(JSON.stringify({ingest: result, archive: archived}));
  } else {
    console.log(JSON.stringify({ingest: result}));
  }
};

runIntake(client, intake, {signal: controller.signal, onBatch}).catch(error => console.error(error.message));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  controller.abort();
  await Promise.all([source.close(), api.close()]);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
