import { createHash } from 'node:crypto';

const clients = new Set();
const websocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(payload, opcode = 0x1) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function handleClientFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const extended = client.buffer.readBigUInt64BE(2);
      if (extended > 1024n * 1024n) return client.socket.destroy();
      length = Number(extended);
      offset = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskOffset = offset;
    if (masked) offset += 4;
    if (client.buffer.length < offset + length) return;
    const opcode = first & 0x0f;
    const mask = masked ? client.buffer.subarray(maskOffset, maskOffset + 4) : null;
    const payload = Buffer.from(client.buffer.subarray(offset, offset + length));
    if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
    client.buffer = client.buffer.subarray(offset + length);
    if (opcode === 0x8) {
      client.socket.end(frame(payload, 0x8));
      return;
    }
    if (opcode === 0x9) client.socket.write(frame(payload, 0xA));
  }
}

export function attachRealtime(server, authenticate, allowedOrigins = []) {
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url, 'http://localhost');
    const origin = request.headers.origin;
    const key = request.headers['sec-websocket-key'];
    Promise.resolve().then(async () => {
      const userId = await authenticate(request);
      if (socket.destroyed) return;
      if (url.pathname !== '/api/realtime' || !userId || !key || !allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(key + websocketGuid).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const client = { socket, userId, buffer: Buffer.alloc(0) };
      clients.add(client);
      socket.on('data', chunk => handleClientFrames(client, chunk));
      socket.on('close', () => clients.delete(client));
      socket.on('error', () => clients.delete(client));
      socket.write(frame(JSON.stringify({ type: 'connected' })));
    }).catch(() => {
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
      }
    });
  });

  return (userIds, event) => {
    const recipients = new Set(userIds.filter(Boolean));
    const message = frame(JSON.stringify(event));
    for (const client of clients) {
      if (recipients.has(client.userId) && !client.socket.destroyed) client.socket.write(message);
    }
  };
}
