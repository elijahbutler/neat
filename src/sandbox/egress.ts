// The rules the job proxy applies. Kept free of I/O so the same code is unit tested and bundled into the proxy.

/**
 * The hosts a network step may reach, on port 443 only. Add a host only when a real install needs it, with the reason.
 * - registry.npmjs.org: packages for npm, pnpm and bun, and corepack's download of pnpm.
 * - registry.yarnpkg.com: the registry Yarn 1 uses by default and writes into yarn.lock.
 * - repo.yarnpkg.com: where corepack downloads Yarn 2 and later.
 */
export const REGISTRY_HOSTS: readonly string[] = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com'];

export const PROXY_PORT = 3128;

export type ProxyDecision = { ok: true; host: string; port: number } | { ok: false; status: number; reason: string; target?: string };

/**
 * Decide on the first line of a proxy request. Only `CONNECT host:443` for a listed host passes. Plain HTTP
 * requests, other ports, and addresses in place of names are all refused.
 */
export function decideConnect(requestLine: string, allowedHosts: readonly string[]): ProxyDecision {
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine.trim());
  if (!match) return { ok: false, status: 400, reason: 'not a proxy request' };
  const [, method, target] = match as unknown as [string, string, string];
  if (method !== 'CONNECT') return { ok: false, status: 403, reason: 'only CONNECT is allowed', target };
  const split = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target);
  if (!split) return { ok: false, status: 403, reason: 'target is not a host name and port', target };
  const host = split[1]!.toLowerCase().replace(/\.$/, '');
  const port = Number(split[2]);
  if (port !== 443) return { ok: false, status: 403, reason: 'only port 443 is allowed', target };
  if (!allowedHosts.some((allowed) => allowed.toLowerCase() === host)) return { ok: false, status: 403, reason: 'host is not on the allowlist', target };
  return { ok: true, host, port };
}

export const MAX_LOG_LINES = 200;
const MAX_LOG_LINE = 400;

/**
 * The proxy's decision log. A step chooses how often it asks and what it asks for, so the log has a fixed size:
 * at most MAX_LOG_LINES decisions, each cut to a bounded length and to one line, then one closing line, then nothing.
 */
export function decisionLog(write: (line: string) => void): (verdict: 'allowed' | 'refused', target: string, reason?: string) => void {
  let lines = 0;
  return (verdict, target, reason = '') => {
    if (lines > MAX_LOG_LINES) return;
    lines += 1;
    if (lines > MAX_LOG_LINES) return write('log limit reached, later decisions are not listed');
    write(`${verdict} ${target} ${reason}`.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_LOG_LINE));
  };
}

/** The longest first TLS record the proxy will hold: a 5 byte header and the largest payload TLS allows. */
export const MAX_HELLO_BYTES = 5 + 16384;

export type HelloResult = { kind: 'ok'; serverName: string } | { kind: 'incomplete' } | { kind: 'refused'; reason: string };

/**
 * Read the server name out of the first bytes a client sends through a tunnel. The CONNECT line says where the
 * tunnel goes, but on a shared CDN the name inside the TLS hello picks the site, so the proxy holds the tunnel
 * until this name is known and equal to the CONNECT host.
 *
 * Anything that is not one whole ClientHello in one record with exactly one host name is refused: no name, two
 * names, a hello split across records, an encrypted hello (which hides the real name behind a cover name), or
 * bytes that are not TLS. 'incomplete' means the record has not all arrived yet.
 *
 * What this cannot see: the HTTP Host header, which is sent after the handshake and encrypted. A client can name
 * an allowed host here and ask for another site inside. Only the server can refuse that.
 *
 * Also not checked: a second ClientHello after a HelloRetryRequest. TLS 1.3 requires it to carry the same name,
 * and enforcing that is the server's job.
 *
 * So the allowlist narrows where install code can send data but does not close it; an allowed registry accepts
 * uploads anyway. What keeps a step away from the host and other containers is the closed network, not this check.
 */
export function parseClientHello(bytes: Uint8Array): HelloResult {
  const refused = (reason: string): HelloResult => ({ kind: 'refused', reason });
  if (bytes.length < 5) return bytes.length && bytes[0] !== 0x16 ? refused('not a TLS handshake') : { kind: 'incomplete' };
  if (bytes[0] !== 0x16 || bytes[1] !== 0x03) return refused('not a TLS handshake');
  const recordLength = (bytes[3]! << 8) | bytes[4]!;
  if (recordLength < 4 || recordLength > 16384) return refused('bad TLS record length');
  if (bytes.length < 5 + recordLength) return { kind: 'incomplete' };

  const record = bytes.subarray(5, 5 + recordLength);
  if (record[0] !== 0x01) return refused('first TLS message is not a ClientHello');
  const helloLength = (record[1]! << 16) | (record[2]! << 8) | record[3]!;
  if (helloLength + 4 !== record.length) return refused('ClientHello does not fit one record exactly');
  const hello = record.subarray(4);

  // Every read checks the bounds, so a length field that points past the end is a refusal, not a guess.
  let at = 0;
  let bad = false;
  const take = (count: number): Uint8Array => {
    if (bad || count < 0 || at + count > hello.length) {
      bad = true;
      return new Uint8Array(0);
    }
    at += count;
    return hello.subarray(at - count, at);
  };
  const u8 = () => take(1)[0] ?? 0;
  const u16 = () => {
    const pair = take(2);
    return ((pair[0] ?? 0) << 8) | (pair[1] ?? 0);
  };
  take(2 + 32); // version and random
  take(u8()); // session id
  take(u16()); // cipher suites
  take(u8()); // compression methods
  const extensionsLength = u16();
  if (bad || at + extensionsLength !== hello.length) return refused('malformed ClientHello');

  let serverName: string | null = null;
  while (at < hello.length) {
    const type = u16();
    const body = take(u16());
    if (bad) return refused('malformed ClientHello');
    // encrypted_client_hello, and the older encrypted_server_name it replaced.
    if (type === 0xfe0d || type === 0xffce) return refused('encrypted ClientHello is not allowed');
    if (type !== 0) continue;
    if (serverName !== null) return refused('more than one server name');
    // A list length, then one entry: type 0 (host name), a length, and the name. Exactly one entry is accepted.
    if (body.length < 5) return refused('malformed server name');
    const listLength = (body[0]! << 8) | body[1]!;
    const nameLength = (body[3]! << 8) | body[4]!;
    if (listLength !== body.length - 2 || body[2] !== 0 || nameLength !== body.length - 5 || nameLength === 0) return refused('malformed server name');
    const name = new TextDecoder('latin1').decode(body.subarray(5));
    if (!/^[A-Za-z0-9.-]+$/.test(name)) return refused('malformed server name');
    serverName = name.toLowerCase();
  }
  return serverName === null ? refused('no server name') : { kind: 'ok', serverName };
}

// Ranges that are never a public registry: this network, private, shared, loopback, link-local (which holds the
// cloud metadata address 169.254.169.254), protocol and documentation blocks, benchmarking, multicast and reserved.
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
];

function v4ToNumber(address: string): number | null {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!parts) return null;
  const bytes = parts.slice(1).map(Number);
  if (bytes.some((b) => b > 255)) return null;
  return ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
}

/**
 * True only for an IPv4 address outside every blocked range. The proxy connects over IPv4 only, so anything that
 * is not plain dotted IPv4, including every IPv6 form, is refused instead of parsed.
 */
export function isPublicAddress(address: string): boolean {
  const value = v4ToNumber(address);
  if (value === null) return false;
  return !BLOCKED_V4.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (v4ToNumber(base)! & mask) >>> 0;
  });
}
