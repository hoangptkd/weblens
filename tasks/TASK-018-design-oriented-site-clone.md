# TASK-018 — Design Clone: chỉ giữ giao diện đại diện

Trạng thái: **HOÀN THÀNH — 2026-09-20**.

## Goal

Đổi full-site clone từ việc đóng gói mọi URL thành một **Design Clone** phục vụ
người dùng tải bộ giao diện về chỉnh sửa. Archive phải giữ ít nhất một trang đại
diện cho mỗi nhóm chức năng và mỗi layout thực sự khác biệt, nhưng không nhân bản
hàng trăm bài blog, bản dịch hoặc route chỉ khác nội dung.

## Product decision

- Design Clone là hành vi mặc định của workflow clone toàn website.
- Giữ ít nhất một đại diện cho từng nhóm chức năng, kể cả đăng nhập, đăng ký,
  quên mật khẩu, trạng thái xác minh và trang lỗi nếu website công khai các trang
  đó.
- Chỉ clone locale của URL gốc. Không tự đi sang bản dịch khác qua `hreflang`,
  language switcher hoặc locale prefix khác.
- Blog/list/detail, use-case/list/detail và các loại trang khác là những nhóm riêng;
  không gộp hai nhóm khác chức năng chỉ vì chúng dùng chung shell hoặc CSS.
- Một nhóm được giữ thêm đại diện khi cấu trúc layout khác rõ ràng.
- Không dùng AI để phân loại hoặc deduplicate. Kết quả phải deterministic, có thể
  kiểm thử và không phát sinh chi phí model.
- `STATIC_PAGE_ARCHIVE` hiện có và screenshot của capture độc lập không thuộc
  phạm vi thay đổi. Design Clone không tạo hoặc lưu screenshot JPEG.

## Non-goals

- Không sao lưu đầy đủ nội dung website.
- Không clone backend, database, tài khoản, session hoặc chức năng server-side.
- Không cố tình gây lỗi 500 trên website đích để lấy giao diện lỗi.
- Không thêm Kafka, Redis, service mới hoặc dependency phân loại bằng ML/LLM.
- Không thêm hoặc thay đổi bảng database trong lần triển khai đầu. Nếu không thể
  đáp ứng durability bằng schema hiện có, dừng ở proposal theo
  `docs/database/DESIGN_GATES.md` trước khi tạo migration.

## Selection policy

### 1. Chuẩn hóa URL

- Bỏ fragment.
- Bỏ tracking query như `utm_*`, `ref`, `from`, `gclid`, `fbclid`.
- Tôn trọng canonical URL hợp lệ cùng origin.
- Gộp slash cuối, hostname case và default port.
- Không đưa non-HTML response, feed, sitemap, robots, API endpoint hoặc file tải
  trực tiếp vào tập page template.
- Tiếp tục áp dụng SSRF, redirect và same-origin policy hiện hành.

### 2. Chọn locale

- Suy ra locale từ URL gốc, `html[lang]`, canonical và `hreflang`.
- URL gốc `/vi/...` chỉ giữ nhóm `vi`; URL gốc không có locale prefix giữ locale
  mặc định của trang gốc.
- Locale khác phải được ghi vào manifest với lý do `ALTERNATE_LOCALE`, không được
  render bằng Chromium.

### 3. Phân loại semantic role

Classifier deterministic phải nhận diện tối thiểu:

- `HOME`
- `MARKETING_LANDING`
- `PRODUCT_LIST`, `PRODUCT_DETAIL`
- `PRICING`, `CONTACT`, `DOWNLOAD`
- `PARTNER`, `AFFILIATE`
- `AUTH_LOGIN`, `AUTH_REGISTER`, `AUTH_FORGOT_PASSWORD`
- `AUTH_VERIFY_OR_STATUS`
- `BLOG_INDEX`, `BLOG_DETAIL`
- `USE_CASE_INDEX`, `USE_CASE_DETAIL`
- `COMPARISON_DETAIL`
- `LEGAL_TEXT`
- `ERROR_4XX`, `ERROR_5XX`
- `UNKNOWN`

URL pattern là tín hiệu đầu tiên. Form action, heading, HTTP status, canonical và
cấu trúc DOM đã sanitize là tín hiệu bổ sung. Không gộp các semantic role khác
nhau. Ví dụ `/login`, `/register` và `/forgot-password` luôn là ba đại diện riêng
dù có cùng layout.

