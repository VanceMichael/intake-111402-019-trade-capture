export function envelope(encoded) {
  const bytes = Buffer.from(encoded,'base64');
  const fields = bytes.toString('ascii').split('').filter(Boolean);
  if (!fields[0]?.startsWith('8=FIX.4.4') || !fields.at(-1)?.startsWith('10=')) throw new Error('invalid FIX envelope');
  return {fields:fields.map(field => {const index = field.indexOf('=');return [field.slice(0,index),field.slice(index+1)];}),raw:encoded};
}
export async function collect(client) {
  const session = await client('/logon', {method:'POST',body:{sender:'LOCAL',target:'PARTNER'}});
  const response = await client(`/messages?session=${session.sessionEpoch}`);
  return response.items.map((item,index) => ({id:`${session.sessionEpoch}:${index}`,session:session.sessionEpoch,...envelope(item)}));
}
