# ADR-007 — Tích hợp Pagesource để tạo bản clone tĩnh từ browser capture

> Bổ sung: ADR-011 cho phép Design Clone dùng cookie trong BrowserContext tạm thời
> sau khi owner tự đăng nhập. Quy tắc không **lưu** cookie, authorization header,
> form value và XHR/fetch body của ADR này vẫn giữ nguyên.

Trạng thái: Accepted revision 1 ngày 2026-09-13; revision 2 và baseline workload,
database/runtime được người dùng chấp thuận triển khai ngày 2026-09-18; revision 3
Design Clone được chấp thuận qua TASK-018 ngày 2026-09-20.
Ngày: 2026-09-13

## Amendment revision 3 — Design Clone

Site-wide workflow của revision 2 mặc định tạo **Design Clone**, không còn cố
đóng gói mọi URL. Crawler vẫn sở hữu discovery; Capture Worker sở hữu pre-filter,
semantic classifier, route template, browser render, DOM layout fingerprint và
representative assembly.

- Chỉ giữ locale của root URL. Alternate locale, query/tracking variant,
  canonical duplicate, non-HTML và policy-blocked URL không chạy Chromium.
- Không gộp semantic role khác nhau. Auth login/register/forgot-password,
  blog index/detail, use-case index/detail và error layout là các nhóm độc lập.
- Trong cùng role + route template, metadata tĩnh chọn số ứng viên tối thiểu cần
  render; assembly giữ một representative cho mỗi layout fingerprint khác nhau.
- Manifest version 2 giải thích counts, reason code, representative, route map,
  fingerprint version và SHA-256/byte count của từng shard.
- Design Clone không tạo screenshot. `STATIC_PAGE_ARCHIVE` của capture độc lập
  không đổi.
- Page-work row hiện có lưu cả selected và policy-rejected URL; không thêm migration
  hoặc thay đổi schema. Policy rejection không tự làm archive thành `PARTIAL`.
- Page bundle chỉ được GC sau terminal publish. Shard/manifest upload qua prefix
  `site-clone-staging/`, được copy sang key publish và staging prefix có lifecycle
  dự phòng một ngày.

Quyết định này giữ nguyên ba deployable và public API của revision 2. Đây là bản
trích giao diện đại diện để chỉnh sửa, không phải backup nội dung, backend, dữ liệu
hay session của website nguồn.

## Amendment revision 2 — clone toàn website

Ngày 2026-09-18, người dùng yêu cầu mở rộng Pagesource adapter từ clone tĩnh một
trang sang clone toàn bộ website. Revision này chấp thuận hướng sản phẩm, boundary
kiến trúc và sau lần review tiếp theo đã chấp thuận baseline trong
`RECONSTRUCTION_SITE_CLONE_PROPOSAL.md` revision 2. Lịch sử revision 1 bên dưới
được giữ nguyên để giải thích implementation.

### Quyết định kiến trúc bổ sung

- Giữ `STATIC_PAGE_ARCHIVE` hiện tại để capture một trang tiếp tục tương thích.
- Bổ sung use case độc lập `STATIC_SITE_ARCHIVE`: người dùng nhập URL gốc và hệ
  thống tự khởi tạo một scan mới trước khi tạo archive. Người dùng không phải chọn
  `scan_id`; Capture Worker không tự crawl link graph thay Crawler.
- Control Plane validate/normalize URL, resolve website theo owner, tạo scan mới
  và liên kết site-clone với `scan_id` nội bộ bất biến. Không tái sử dụng ngầm
  latest scan vì dữ liệu có thể cũ. Crawler tiếp tục là nguồn danh sách page đã
  khám phá; page target được bàn giao bằng contract versioned, phân trang/batch và
  idempotent, không truyền một payload chứa hàng chục nghìn URL.
- Capture Worker tiếp tục là execution boundary duy nhất cho Chromium và
  Pagesource TypeScript engine. Không thêm Python runtime hoặc deployable thứ tư.
- Mỗi page được browser-render độc lập với lease, timeout và retry hữu hạn. Job có
  thể resume sau restart; worker cũ không được publish sau khi mất lease.