### 4. Route template và layout fingerprint

- Chuẩn hóa slug/id thành route template, ví dụ `/blog/{slug}`,
  `/use-cases/{slug}` và `/vs/{slug}`.
- Trong cùng semantic role và route template, ưu tiên URL sạch, ngắn, status tốt,
  không query và canonical self-reference.
- Với ứng viên còn lại, tạo layout fingerprint từ DOM sau render: giữ tag, class,
  ARIA role và hierarchy; bỏ text, timestamp, nonce, ID ngẫu nhiên, token và dữ
  liệu cá nhân.
- Giữ một đại diện cho mỗi fingerprint khác biệt trong cùng semantic role.
- Nếu fingerprint không tạo được, giữ một ứng viên an toàn thay vì loại toàn bộ
  nhóm.

### 5. Trang lỗi

- Giữ một trang 4xx và một trang 5xx nếu crawler gặp tự nhiên và layout khác nhau.
- Nếu 403, 404 và 410 có cùng fingerprint, giữ một đại diện.
- Không tạo request phá hoại, URL ngẫu nhiên quy mô lớn hoặc payload đặc biệt để
  ép website trả lỗi.

## Required workflow

1. Control Plane tạo scan và site-clone job như baseline hiện tại.
2. Crawler cung cấp target đã authorize.
3. Capture Worker thực hiện pre-filter URL/locale/semantic role trước Chromium.
4. Chỉ render số ứng viên tối thiểu cần để tính layout fingerprint.
5. Chọn representative set deterministic.
6. Capture HTML và same-origin resource của representative set; không chụp
   screenshot trong Design Clone.
7. Deduplicate resource theo SHA-256 và kiểu biểu diễn trình duyệt xuyên tất cả
   representative page; không gộp MIME không tương thích vào cùng archive path.
8. Rewrite HTML, CSS và internal navigation tới các trang đã giữ. Link tới trang
   bị loại phải giữ absolute source URL hoặc được ghi rõ trong manifest; không
   rewrite thành đường dẫn local không tồn tại.
9. Tạo ZIP shard và `manifest.json`, upload theo staged-publish hiện tại, xác minh
   byte count và SHA-256 rồi mới publish.
10. Sau khi tất cả archive đã `PUBLISHED`, xóa page bundle, rendered HTML và
    resource body trung gian. Không xóa trước publish vì retry cần nguồn đầu vào.
11. GC phải xóa orphan/staging object nếu worker chết. Dùng lifecycle dự phòng
    cho prefix tạm sau 24 giờ; archive cuối giữ theo retention hiện hành.

## Archive policy

Archive cuối chỉ giữ:

- HTML của representative page.
- Same-origin CSS, JavaScript, image, font và resource body được chọn.
- Một bản cho mỗi resource có cùng SHA-256 và kiểu biểu diễn trình duyệt tương thích.
- `manifest.json`.

Không giữ screenshot. Không giữ riêng rendered HTML/resource body sau khi archive
đã publish thành công.

ZIP phải dùng Deflate cho MIME text như HTML, CSS, JavaScript, JSON, XML và SVG.
Giữ chế độ store/no-recompress cho JPEG, PNG, WebP, AVIF, video, font nén và định
dạng đã nén. Không thay đổi hard ceiling file/byte/shard hiện hành.

## Manifest contract

Manifest phải bổ sung thông tin deterministic, không chứa secret:

- locale đã chọn;
- tổng URL discovered, rejected, grouped, rendered và packaged;
- mỗi semantic role, route template và representative URL;
- layout fingerprint/version;
- URL bị loại và reason code có giới hạn số lượng hoặc được tổng hợp theo nhóm;
- mapping internal route tới local path;
- danh sách archive shard, byte count và SHA-256;
- completeness code và policy/budget đã áp dụng.

Reason code tối thiểu:

- `ALTERNATE_LOCALE`
- `TRACKING_OR_QUERY_VARIANT`
- `CANONICAL_DUPLICATE`
- `SEMANTIC_TEMPLATE_DUPLICATE`
- `LAYOUT_DUPLICATE`
- `NON_HTML`
- `EXTERNAL_ORIGIN`
- `ROBOTS_OR_POLICY_BLOCKED`
- `HTTP_FAILURE`
- `BUDGET_LIMITED`

