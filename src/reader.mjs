import {envelope as parseEnvelope} from './fix.mjs';

// 兼容入口：单帧校验与原件行结构保持不变，严格校验下沉到 fix.mjs。
export function envelope(encoded) {
  const parsed = parseEnvelope(encoded);
  return {fields: parsed.fields, raw: parsed.raw};
}

// 一次性采集（保留旧契约）；持续收件与补发协作见 runner.mjs / intake.mjs。
export async function collect(client) {
  const session = await client('/logon', {method: 'POST', body: {sender: 'LOCAL', target: 'PARTNER'}});
  const response = await client(`/messages?session=${encodeURIComponent(session.sessionEpoch)}`);
  return response.items.map((item, index) => ({
    id: `${session.sessionEpoch}:${index}`,
    session: session.sessionEpoch,
    ...envelope(item),
  }));
}
