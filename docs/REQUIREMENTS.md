# V1 and V1.5 Requirements

Requirements describe observable behavior, not implementation details. Authorization applies to every user-owned resource.

## SYS-001 — Bàn giao công việc bền vững giữa các service

**Mô tả:** Control Plane, Crawler Service và Capture Worker giao tiếp qua contract
có version mà không làm mất công việc đã chấp nhận khi timeout, duplicate delivery,
service restart hoặc network partition ngắn hạn.

**Tiêu chí chấp nhận:** Scan/capture request được persist trước khi trả accepted;
dispatch và event consumer idempotent; trạng thái người dùng thấy không quay ngược;
terminal event có thể reconcile; mỗi request có correlation ID; service outage
được thể hiện bằng queue/stale/failure có phân loại thay vì báo thành công giả.

**Trường hợp biên:** Commit thành công nhưng dispatch thất bại, command trùng,
event đến sai thứ tự, callback thất bại, worker hết lease và service phục hồi sau
restart.

## SYS-002 — Cô lập quyền sở hữu dữ liệu

**Mô tả:** Mỗi service chỉ sửa dữ liệu thuộc ownership của mình và xác thực mọi
giao tiếp nội bộ.

**Tiêu chí chấp nhận:** Không service nào đọc/ghi trực tiếp bảng private của
service khác; không có cross-service foreign key/transaction; opaque identifiers
được validate; caller service được authenticate/authorize; credential người dùng
không được chuyển cho crawler. Capture Worker chỉ nhận input tương tác trong phiên
owner-scoped theo CAP-006 và không persist/log input, cookie hoặc token.

**Trường hợp biên:** ID hợp lệ nhưng sai owner, replay command, credential rotation,
service account bị revoke và dữ liệu projection lệch source.

## SYS-003 — Analytical ingestion bền vững

**Mô tả:** Crawler và Capture Worker đưa analytical facts vào ClickHouse theo
batch mà không làm mất accepted result khi ClickHouse chậm, unavailable hoặc trả
acknowledgement không rõ ràng.

**Tiêu chí chấp nhận:** PostgreSQL staging bền vững trước external insert; delivery
at-least-once nhưng report không double count; có bounded backpressure; scan/capture
report công bố watermark/freshness; lifecycle/authorization không phụ thuộc vào
ClickHouse merge; backlog có thể reconcile sau restart.

**Trường hợp biên:** ClickHouse success nhưng PostgreSQL ack thất bại, duplicate
batch, version đến sai thứ tự, `too many parts`, disk pressure, retention/delete
đồng thời với ingest và ClickHouse outage kéo dài.

## AUTH-001 — User authentication

**Description:** A user can establish and end an authenticated session and access only their own data.

**Acceptance criteria:** Valid credentials authenticate; invalid credentials return a generic failure; protected operations reject unauthenticated callers; sessions/tokens can be invalidated according to the selected authentication design.

**Important edge cases:** Repeated failures, disabled users, expired sessions, credential enumeration, concurrent sessions.

## SITE-001 — Register a website

**Description:** An authenticated user can register a normalized HTTP(S) website target that they are authorized to scan.

**Acceptance criteria:** The system validates syntax and allowed protocols, preserves a clear canonical target, prevents unintended duplicates per user, and never fetches the URL as a side effect of validation unless explicitly designed.

**Important edge cases:** Internationalized domains, default ports, fragments, credentials in URLs, DNS/private-address targets, redirects, and ownership/authorization policy.

## SITE-002 — Manage registered websites

**Description:** A user can list and view their websites and stop using a website without affecting another user.

**Acceptance criteria:** Results are scoped by user, pagination is bounded, and deletion/archival behavior for historical scans is explicit before implementation.

**Important edge cases:** Websites with active scans, historical retention, concurrent updates.

## SCAN-001 — Create a bounded scan

**Description:** A user can request a scan of one registered website with enforced limits.

**Acceptance criteria:** The request creates one identifiable scan, captures its effective configuration, begins from the registered target, and refuses unauthorized or unsafe targets. Repeated client submission has a defined idempotency policy.

**Important edge cases:** Duplicate requests, scan already running, DNS changes, unreachable origin, invalid certificates, and configured page/time limits.

## SCAN-002 — Crawl and collect measurements

**Description:** The system visits a limited number of eligible pages and stores basic response/page/performance measurements with collection metadata.

**Acceptance criteria:** Same-site and page limits are enforced; redirects and every outbound connection are safety-checked; timeouts and response-size limits apply; each page records success or a classified failure; partial results remain distinguishable from complete results.

**Important edge cases:** Cycles, duplicate/canonical URLs, redirect loops, robots policy decision, content-type mismatch, compressed bodies, malformed HTML, very large pages, and target rate limiting.

## SCAN-003 — Observe scan progress

