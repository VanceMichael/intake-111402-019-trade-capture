import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect,envelope} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('原始 FIX 字段保留重复和顺序', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].session, 's1');
  assert.equal(rows[0].fields[0][1], 'FIX.4.4');
  assert.throws(() => envelope('eA=='), /invalid FIX/);
});
