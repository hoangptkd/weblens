import type { PageSnapshot, ScanPageRecord } from '../domain/types'

export const scanPages: ScanPageRecord[] = [
  {
    id: 'page-home',
    scanId: 'scan-103',
    path: '/',
    url: 'https://evomi.com/',
    statusCode: 200,
    outcome: 'warning',
    responseTimeMs: 684,
    responseBytes: 341600,
    title: 'Evomi | Ethical Proxies & Web Data From $0.49/GB',
    h1: 'Proxies built for reliable web data',
    links: 74,
    images: 18,
    scripts: 29,
    stylesheets: 2,
    findings: [
      { id: 'finding-1', severity: 'warning', title: 'HTML có kích thước lớn', description: 'Tài liệu HTML vượt ngưỡng cảnh báo 300 KB của bộ quy tắc v1.', evidence: '341.600 bytes > 300.000 bytes' },
      { id: 'finding-2', severity: 'info', title: 'Phản hồi chậm hơn mục tiêu', description: 'Thời gian phản hồi ban đầu cao hơn mục tiêu quan sát 500 ms.', evidence: '684 ms > 500 ms' },
    ],
  },
]

export const snapshot: PageSnapshot = {
  id: 'snapshot-1',
  scanPageId: 'page-home',
  status: 'COMPLETED',
  createdAt: 'Hôm nay, 20:18',
  finalUrl: 'https://evomi.com/',
  viewport: '1440 × 900',
  resourceCount: 126,
  totalBytes: 4289412,
  reconstruction: {
    id: 'reconstruction-1',
    status: 'PARTIAL',
    kind: 'STATIC_PAGE_ARCHIVE',
    engineVersion: 'weblens-1/pagesource-0.1.2@f59ed61',
    packagedCount: 5,
    skippedCount: 1,
    archiveBytes: 946321,
    completenessCode: 'RESOURCE_GAPS',
    failureCode: null,
    expiresAt: '2026-09-20T13:18:00Z',
    downloadAvailable: true,
  },
  resources: [
    { id: 'res-1', url: 'https://evomi.com/', method: 'GET', status: 200, type: 'document', contentType: 'text/html', sizeBytes: 341600, durationMs: 684, bodyCaptured: false, capturedBodyId: null, capturedBodyBytes: 0, bodySha256: null, bodyTruncated: false },
    { id: 'res-2', url: 'https://evomi.com/_next/static/chunks/app.css', method: 'GET', status: 200, type: 'stylesheet', contentType: 'text/css', sizeBytes: 151295, durationMs: 143, bodyCaptured: true, capturedBodyId: 'body-2', capturedBodyBytes: 151295, bodySha256: '9b16dca927d87a20ce4f10cd87afcd50f018dc0826f77accb07a2e16d4564e8d', bodyTruncated: false },
  ],
}
