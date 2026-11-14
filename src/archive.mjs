import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open} from 'node:fs/promises';
import {join} from 'node:path';

export class Archive {
  constructor(directory) { this.directory = directory; this.serial = Promise.resolve(); }
  async list() {
    try {return JSON.parse(await readFile(join(this.directory,'records.json'),'utf8'));}
    catch(error) {if(error.code === 'ENOENT') return [];throw error;}
  }
  put(rows, provenance) {
    const operation = this.serial.then(async () => {
      if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || !row.id)) throw new Error('record id required');
      await mkdir(this.directory,{recursive:true});
      const current = await this.list();
      const known = new Set(current.map(entry => entry.digest));
      let added = 0;
      for (const row of rows) {
        const digest = createHash('sha256').update(JSON.stringify({row,provenance})).digest('hex');
        if (!known.has(digest)) {current.push({row,provenance,digest});known.add(digest);added++;}
      }
      const temporary = join(this.directory,`${randomUUID()}.tmp`);
      await writeFile(temporary,JSON.stringify(current,null,2)+'\n');
      const handle = await open(temporary,'r');
      try {await handle.sync();} finally {await handle.close();}
      await rename(temporary,join(this.directory,'records.json'));
      return {added,total:current.length};
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
}
