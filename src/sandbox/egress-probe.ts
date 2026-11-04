// Used by the container tests only. Runs inside a container and reports, as JSON, what it can reach: directly,
// by asking the job proxy for a tunnel, and with an ordinary fetch. Targets come in as comma separated host:port.
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface ProbeReport {
  /** 'connected' or the error code, per target. */
  direct: Record<string, string>;
  /** The proxy's status line and reason, per target. Empty when there is no proxy. */
  tunnel: Record<string, string>;
  /** 'handshake' or 'closed', per "host|server name" pair. */
  handshake: Record<string, string>;
  /** The HTTP status, or 'failed', per URL. */
  fetched: Record<string, string>;
  /** The address a name resolved to inside the container, or the error code. */
  dns: Record<string, string>;
}

const list = (name: string) => (process.env[name] ?? '').split(',').filter(Boolean);
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;

function direct(target: string): Promise<string> {
  const at = target.lastIndexOf(':');
  return new Promise((resolve) => {
    const socket = connect({ host: target.slice(0, at), port: Number(target.slice(at + 1)), timeout: 3000 });
    const done = (result: string) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done('connected'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
  });
}

function tunnel(target: string): Promise<string> {
  return new Promise((resolve) => {
    if (!proxy) return resolve('no proxy');
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port), timeout: 10_000 });
    let reply = '';
    const done = (result: string) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', (chunk) => {
      reply += chunk.toString('latin1');
      if (!reply.includes('\r\n\r\n')) return;
      const status = reply.split(' ')[1] ?? 'unknown';
      done(`${status} ${reply.slice(reply.indexOf('\r\n\r\n') + 4).trim()}`.trim());
    });
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'error'));
    socket.once('close', () => done(reply ? reply.split('\r\n')[0]! : 'closed'));
  });
}

/**
 * A TLS handshake with `host` on 443 that names `serverName` in its hello, through the proxy when there is one.
 * 'handshake' when the far end answered it, 'closed' when the connection ended first. An empty name sends no name.
 */
function handshake(pair: string): Promise<string> {
  const [host = '', serverName = ''] = pair.split('|');
  return new Promise((resolve) => {
    const socket = proxy ? connect({ host: proxy.hostname, port: Number(proxy.port) }) : connect({ host, port: 443 });
    const timer = setTimeout(() => done('timeout'), 10_000);
    const done = (result: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const startTls = () => {
      // Certificate checks are off on purpose, in this test probe only: the question is whether a handshake that
      // names the wrong site gets through at all, and with checks on it would fail for a different reason.
      const secure = tlsConnect({ socket, servername: serverName || undefined, rejectUnauthorized: false });
      secure.once('secureConnect', () => done('handshake'));
      secure.once('error', () => done('closed'));
      secure.once('close', () => done('closed'));
    };
    socket.once('error', () => done('closed'));
    socket.once('close', () => done('closed'));
    socket.once('connect', () => {
      if (!proxy) return startTls();
      let reply = '';
      const onData = (chunk: Buffer) => {
        reply += chunk.toString('latin1');
        if (!reply.includes('\r\n\r\n')) return;
        socket.off('data', onData);
        if (reply.startsWith('HTTP/1.1 200')) startTls();
        else done(`refused ${reply.split(' ')[1] ?? ''}`);
      };
      socket.on('data', onData);
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
  });
}

const report: ProbeReport = { direct: {}, tunnel: {}, handshake: {}, fetched: {}, dns: {} };
for (const pair of list('PROBE_HANDSHAKE')) report.handshake[pair] = await handshake(pair);
for (const target of list('PROBE_DIRECT')) report.direct[target] = await direct(target);
for (const target of list('PROBE_TUNNEL')) report.tunnel[target] = await tunnel(target);
for (const url of list('PROBE_FETCH')) report.fetched[url] = await fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => String(r.status), () => 'failed');
for (const name of list('PROBE_DNS')) report.dns[name] = await lookup(name).then((a) => a.address, (error: NodeJS.ErrnoException) => error.code ?? 'error');
console.log(JSON.stringify(report));