- Asset đủ policy được deduplicate xuyên page theo source identity và content hash.
  HTML/CSS cùng internal link được rewrite sang cây path ổn định trong archive.
- Site archive là snapshot best-effort theo thời gian, không phải transaction nhất
  quán của website. Manifest phải ghi thời điểm từng page, page thất bại, asset
  thiếu/truncate, redirect và mức đầy đủ của toàn job.
- Mặc định vẫn same-origin, không dùng cookie người dùng, không lưu XHR/fetch body,
  không `bypass_csp`, không bật download và không chạy archive trên origin WebLens.
- ZIP và manifest vẫn nằm trong MinIO/S3; PostgreSQL chỉ sở hữu workflow và object
  metadata. ClickHouse không trở thành queue hoặc nơi lưu payload clone.
- Job `PARTIAL` vẫn cho tải archive khi có ít nhất một page hợp lệ; `FAILED` không
  được làm mất scan hoặc capture evidence đã có.
- Full-site clone phải có progress, cancellation, bounded resource policy và
  owner-scoped download. Mọi giới hạn phải cấu hình được nhưng vẫn có hard ceiling.

### Cổng triển khai revision 2

Full-site clone cần durable page work, fan-out, retry, lease/fencing và counters.
Đây là workload nhạy cảm concurrency; không thể biểu diễn production-ready chỉ
bằng hai bảng revision 1 đang gắn một reconstruction với một `capture_job_id`.

- `reconstruction_jobs` và `reconstruction_artifacts` là YELLOW; revision schema
  đã được review và phê duyệt riêng cho TASK-015.
- Durable page-work relation có semantics queue/lease/retry nên được xử lý như RED;
  đủ 13 bước thiết kế đã được phê duyệt trong proposal revision 2.
- Không được sửa migration 002/003 đã áp dụng. Mọi thay đổi phải là forward
  migration sau review theo `RECONSTRUCTION_SITE_CLONE_PROPOSAL.md`.
- Runtime site-clone, API và UI được phép triển khai theo đúng hard ceiling đã ghi;
  thay đổi ceiling/schema tiếp theo phải review lại.

## Bối cảnh

