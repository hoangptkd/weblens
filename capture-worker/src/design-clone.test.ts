import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifySemanticRole,
  inferRouteTemplate,
  layoutFingerprint,
  normalizeDesignUrl,
  selectDesignPages,
  type DesignPageInput,
} from './design-clone.js'

test('normalizeDesignUrl bỏ fragment, tracking, slash cuối và sắp query ổn định', () => {
  assert.equal(
    normalizeDesignUrl('HTTPS://Example.COM:443/blog/?utm_source=x&b=2&a=1#top'),
    'https://example.com/blog?a=1&b=2',
  )
})

test('classifier giữ login, register và forgot-password thành ba semantic role', () => {
  assert.equal(classifySemanticRole('https://example.com/login'), 'AUTH_LOGIN')
  assert.equal(classifySemanticRole('https://example.com/register'), 'AUTH_REGISTER')
  assert.equal(classifySemanticRole('https://example.com/forgot-password'), 'AUTH_FORGOT_PASSWORD')
  assert.equal(classifySemanticRole('https://example.com/verify-email'), 'AUTH_VERIFY_OR_STATUS')
})

test('classifier nhận diện đầy đủ các semantic role theo URL và status', () => {
  const cases = [
    ['https://example.com/', 200, 'HOME'],
    ['https://example.com/features', 200, 'MARKETING_LANDING'],
    ['https://example.com/products', 200, 'PRODUCT_LIST'],
    ['https://example.com/products/widget', 200, 'PRODUCT_DETAIL'],
    ['https://example.com/pricing', 200, 'PRICING'],
    ['https://example.com/contact', 200, 'CONTACT'],
    ['https://example.com/download', 200, 'DOWNLOAD'],
    ['https://example.com/partners', 200, 'PARTNER'],
    ['https://example.com/affiliate', 200, 'AFFILIATE'],
    ['https://example.com/blog', 200, 'BLOG_INDEX'],
    ['https://example.com/blog/post', 200, 'BLOG_DETAIL'],
    ['https://example.com/use-cases', 200, 'USE_CASE_INDEX'],
    ['https://example.com/use-cases/teams', 200, 'USE_CASE_DETAIL'],
    ['https://example.com/vs/competitor', 200, 'COMPARISON_DETAIL'],
    ['https://example.com/privacy', 200, 'LEGAL_TEXT'],
    ['https://example.com/missing', 404, 'ERROR_4XX'],
    ['https://example.com/failure', 503, 'ERROR_5XX'],
    ['https://example.com/deep/unknown', 200, 'UNKNOWN'],
  ] as const
  for (const [url, status, expected] of cases) {
    assert.equal(classifySemanticRole(url, status), expected)
  }
})

test('100 blog detail cùng template chỉ chọn một candidate nhưng giữ blog index', () => {
  const pages = [page('blog-index', 'https://example.com/vi/blog')]
  for (let index = 0; index < 100; index++) {
    pages.push(page(`blog-${index}`, `https://example.com/vi/blog/post-${index}`))
  }
  const selection = selectDesignPages('https://example.com/vi/', pages)

  assert.equal(selection.selected.filter((value) => value.semanticRole === 'BLOG_INDEX').length, 1)
  assert.equal(selection.selected.filter((value) => value.semanticRole === 'BLOG_DETAIL').length, 1)
  assert.equal(selection.rejected.filter((value) => value.reason === 'SEMANTIC_TEMPLATE_DUPLICATE').length, 99)
})

test('locale khác, canonical duplicate và query variant không được chọn', () => {
  const canonical = page('canonical', 'https://example.com/vi/pricing')
  canonical.canonicalUrl = 'https://example.com/vi/pricing'
  const duplicate = page('canonical-copy', 'https://example.com/vi/pricing-copy')
  duplicate.canonicalUrl = 'https://example.com/vi/pricing'
  const selection = selectDesignPages('https://example.com/vi/', [
    page('root', 'https://example.com/vi/'),
    canonical,
    duplicate,
    page('query', 'https://example.com/vi/pricing?utm_source=mail'),
    { ...page('english', 'https://example.com/en/pricing'), htmlLang: 'en' },
  ])

  assert.equal(selection.locale, 'vi')
  assert.deepEqual(
    new Set(selection.rejected.map((value) => value.reason)),
    new Set(['ALTERNATE_LOCALE', 'CANONICAL_DUPLICATE', 'TRACKING_OR_QUERY_VARIANT']),
  )
})

