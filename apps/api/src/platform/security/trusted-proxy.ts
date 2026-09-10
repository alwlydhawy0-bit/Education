/**
 * How `request.ip` is derived when the server sits behind a load balancer.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECURITY FILE AND NOT A CONFIGURATION DETAIL
 * ---------------------------------------------------------------------------
 *
 * `request.ip` is the key of every IP-scoped rate limit on this platform and
 * the `ip` field of every security event in the audit trail. Both of those are
 * controls, and both of them are only as trustworthy as this setting.
 *
 * There are exactly two ways to get it wrong, and they fail in OPPOSITE
 * directions:
 *
 *   TOO LITTLE TRUST. Deploy behind a proxy with `trustProxy` off and every
 *   request appears to come from the proxy's address. Per-IP rate limiting
 *   silently becomes ONE GLOBAL BUCKET — the first thirty learners in the
 *   country exhaust the login limit for everybody, and an attacker is
 *   indistinguishable from a classroom. The audit trail records the load
 *   balancer as the source of every attack.
 *
 *   TOO MUCH TRUST. Set `trustProxy: true` — Fastify's blanket mode — and the
 *   LAST value of `X-Forwarded-For` is believed unconditionally. That header is
 *   client-supplied. Any attacker sends a new random address on every request
 *   and rate limiting stops existing: no bucket ever reaches its limit because
 *   no two requests share a key. The audit trail fills with addresses the
 *   attacker chose.
 *
 * Blanket trust is the worse of the two, because the first failure is loud
 * (users complain) and the second is silent (the control reports success while
 * enforcing nothing). So this module REFUSES the value `true` outright, in
 * every environment, and accepts exactly one working form:
 *
 *   an ADDRESS LIST — "believe the forwarding header only when the immediate
 *                     peer is one of these". Bounded by something the attacker
 *                     does not control, because the peer address is the socket's
 *                     and not the payload's.
 *
 * ---------------------------------------------------------------------------
 * WHY A HOP COUNT IS REFUSED, WHICH IS NOT THE OBVIOUS ANSWER
 * ---------------------------------------------------------------------------
 *
 * "There are two proxies in front of me, take the third address from the right"
 * is the form every deployment guide reaches for, Express supports it, and this
 * module was first written to accept it. It is refused because of what Fastify
 * 5 ACTUALLY DOES with it — `lib/request.js`, `getTrustProxyFn`:
 *
 *     if (typeof tp === 'number') {
 *       // Hop-count-only trust cannot validate the immediate peer. Fail closed
 *       return function () { return false }
 *     }
 *
 * A numeric setting trusts NOTHING. The server accepts the configuration, boots
 * cleanly, reports the hop count in its own log line, and then behaves exactly
 * as if `trustProxy` were off: every request keyed to the load balancer, per-IP
 * rate limiting collapsed into one global bucket, every security event
 * attributed to the proxy. It is the first failure mode above, arrived at by
 * configuring the thing meant to prevent it.
 *
 * Accepting a value whose effect is the opposite of its name would make this
 * module a source of the exact confusion it exists to remove, so the parser
 * refuses it and the message says what to write instead.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS PURE
 * ---------------------------------------------------------------------------
 *
 * It parses and validates a string and returns what Fastify wants. It reads no
 * environment, opens no socket, and imports nothing. That is what lets the
 * whole decision table be a unit test rather than a boot-time experiment.
 */

/** What Fastify's `trustProxy` option accepts, narrowed to the safe forms. */
export type TrustProxySetting = false | readonly string[];

/** The literal a well-meaning operator reaches for, and the one that is unsafe. */
export const BLANKET_TRUST_REFUSAL =
  'TRUST_PROXY must not be "true": blanket proxy trust believes a client-supplied ' +
  'X-Forwarded-For, which lets any caller choose their own rate-limit bucket and their own ' +
  'audit-trail address. Name the proxy instead, as an address or CIDR range ' +
  '(e.g. "10.0.0.0/8" or "loopback").';

/**
 * A hop count is accepted by Fastify's type and then implemented as "trust
 * nothing". See the header — this is the interesting refusal of the two.
 */
export const HOP_COUNT_REFUSAL =
  'TRUST_PROXY does not accept a hop count: Fastify 5 compiles a numeric setting to a function ' +
  'that trusts no peer at all, so the server would boot reporting proxy trust while keying every ' +
  'request to the load balancer. Name the proxy instead, as an address or CIDR range ' +
  '(e.g. "10.0.0.0/8" or "loopback").';

/**
 * IPv4 address, IPv4 CIDR, IPv6 address, or IPv6 CIDR.
 *
 * Deliberately a SHAPE check rather than a parser. Fastify hands the list to
 * `proxy-addr`, which does the real interpretation; the job here is to reject
 * the things that would be silently ignored by it — a hostname, an empty
 * string, a stray quote — at boot rather than at the first request. A value
 * that passes here and is still rejected downstream fails loudly at startup,
 * which is the outcome this whole module is arranged around.
 */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;
const IPV6 = /^[0-9a-f:]+(?:\/\d{1,3})?$/i;
/** Names `proxy-addr` understands natively. */
const NAMED_RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isAddressLike(token: string): boolean {
  if (NAMED_RANGES.has(token)) return true;
  if (IPV4.test(token)) {
    const [address, prefix] = token.split('/');
    const octets = (address ?? '').split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
    if (prefix !== undefined && (Number(prefix) < 0 || Number(prefix) > 32)) return false;
    return true;
  }
  if (IPV6.test(token) && token.includes(':')) {
    const prefix = token.split('/')[1];
    if (prefix !== undefined && (Number(prefix) < 0 || Number(prefix) > 128)) return false;
    return true;
  }
  return false;
}

/**
 * Parse the configured value into the setting Fastify is given.
 *
 * Throws — it does not fall back to a default. A misconfigured proxy setting is
 * a broken security control, and the only place a broken security control costs
 * nothing is at startup.
 */
export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false') return false;

  // Checked before anything else, so the message an operator sees explains the
  // refusal rather than complaining that "true" is not an address.
  if (value.toLowerCase() === 'true') throw new Error(BLANKET_TRUST_REFUSAL);

  if (/^\d+$/.test(value)) throw new Error(HOP_COUNT_REFUSAL);

  const tokens = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (tokens.length === 0) throw new Error(BLANKET_TRUST_REFUSAL);

  const invalid = tokens.filter((t) => !isAddressLike(t));
  if (invalid.length > 0) {
    throw new Error(
      `TRUST_PROXY contains values that are not addresses or CIDR ranges: ${invalid.join(', ')}. ` +
        'Hostnames are not accepted — a name resolves at runtime and the resolution is not a ' +
        'thing this server controls.',
    );
  }
  return tokens;
}

/** True when the setting means "derive the address from a forwarding header". */
export function trustsAProxy(setting: TrustProxySetting): boolean {
  return setting !== false;
}

/**
 * A one-line description for the boot record. Never the address list itself —
 * an internal subnet is topology, and topology is reconnaissance.
 */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === false) return 'direct (no forwarding header is believed)';
  return `address list (${setting.length} ${setting.length === 1 ? 'entry' : 'entries'})`;
}