WebLens V1.5 đã có Playwright Capture Worker, HTML sau render, screenshot,
network metadata, một tập resource body có giới hạn và MinIO. Người dùng muốn
dùng [timf34/pagesource](https://github.com/timf34/pagesource) để bổ sung chức
năng clone website kết hợp với browser capture.

Pagesource là CLI Python giấy phép MIT. Phiên bản được đánh giá là `0.1.2`, commit
`f59ed61dfc42a901b412a4cc6803fc238e879405`. Công cụ thu các response do
Playwright quan sát, suy luận phần mở rộng từ `Content-Type`, làm sạch đường dẫn,
giữ cấu trúc URL và xử lý tên file trùng. Tuy nhiên, implementation upstream:

- giữ toàn bộ response body trong RAM rồi mới ghi ra đĩa;
- bật `bypass_csp` và chấp nhận download;
- không có DNS/redirect SSRF guard tương đương WebLens;
- không có giới hạn file, byte, thời gian hoặc retention phù hợp multi-tenant;
- không viết lại đầy đủ HTML/CSS để bảo đảm bản sao chạy offline;
- chỉ thu một trang, không khôi phục source React/Next.js, backend, database,
  private API hoặc component boundary gốc.

Vì vậy không thể chạy nguyên CLI Pagesource như một production worker của
WebLens. Việc tạo thêm Python service cũng mâu thuẫn với boundary ba deployable
đã duyệt tại ADR-005 nếu chưa có ADR mới.

## Các phương án đã xem xét

1. Chạy nguyên CLI Python Pagesource như deployable thứ tư.
2. Cài Python và gọi subprocess Pagesource từ Capture Worker Node.js.
3. Port có ghi attribution các thuật toán phù hợp vào Capture Worker hiện tại,
   dùng chung một Playwright session và giữ toàn bộ security/budget của WebLens.
4. Không tích hợp; chỉ tiếp tục cho tải từng resource body riêng lẻ.

## Quyết định

Chọn phương án 3, với các giới hạn sau:

- Giữ đúng ba deployable. Không thêm Python runtime hoặc service mới.
- Pagesource là nguồn ý tưởng và provenance cho lớp ánh xạ URL thành đường dẫn
  local, suy luận extension, tránh trùng tên và tạo cây resource. Nếu port đoạn
  code đáng kể, phải giữ copyright MIT trong third-party notice và tại file nguồn.
- Một lần browser capture mới tạo tối đa một **bản clone tĩnh của một trang**.
  Đây là gói source export/best-effort offline, không phải source code gốc và
  không phải bản sao backend có thể vận hành độc lập.
- Main rendered HTML cùng CSS, JavaScript, image và font đủ điều kiện được đóng
  thành archive. Chỉ resource body thực sự đã thu mới được công bố là có trong
  clone; manifest phải liệt kê resource thiếu, bị chặn, lỗi hoặc bị truncate.
- Mặc định chỉ đóng gói same-origin. Resource ngoài origin chỉ có thể được bật
  sau review policy; mọi DNS, redirect và connection vẫn phải qua egress/SSRF
  guard của Capture Worker.
- Không dùng `bypass_csp`, không bật download và không hạ sandbox để tăng độ đầy
  đủ của clone.
- Query value không xuất hiện trong logical filename hoặc manifest. Có thể dùng
  hash của URL đầy đủ trong RAM để tạo tên ổn định và phân biệt collision.
- Archive và manifest nằm trong MinIO. PostgreSQL chỉ giữ lifecycle, object
  reference, checksum và số byte; ClickHouse không giữ payload clone.
- WebLens không thực thi HTML/JavaScript clone trên origin của ứng dụng. Vòng đầu
  chỉ cho tải archive dưới dạng attachment. Preview chạy được chỉ được xem xét
  trên một origin/container cô lập bằng ADR riêng.
- Toàn bộ resource được thu và map trong cùng Playwright session với capture để
  tránh chạy website hai lần và để giữ URL mapping trước khi redaction.
- Lỗi clone không được làm mất screenshot, rendered evidence hoặc analytical
  result hợp lệ. UI phải thể hiện clone `PARTIAL`/`FAILED` độc lập với capture.

Trong revision 1, phạm vi chưa bao gồm clone toàn bộ các trang của một website.
Revision 2 phía trên đã chấp thuận hướng mở rộng này nhưng vẫn yêu cầu workload và
database design review trước implementation.

## Hệ quả

- Tận dụng được Playwright, MinIO, lease/fencing và SSRF policy đang có mà không
  tăng số deployable hoặc duplicate browser session.
- Implementation không phụ thuộc Python package lúc runtime, nhưng phải có test
  tương thích hành vi với Pagesource và notice giấy phép rõ ràng.
- Một archive làm tăng CPU, RAM, disk tạm, object bandwidth và storage cho mỗi
  capture. Phải stream ra file/object có giới hạn thay vì giữ thêm một bản archive
  không giới hạn trong RAM.
- Bản clone có thể không hoàn chỉnh vì CSP, service worker bị chặn, response body
  không còn khả dụng, resource vượt policy, request cần đăng nhập hoặc backend
  động. Manifest và UI phải công bố chính xác các giới hạn này.
- `reconstruction_jobs` và `reconstruction_artifacts` thuộc nhóm YELLOW. Proposal
  database tương ứng đã được người dùng phê duyệt ngày 2026-09-13.

## Hồ sơ phê duyệt

Người dùng đã phê duyệt đồng thời ngày 2026-09-13:

1. Đơn vị clone ban đầu là một trang, không phải toàn bộ scan/website.
2. Same-origin mặc định; không capture XHR/fetch body hoặc dữ liệu người dùng.
3. Archive download-only; chưa có live preview chạy JavaScript.
4. Budget và retention trong hồ sơ database reconstruction.
5. Hai bảng YELLOW thuộc Capture Worker PostgreSQL.
6. Capture thành công vẫn độc lập với kết quả clone.

## Khi nào xem xét lại

- Archive generation trở thành bottleneck theo benchmark.
- Cần preview tương tác hoặc chạy JavaScript đã clone.
- Cần capture response nhạy cảm, authenticated session hoặc API body.
- Pagesource thay đổi giấy phép hoặc cung cấp library API có security contract phù
  hợp trực tiếp với WebLens.
