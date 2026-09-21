import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase()
  if (isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number)
    const first = parts[0] ?? -1
    const second = parts[1] ?? -1
    return first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 100 && second >= 64 && second <= 127)
  }
  if (isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
      || normalized.startsWith('fd') || normalized.startsWith('fe8')
      || normalized.startsWith('fe9') || normalized.startsWith('fea')
      || normalized.startsWith('feb') || normalized.startsWith('ff')
  }
  return true
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
  const normalized = hostname.toLowerCase()
  const direct = isIP(normalized)
  const addresses = direct ? [normalized] : await lookup(normalized, { all: true })
    .then((results) => results.map(({ address }) => address))
    .catch(() => [])
  if (addresses.length === 0) throw new Error('DNS_FAILED')
  if (addresses.some(isPrivateAddress)) throw new Error('SSRF_BLOCKED')
  return addresses
}