## API and compatibility

- Không thêm public request field trong iteration đầu. Locale được suy ra từ URL
  gốc; người dùng chọn locale bằng cách nhập URL thuộc locale mong muốn.
- Giữ endpoint progress, cancel và download hiện tại.
- Status/progress phải phân biệt `discovered` với `selected/packaged` để việc giảm
  số trang không bị hiểu là mất dữ liệu. Nếu schema hiện tại không chứa counter
  mới, trả/tổng hợp từ report hoặc manifest; không tự ý tạo migration.
- Archive cũ vẫn tải được đến hết retention.

## Security and failure modes

- HTML, CSS, JavaScript, manifest và mọi resource đã crawl là dữ liệu không tin
  cậy; archive chỉ download, không chạy trên origin WebLens.
- Giữ SSRF validation cho mọi connection và redirect, kể cả resource URL trong
  CSS.
- Không lưu cookie, authorization header, query secret, form value hoặc XHR/fetch
  body nhạy cảm.
- Chống ZIP/path traversal, path collision, Unicode confusion và zip bomb.
- Selection phải ổn định qua retry; cùng input/policy/version phải chọn cùng
  representative set.
- Cancel, stale lease, duplicate delivery hoặc publish lỗi không được xóa object
  mà retry hợp lệ còn cần.

## Implementation boundaries

- Control Plane tiếp tục sở hữu public API và authorization.
- Go Crawler tiếp tục sở hữu discovery/report; không đưa Chromium vào crawler.
- Capture Worker sở hữu classification cuối, DOM fingerprint, resource capture,
  archive assembly và artifact GC.
- Reuse durable site-reconstruction workflow, fencing, staged publish và GC hiện
  có. Không tạo workflow hoặc storage abstraction song song.

## Tests

- Unit test URL normalization, locale selection và semantic classifier.
- Login/register/forgot-password cùng layout vẫn tạo ba representative page.
- Hàng trăm blog detail cùng template chỉ giữ một representative.
- Blog index và blog detail không bị gộp.
- Mỗi locale chỉ giữ locale của root URL.
- Giữ thêm representative khi cùng semantic role nhưng fingerprint khác.
- 403/404/410 cùng layout chỉ giữ một; layout khác được giữ riêng.
- Design Clone không tạo hoặc upload screenshot object.
- Asset có SHA-256 và kiểu biểu diễn trình duyệt giống nhau chỉ xuất hiện một lần
  trong site archive; CSS, JavaScript, image và font giữ extension tương ứng.
- Text file được Deflate; binary đã nén không bị recompress không cần thiết.
- Page bundle chỉ bị xóa sau publish thành công; upload/publish failure vẫn retry
  được và orphan được GC.
- Internal link không trỏ tới local file đã bị loại.
- E2E dùng fixture nội bộ có nhiều locale, blog, auth, error và query variants;
  không dùng website bên thứ ba làm test bắt buộc.

## Acceptance criteria

- Fixture có ít nhất hai locale, 100 blog detail, login, register, forgot password,
  blog index/detail, use-case index/detail và hai layout lỗi.
- Output giữ tất cả semantic role bắt buộc và tối đa một đại diện cho mỗi
  `semantic role + route template + layout fingerprint`.
- Locale khác, canonical duplicate và query variant không được render/capture.
- Archive mở offline, asset dùng chung không trùng, manifest giải thích được mọi
  quyết định chính.
- Không có screenshot object của Design Clone.
- Sau publish và GC, object storage chỉ còn ZIP shard + manifest của job.
- Build, unit test, integration test PostgreSQL/MinIO và E2E fixture đều pass.
- Diff không thêm dependency nếu standard library hoặc dependency hiện có đã đủ.

## What the developer should understand before accepting this code

Design Clone là bài toán chọn representative có ngữ nghĩa, không phải backup toàn
website. Semantic role bảo toàn những luồng người dùng khác nhau; route template
và DOM fingerprint loại biến thể chỉ khác nội dung. Selection phải deterministic
để retry/idempotency đúng. Dữ liệu trung gian chỉ được xóa sau staged publish đã
xác minh, vì tối ưu storage không được đánh đổi durability hoặc khả năng retry.
