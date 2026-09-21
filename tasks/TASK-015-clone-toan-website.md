# TASK-015 — Clone toàn website bằng Pagesource TypeScript engine

Trạng thái: **ĐÃ TRIỂN KHAI BASELINE — CHỜ E2E HẠ TẦNG VÀ BENCHMARK**.

## Goal

Mở rộng clone tĩnh một trang thành site-wide static archive: user nhập URL, hệ
thống tự tạo scan mới rồi dùng tập page của scan đó. Giữ đúng ba deployable và
dùng TypeScript Capture Worker + Playwright.

## Why

Clone hiện tại chỉ tạo một ZIP cho một capture. Người dùng cần một archive có nhiều
page, asset deduplicate và internal link rewrite để tải về như một website tĩnh.

## Requirements

- Giữ tương thích `STATIC_PAGE_ARCHIVE` hiện tại.
- Thêm workflow `STATIC_SITE_ARCHIVE` bất đồng bộ, resumable và cancellable.
- Public request nhận URL; Control Plane validate/normalize, resolve website và tự
  tạo scan mới. `scan_id` chỉ là correlation nội bộ, không phải input user chọn.
- Scope page đến từ Crawler report của scan mới đã authorize.
- Capture Worker render page bằng Chromium với SSRF/budget/politeness hiện hành.
- Deduplicate asset xuyên page, rewrite HTML/CSS/internal link và tạo manifest.
- ZIP download-only qua Control Plane; không preview executable trên origin WebLens.
- Partial/failure phải trung thực và không làm mất scan/capture evidence.

## API contract

- tạo site reconstruction theo URL + idempotency key; Control Plane tạo scan mới
  trong orchestration và trả một operation/site-clone ID công khai;
- lấy status/progress và keyset-page outcome;
- cancellation;
- owner-scoped archive download.

## Data changes

Đã triển khai bằng forward migration Control Plane V13 và Capture Worker 004/005
theo `docs/database/RECONSTRUCTION_SITE_CLONE_PROPOSAL.md` revision 2.

## Edge cases

- 100.000 page, cycle/canonical/query variants và redirect khác origin;
- website thay đổi trong lúc clone dài;
- asset chung khác nội dung theo cookie/header/query;
- page timeout/browser crash/disk đầy/MinIO chậm;
- cancel/retry/stale lease và duplicate target batch;
- ZIP/path traversal, collision, Unicode và external CDN;
- scan partial hoặc page report chưa đạt watermark.

## Security considerations

- Không chuyển credential người dùng vào browser.
- Same-origin mặc định, SSRF check mọi connection/redirect.
- Không lưu query secret, header, cookie hay XHR/fetch body.
- Archive không được thực thi trên WebLens origin.
- Hard ceiling page/file/byte/time/concurrency là bắt buộc dù cấu hình product cao.

## Concurrency / consistency considerations

- At-least-once page execution, idempotent outcome và lease-generation fencing.
- Staged object publish với byte/SHA-256 verification và orphan cleanup.
- Counter monotonic/reconcilable; không distributed transaction.

## Implementation plan

1. [x] Chốt baseline workload trong proposal.
2. [x] Hoàn thành design steps 8–13 và migration review.
3. [x] Thêm versioned Control Plane ↔ Crawler/Capture contracts.
4. [x] Triển khai durable site reconstruction workflow trong Capture Worker.
5. [x] Tách Pagesource engine thành collector/mapper/rewriter/archive modules.
6. [x] Thêm API owner-scoped, progress/cancel/download.
7. [x] Thêm UI tạo clone, theo dõi tiến độ và tải archive.
8. [x] Chạy PostgreSQL integration trên PostgreSQL thật cho migration, inbox,
   fencing, retry, cancellation partial và GC.
9. [ ] Chạy E2E fixture nhiều page với MinIO/Crawler thật và capacity benchmark
   trên phần cứng mục tiêu.

## Giới hạn baseline còn lại

- Archive hết hạn và page bundle tạm đã có GC vật lý.
- `metadata_retention_days` hiện được ghi bất biến vào job để thể hiện policy và
  phục vụ batch purge về sau; scheduler xóa vật lý job/page/inbox/outbox sau 30
  ngày chưa được triển khai trong baseline này.
- Chưa có E2E bắt buộc cho toàn chuỗi Control Plane → Crawler → Capture Worker →
  MinIO và chưa có benchmark chứng minh ceiling 100.000 page trên phần cứng mục
  tiêu. Vì vậy ceiling là giới hạn an toàn cấu hình/schema, không phải cam kết
  throughput hay thời gian hoàn thành.

## Tests

- Contract/idempotency/owner isolation.
- PostgreSQL claim, lease, retry, fencing, cancellation và reconciliation.
- MinIO staged publish, integrity, GC và orphan.
- Cross-page link rewrite, asset dedup, ZIP/manifest/security budgets.
- E2E fixture nhiều page SSR + SPA; không dùng website bên thứ ba làm test bắt buộc.

## Definition of Done

- Job sống qua restart, tự scan URL đầu vào và clone được nhiều page của scan mới.
- Archive/manifest trung thực, owner-scoped và không lộ secret.
- Không phá clone một trang hiện tại hoặc boundary ba deployable.
- Benchmark chứng minh giới hạn công bố trên phần cứng mục tiêu.

## What I should understand before accepting this implementation

Clone toàn website là một distributed workflow, không phải chỉ gọi Pagesource
nhiều lần. Độ đúng đến từ durable page work, idempotency, fencing, staged publish
và manifest; ZIP không thể tái tạo backend hoặc source project gốc.