**Description:** A user can retrieve current scan state and bounded progress details.

**Acceptance criteria:** States are monotonic according to the documented lifecycle; terminal success, partial success, cancellation, and failure are distinguishable; progress never exceeds configured bounds.

**Important edge cases:** Worker/application restart, stale scan, late page result, concurrent polling.

## REPORT-001 — View scan results

**Description:** A user can view scan summary, page outcomes, collected metrics, and findings.

**Acceptance criteria:** Results are authorized, paginated where needed, label missing/failed measurements, and include enough collection context to interpret values. Pagination only bounds the returned rows: total URL, issue-page, finding and HTTP-distribution counts shown as scan-wide totals must be calculated over the full authorized analytical projection, never inferred from the current page length. An issue page is a failed HTTP/fetch outcome or has at least one `ERROR`/`WARNING` finding; `INFO` findings and policy-skipped pages remain visible evidence but do not make a page an issue.

**Important edge cases:** Partial scans, deleted website, measurement-version changes, no successful pages.

## CAP-001 — Create a browser capture

**Description:** A user can request a browser capture for an eligible page from one of their scans.

**Acceptance criteria:** Ownership is enforced, one identifiable capture job is persisted before execution, and its state is distinguishable as queued, running, completed, or failed.

**Important edge cases:** Duplicate requests, ineligible or failed pages, concurrent captures, deleted websites, and worker unavailability.

## CAP-002 — Capture rendered evidence

**Description:** An isolated Playwright-controlled Camoufox worker captures final rendered HTML/DOM, a screenshot, eligible resources, and bounded network metadata. Chromium remains a manually selectable engine.

**Acceptance criteria:** Browser timeout and resource limits apply; the final URL and collection context are recorded; API-process stability does not depend on browser-process stability; sensitive headers and payloads are excluded by default.

**Important edge cases:** Failed scripts, never-idle pages, popups/downloads, large resources, unsupported content, cross-origin resources, redirects, and malicious page code.

## CAP-003 — Store and inspect snapshots

**Description:** A user can inspect snapshot metadata, screenshot evidence, and captured-resource metadata, while large objects remain in S3-compatible object storage.

**Acceptance criteria:** PostgreSQL stores authorized snapshot/object metadata and stable object references; ClickHouse stores bounded redacted network/resource analytical facts; content hashes support safe deduplication; captured HTML and JavaScript are never executed by the viewer.

**Important edge cases:** Missing objects, duplicate hashes, retention/deletion, partial captures, long URLs, and unavailable screenshots.

## CAP-004 — Tạo và tải bản clone tĩnh một trang

**Mô tả:** Mỗi browser capture mới tạo best-effort một ZIP clone tĩnh của đúng
một trang từ HTML sau render và resource body đủ điều kiện trong cùng Playwright
session.

**Tiêu chí chấp nhận:** Chỉ CSS, JavaScript, image và font same-origin được đóng
gói; URL→path và rewrite ổn định; manifest versioned công bố file bị thiếu hoặc
truncate; giới hạn 100 file, 50 MiB input và 64 MiB archive; archive private hết
hạn sau 7 ngày; owner tải qua Control Plane dưới dạng attachment sau kiểm tra
size/SHA-256. Clone `PARTIAL` hoặc `FAILED` không làm mất capture hợp lệ, và UI
không preview hay thực thi HTML/JavaScript trong archive.

**Trường hợp biên:** URL chỉ khác query, path Unicode/traversal, tên dành riêng
Windows, collision, CSS URL tương đối, `srcset`, external origin, body hết budget,
worker mất lease, upload thành công nhưng commit thất bại, object hết hạn hoặc bị
thay đổi và capture cũ chưa có reconstruction.

## CAP-005 — Tạo và tải Design Clone của website

**Trạng thái:** Baseline workload/database đã được duyệt và runtime đã triển khai
theo ADR-007 revision 2; benchmark capacity và E2E hạ tầng thật vẫn bắt buộc trước
khi tuyên bố production-ready.

**Mô tả:** Owner nhập URL gốc để yêu cầu một site archive bất đồng bộ. Control
Plane validate/normalize URL, resolve website thuộc owner và tự tạo một scan mới;
Crawler khám phá tập page, sau đó Capture Worker loại locale/query/canonical và
non-HTML, phân loại semantic role + route template, chỉ browser-render ứng viên
đại diện, deduplicate theo layout fingerprint và asset SHA-256 cùng kiểu biểu diễn
trình duyệt, rewrite internal navigation rồi công bố archive cùng manifest.
`scan_id` là correlation nội bộ,
không phải lựa chọn bắt buộc của user. Design Clone không tạo screenshot và không
được mô tả như một bản backup đầy đủ nội dung website.

