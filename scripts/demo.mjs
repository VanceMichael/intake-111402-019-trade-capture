import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive);
try {
  console.log('本地来源',source.origin);
  const rows = await collect(createClient(source.origin));
  console.log('实际收件',JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'current'})));
  const response = await fetch(`${api.origin}/records`);
  console.log('查询原始结果',await response.text());
  console.log('来源交互',JSON.stringify(await createClient(source.origin)('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