test('locale có thể suy ra từ canonical hoặc hreflang self-reference', () => {
  const root = page('root', 'https://example.com/')
  root.htmlLang = ''
  root.canonicalUrl = '/vi/'
  const canonicalLocale = page('canonical-locale', 'https://example.com/pricing')
  canonicalLocale.htmlLang = ''
  canonicalLocale.canonicalUrl = '/vi/pricing'
  const hreflangLocale = page('hreflang-locale', 'https://example.com/contact')
  hreflangLocale.htmlLang = ''
  hreflangLocale.hreflang = [{ language: 'vi', url: '/contact' }]

  const selection = selectDesignPages('https://example.com/', [root, canonicalLocale, hreflangLocale])

  assert.equal(selection.locale, 'vi')
  assert.equal(selection.selected.length, 3)
  assert.ok(selection.selected.every((candidate) => candidate.locale === 'vi'))
})

test('canonical self-reference thắng duplicate dù URL dài hơn', () => {
  const canonical = page('canonical', 'https://example.com/vi/pricing-official')
  canonical.canonicalUrl = '/vi/pricing-official'
  const duplicate = page('duplicate', 'https://example.com/vi/price')
  duplicate.canonicalUrl = '/vi/pricing-official'

  const selection = selectDesignPages('https://example.com/vi/', [duplicate, canonical])

  assert.deepEqual(selection.selected.map((candidate) => candidate.page.id), ['canonical'])
  assert.equal(selection.rejected[0]?.reason, 'CANONICAL_DUPLICATE')
})

test('static structure khác giữ thêm candidate cùng role/template để fingerprint', () => {
  const first = page('first', 'https://example.com/blog/a')
  const second = { ...page('second', 'https://example.com/blog/b'), stylesheets: 4 }
  const selection = selectDesignPages('https://example.com/', [first, second])

  assert.equal(selection.selected.length, 2)
  assert.equal(inferRouteTemplate(first.url, 'BLOG_DETAIL'), '/blog/{slug}')
})

test('non-HTML, external origin, crawler policy skip và HTTP failure có reason ổn định', () => {
  const nonHtml = { ...page('pdf', 'https://example.com/report.pdf'), contentType: 'application/pdf' }
  const external = page('external', 'https://cdn.example.net/page')
  const policy = { ...page('policy', 'https://example.com/private'), outcome: 'warning' as const }
  const failure = { ...page('failure', 'https://example.com/broken'), outcome: 'failed' as const, statusCode: 0 }

  const selection = selectDesignPages('https://example.com/', [nonHtml, external, policy, failure])

  assert.deepEqual(
    new Set(selection.rejected.map((item) => item.reason)),
    new Set(['NON_HTML', 'EXTERNAL_ORIGIN', 'ROBOTS_OR_POLICY_BLOCKED', 'HTTP_FAILURE']),
  )
})

test('hard page ceiling dành một bounded manifest entry', () => {
  const selection = selectDesignPages('https://example.com/', [
    page('root', 'https://example.com/'),
    page('about', 'https://example.com/about'),
    page('pricing', 'https://example.com/pricing'),
  ], true)

  assert.equal(selection.rejected.filter((item) => item.reason === 'BUDGET_LIMITED').length, 1)
  assert.equal(selection.selected.length + selection.rejected.length, 3)
})

test('layout fingerprint bỏ text và id ngẫu nhiên nhưng giữ hierarchy/class/role', () => {
  const first = layoutFingerprint('<main id="user-1"><article class="card hero" role="region">Alice</article></main>')
  const sameLayout = layoutFingerprint('<main id="user-999"><article class="hero card" role="region">Bob</article></main>')
  const differentLayout = layoutFingerprint('<main><section><article class="card hero" role="region">Bob</article></section></main>')

  assert.equal(first, sameLayout)
  assert.notEqual(first, differentLayout)
})

function page(id: string, url: string): DesignPageInput {
  return {
    id,
    url,
    finalUrl: url,
    outcome: 'success',
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    canonicalUrl: '',
    htmlLang: url.includes('/vi/') ? 'vi' : 'en',
    hreflang: [],
    h1: ['Heading'],
    h2: [],
    schemaOrgTypes: ['WebPage'],
    scripts: 2,
    stylesheets: 1,
  }
}
