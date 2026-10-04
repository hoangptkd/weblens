import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

const blockedAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
] as const) blockedAddresses.addSubnet(address, prefix, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? ''
  const family = isIP(normalized)
  if (!family) return true
  // Node's BlockList also matches IPv4-mapped IPv6 against IPv4 subnets.
  return blockedAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6')
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('URL_POLICY_REJECTED')
  }
  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('SSRF_BLOCKED')
  }
  await resolvePublicAddresses(hostname)
  return parsed
}

export async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  const lower = hostname.toLowerCase()
  const normalized = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
  const direct = isIP(normalized)
  const addresses = direct ? [normalized] : await lookup(normalized, { all: true })
    .then((results) => results.map(({ address }) => address))
    .catch(() => [])
  if (addresses.length === 0) throw new Error('DNS_FAILED')
  if (addresses.some(isPrivateAddress)) throw new Error('SSRF_BLOCKED')
  return addresses
}
