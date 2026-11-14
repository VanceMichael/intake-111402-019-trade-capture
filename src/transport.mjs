export class SourceError extends Error {
  constructor(status, data) { super(`source HTTP ${status}: ${JSON.stringify(data)}`); this.status = status; this.data = data; }
}
export function createClient(origin, options = {}) {
  const base = new URL(origin);
  if (!['localhost','127.0.0.1','[::1]'].includes(base.hostname)) throw new Error('local source required');
  const fetcher = options.fetcher ?? fetch;
  return async (path, request = {}) => {
    const target = new URL(path, base);
    if (target.origin !== base.origin) throw new Error('foreign source URL');
    const response = await fetcher(target, {method:request.method ?? 'GET',redirect:'error',
      headers:{'content-type':'application/json'},body:request.body === undefined ? undefined : JSON.stringify(request.body),
      signal:AbortSignal.timeout(options.timeout ?? 3000)});
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > (options.maxBytes ?? 2097152)) throw new Error('response exceeds budget');
    const data = JSON.parse(bytes.toString('utf8'));
    if (!response.ok) throw new SourceError(response.status, data);
    return data;
  };
}