**Tiêu chí chấp nhận:** Một request idempotent với cùng owner, URL và idempotency
key không tạo trùng scan/site-clone; request được persist trước khi trả accepted;
scan mới luôn được tạo cho request mới thay vì tái sử dụng ngầm latest scan; page
work resume được sau restart; progress/cancellation/partial/failure rõ ràng;
stale worker không publish; login/register/forgot-password không bị gộp; chỉ locale
của URL gốc và resource đúng policy được đóng gói; URL bị loại có reason code;
progress phân biệt discovered/rendered/packaged; archive owner-scoped,
download-only và kiểm tra size/SHA-256; hard ceiling về page, file, byte, thời gian
và concurrency luôn được cưỡng chế; staging object có lifecycle dự phòng 24 giờ;
clone một trang cũ tiếp tục tương thích.

Render monitor đọc snapshot owner-scoped của Capture Worker qua Control Plane:
phase thật (kể cả INGESTING), số trang theo trạng thái, tối đa 32 page đang giữ
lease và danh sách keyset theo ordinal (50 dòng mặc định, tối đa 100). Thanh tiến
độ chỉ đo ứng viên đã xử lý (thành công + lỗi), loại URL CANCELLED khỏi mẫu số;
không đưa phần trăm giả khi ingestion chưa kết thúc hoặc chưa có ứng viên.
Render 100% không đồng nghĩa archive đã publish; PARTIAL/FAILED/CANCELLED phải
hiển thị rõ. Retry/lease hết hạn, thời điểm snapshot và lỗi polling phải được
phân biệt. Danh sách là trạng thái hiện tại, không phải lịch sử event.
Chẩn đoán sao chép gồm jobId/scanId/correlationId/pageId/attempt và mã lỗi;
không trả storage key, credential, query value hoặc raw log/HTML. Không thêm
schema hoặc dịch vụ log cho chức năng theo dõi này.

**Trường hợp biên:** Scan 100.000 page, report chưa fresh, duplicate target batch,
canonical/query variants, page thay đổi trong lúc job chạy, browser crash, retry,
cancel, asset chung khác nội dung, redirect/external CDN, disk/MinIO pressure,
orphan object, archive partial/expired và internal link tới page thất bại.

**Baseline đã chốt:** tối đa 100.000 page, 200 GiB input, 50 GiB archive, shard
256 MiB, tối đa 4 page/job và 2 page/process theo cấu hình mặc định, retry 3 lần,
thời gian job 7 ngày, archive 7 ngày, metadata 30 ngày, chỉ same-origin. Có ít
nhất một page thành công thì cancellation/lỗi phần còn lại có thể phát hành
`PARTIAL`; không có page thành công thì `FAILED` hoặc `CANCELLED`.

## CAP-006 — Phiên đăng nhập tạm thời và DOM động cho Design Clone

**Mô tả:** Owner có thể mở một browser session do WebLens quản lý, tự nhập thông
tin đăng nhập/OTP và xác nhận tiếp tục. Renderer dùng cookie trong cùng context và
thử bounded scroll/click load-more/hover trước khi đóng gói.

**Tiêu chí chấp nhận:** Control Plane authorize owner cho mọi status/screenshot/
action; session chỉ ở RAM, tối đa một session/process và tự xóa sau 10 phút;
worker restart yêu cầu login lại; response/log/database/object không chứa phím
nhập, cookie hay authorization header; form value bị xóa khỏi HTML archive; page
deadline, SSRF, redirect, byte và resource budget vẫn áp dụng. Scan không có page
thành công vẫn dispatch để root fallback có thể render. Crawler không cưỡng chế
`robots.txt` theo quyết định operator nhưng không vượt access control.

**Trường hợp biên:** OAuth popup, session timeout trong lúc nhập OTP, sai owner,
worker restart, page mở vô hạn, nút phá hoại giả dạng load-more, CAPTCHA/WAF và
Cloudflare. ADR-012 bổ sung thử nghiệm local headed/stealth; không có solver,
không bảo đảm truy cập được. Theo yêu cầu thử nghiệm, không thêm kiểm tra nội dung
trước xuất ZIP: archive có thể vẫn chứa challenge, kể cả khi job publish thành công.
ADR-015 chọn Camoufox mặc định cho local/VPS Windows-native, vẫn giữ SafeProxy,
phạm vi session, timeout/cleanup và smoke test. Chromium chỉ dùng khi được chọn rõ.

## Deferred requirements

Scan comparison và regression detection bắt đầu ở V2; AI root-cause analysis ở
V3; scheduling/alerts ở V4. Kafka/Redis coordination, multi-region crawler,
service decomposition bổ sung, RAG, ML anomaly detection và cloud orchestration
thuộc V5-V8. Ba deployable trong ADR-005 và durable handoff giữa chúng là yêu cầu
V1/V1.5, không còn là phần deferred.
