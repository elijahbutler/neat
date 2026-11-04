// Runs in a job's proxy container: the only way out for the job's network steps. It tunnels CONNECT requests to
// the allowed hosts and refuses everything else. One line per decision goes to stdout for the job to read back.
import { lookup } from 'node:dns/promises';
import { connect, createServer, type Socket } from 'node:net';
import { decideConnect, decisionLog, isPublicAddress, MAX_HELLO_BYTES, parseClientHello, PROXY_PORT } from './egress';

const allowed = (process.env.NEAT_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
const MAX_HEAD = 8192;
// A client gets this long to send its request and then its TLS hello. After that the tunnel is just bytes.
const SETUP_MS = 20_000;
const log = decisionLog((line) => console.log(line));

/** Answer no and make sure this client can do nothing further: no more requests are read from it. */
function refuse(client: Socket, status: number, reason: string, target?: string): void {
  if (target) log('refused', target, reason);
  client.removeAllListeners('data');
  client.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${reason}\n`);
  // Read and drop whatever else the client sends, so the close completes.
  client.resume();
}

/** Drop a tunnel that was already answered with 200, where an HTTP reply would no longer be read as one. */
function drop(client: Socket, upstream: Socket, target: string, reason: string): void {
  log('refused', target, reason);
  client.removeAllListeners('data');
  client.destroy();
  upstream.destroy();
}

async function open(client: Socket, head: Buffer, headEnd: number, setup: ReturnType<typeof setTimeout>): Promise<void> {
  const decision = decideConnect(head.subarray(0, head.indexOf('\r\n')).toString('latin1'), allowed);
  if (!decision.ok) return refuse(client, decision.status, decision.reason, decision.target);
  const target = `${decision.host}:${decision.port}`;
  const answers = await lookup(decision.host, { family: 4, all: true }).catch(() => []);
  // Connect to the checked address, not the name, so a second DNS answer can't swap in a different one.
  const address = answers.map((a) => a.address).find(isPublicAddress);
  if (!address) return refuse(client, 403, answers.length ? 'host resolves to a private address' : 'host did not resolve', target);
  if (client.destroyed) return;
  const upstream = connect({ host: address, port: decision.port });
  let connected = false;
  upstream.on('error', () => (connected ? client.destroy() : refuse(client, 502, 'could not reach the host', target)));
  upstream.on('close', () => connected && client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
  upstream.once('connect', () => {
    connected = true;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Nothing reaches the host until the TLS hello names the same host the tunnel was opened for.
    let hello: Buffer = head.subarray(headEnd + 4);
    const onHello = (chunk?: Buffer) => {
      if (chunk) hello = Buffer.concat([hello, chunk]);
      if (hello.length > MAX_HELLO_BYTES) return drop(client, upstream, target, 'TLS hello too large');
      const parsed = parseClientHello(hello);
      if (parsed.kind === 'incomplete') return;
      if (parsed.kind === 'refused') return drop(client, upstream, target, parsed.reason);
      if (parsed.serverName !== decision.host) return drop(client, upstream, target, `TLS hello names ${parsed.serverName}`);
      clearTimeout(setup);
      client.off('data', onHello);
      log('allowed', target);
      upstream.write(hello);
      client.pipe(upstream);
      upstream.pipe(client);
    };
    client.on('data', onHello);
    client.resume();
    onHello();
  });
}

const server = createServer((client) => {
  let head = Buffer.alloc(0);
  const setup = setTimeout(() => client.destroy(), SETUP_MS);
  client.on('error', () => client.destroy());
  client.on('close', () => clearTimeout(setup));
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const headEnd = head.indexOf('\r\n\r\n');
    if (headEnd === -1 || headEnd > MAX_HEAD) {
      if (head.length > MAX_HEAD) refuse(client, 431, 'request head too large');
      return;
    }
    client.off('data', onData);
    client.pause();
    void open(client, head, headEnd, setup).catch(() => client.destroy());
  };
  client.on('data', onData);
});
// A step can open connections as fast as it likes. Past this many at once, new ones are closed unanswered.
server.maxConnections = 256;
server.listen(PROXY_PORT, '0.0.0.0', () => console.log(`listening ${PROXY_PORT}`));
