# Kế hoạch performance/load test WebLens

Ngày lập: 2026-09-27. Trạng thái: **Phase 1 hoàn tất; chưa đo tải WebLens**.
Mỗi phase kết thúc bằng số liệu và bản review riêng trước khi bắt đầu phase tiếp theo.
Không dùng kết quả từ fixture giả lập của k6 để tuyên bố capacity sản phẩm.

## 1. Phạm vi đã kiểm kê

Đã đối chiếu PRODUCT, REQUIREMENTS, ARCHITECTURE, ADR-005/006/010/015,
TASK-010, cấu hình runtime/Compose/Windows, API frontend, Control Plane,
outbox/inbox, crawler dispatcher/frontier/host lease, Capture Worker, ba PostgreSQL,
ClickHouse, object storage và bộ tools/load hiện có.

Luồng chính: k6 → Control Plane → PostgreSQL Control Plane → outbox → Go Crawler →
PostgreSQL Crawler → ClickHouse → event/projection → API đọc kết quả. Capture được
đặt lệnh riêng sau khi có page đủ điều kiện; worker dùng PostgreSQL riêng,
ClickHouse và S3/MinIO. UI dùng polling, không dùng SSE trong phiên bản này.

Các mức đồng thời **khác nhau**: k6 VU, request thread Tomcat, connection Hikari,
scan đang hoạt động, page fetch slot, host lease và browser job. Không đổi tên
một mức thành “số người dùng hệ thống chịu được”.

## 2. Môi trường đã quan sát, chưa phải môi trường benchmark

| Mục | Quan sát trên máy hiện tại |
| --- | --- |
| Checkout | commit `e7bae1d`, có thay đổi chưa commit từ đợt audit và thiết lập k6 |
| OS/CPU | Windows 11 Pro 10.0.26200; Ryzen 7 PRO 6850HS, 8 core/16 logical processor |
| RAM/đĩa C | 31,31 GiB RAM, khoảng 11,74 GiB còn trống; đĩa 452,04 GiB, khoảng 34,85 GiB còn trống tại thời điểm kiểm kê |
| Runtime công cụ | Temurin Java 21.0.12.1; Go 1.27.0; Node 24.11.1; k6 2.2.0 |
| Dịch vụ | PostgreSQL trả readiness trên 5432; không có Control Plane, Crawler, Capture hoặc ClickHouse đang lắng nghe ở cổng mặc định; Docker daemon không hoạt động |
| PostgreSQL | CLI cục bộ là 18.4; phiên bản server đang nghe ở 5432 chưa xác minh vì cần credential. Compose khai báo PostgreSQL 17.6 cho ba database |
| JVM/GC thực chạy | Chưa có tiến trình backend; heap, GC, JVM flags và số instance thực tế: **chưa biết** |
| Nhiễu môi trường | Máy làm việc có nhiều tiến trình Chrome/Node; không dùng số đo máy này để tuyên bố capacity production |

### VPS production truy cập qua SSH cũ

Ngày 2026-09-27, kiểm tra **chỉ đọc** qua SSH đã kết nối tới máy Windows Server
2019 đang phục vụ `jobnext.top`. Người dùng đã xác nhận đây là production và chọn
dùng máy này cho phép đo. Máy có 8 logical processor, khoảng 7,00 GiB
RAM, khoảng 39,84 GiB trống trên ổ C; release đang chạy commit
`e7bae1d8131d875f645dcee839db5b5167ed3185`. Bốn dịch vụ Backend, Crawler,
Capture và Caddy đều ở trạng thái running. Cấu hình effective đọc từ tệp môi
trường VPS: Hikari 10, Tomcat 100 thread, scan tối đa 1.000 trang và concurrency
20, crawler 20 slot, host 2, Capture 1, site clone 1, Camoufox. Đây không phải
cấu hình 10.000 trang/scan của phase large scan. Fixture đã được chép vào VPS nhưng
chưa khởi chạy; lệnh khởi chạy bị automatic approval review từ chối. Chưa tạo tải
hay seed benchmark trên VPS. Test production chỉ tiếp tục sau khi Phase 2 có
backup/restore, collector và preflight đạt yêu cầu.

Trước mỗi benchmark phải chụp lại cùng mẫu thông tin cho **máy phát tải, từng
service, ba PostgreSQL, ClickHouse, object storage và fixture**: CPU, RAM, disk
free/IOPS, network, phiên bản, số instance, commit, JVM flags/heap/GC, pool,
giới hạn đồng thời, TLS/route, dataset, cache state và clock. Không ghi secret
vào report. Cấu hình đang chạy được ưu tiên hơn default trong mã.

## 3. Giới hạn và hệ quả đối với thiết kế phép đo

| Thành phần | Giá trị mặc định trong mã / cấu hình đang thấy | Hệ quả |
| --- | --- | --- |
| Control Plane | Tomcat 512 thread, 100.000 connection; Hikari 64, min idle 16; JWT access TTL 15 phút | Connection không tương đương request thread; chạy ngắn hoặc làm mới token có kiểm soát |
| Crawler | 10.000 page slot/instance; PostgreSQL pool tối đa 20; host 2 slot và delay 1 giây | Một hostname tối đa xấp xỉ 2 lần claim/giây; 10.000 trang trên một host cần ít nhất khoảng 5.000 giây, chưa kể xử lý |
| Dispatch | Control Plane claim tối đa 25 command mỗi lượt, polling 0,5 giây; crawler có một dispatcher claim page | Queue age và tốc độ claim là số đo bắt buộc khi tăng scan |
| Scan admission | Tối đa 3 active scan/user; tối đa 1 active scan/website | 100 scan đồng thời cần ít nhất 34 tài khoản và 100 website đăng ký hợp lệ |
| Capture | `CAPTURE_CONCURRENCY` mặc định 2, tối đa 10; PostgreSQL pool 10; site clone concurrency mặc định 2 | Đo capture thường riêng với site clone; browser mặc định là Camoufox, Playwright/Chromium là cấu hình tùy chọn |
| Compose production lịch sử | Override Tomcat 200, Hikari 20, scan max 1.000, scan concurrency 32, crawler 32, capture 2 | Không trộn kết quả Compose này với Windows/.env có trần cao hơn; ghi cấu hình effective của lần chạy |
| Windows/.env cục bộ | max pages 100.000, scan concurrency 10.000, crawler 10.000, host 2/delay 1s; browser Camoufox | Đây là cấu hình khai báo, **không phải capacity đã đo** |

Fixture hiện có ở `tools/load/fixture.mjs` sinh tối đa 100.000 trang theo yêu cầu,
nhưng chỉ bind loopback. API đăng ký website từ chối `localhost` và IP riêng,
còn chế độ crawler `CRAWLER_LOCAL_TARGETS_ONLY=true` chỉ đổi chính sách ở crawler.
Vì vậy ví dụ crawl fixture tại 127.0.0.1 trong README hiện **chưa thành một
luồng E2E khả thi qua public API**. Phase 2 phải dựng hostname synthetic do mình
kiểm soát, được API chấp nhận và resolve đến fixture chỉ trong mạng kiểm thử cô
lập, hoặc host fixture trên IP/domain public do mình sở hữu. Không bỏ SSRF guard.
Browser SafeProxy vẫn chặn IP riêng; benchmark capture cần target synthetic có
đường mạng được chính sách browser cho phép.

Host lease của crawler dùng chung theo hostname, không theo scan. Bài 100 scan
trên **một** hostname sẽ chủ yếu đo giới hạn politeness 2 slot. Bài đo sức xử lý
crawler cần nhiều hostname synthetic độc lập, cùng nội dung xác định, và phải đo
CPU/latency của fixture để chứng minh fixture không bão hòa trước hệ thống.

## 4. Điều kiện đo và nguồn số liệu

Audit trước tải hiện ghi `READY_FOR_LOAD_TEST = NO`: Camoufox mặc định, egress
browser, giới hạn auth, ClickHouse/S3 recovery, restore, cancellation và metrics
còn thiếu bằng chứng. Người dùng chọn VPS production: Phase 2 chỉ dùng target
synthetic, identity riêng, backup/restore đã kiểm chứng và preflight một
scan/capture nhỏ. Chỉ chạy stress/spike/soak khi khôi phục và quan sát đủ;
không dùng website bên thứ ba.

| Chỉ số bắt buộc | Nguồn đo dự kiến |
| --- | --- |
| API p50/p95/p99, error, request/s, dropped iterations | k6 theo endpoint/scenario; tách setup login khỏi traffic đo |
| Pages/s, scan active/queued, queue age, retry | Crawler/Control Plane metrics hoặc truy vấn read-only được giới hạn theo thời gian; đối chiếu tiến độ terminal với số page đã commit |
| CPU, RAM, process/thread/browser count | Counter của OS/host/container theo từng tiến trình; theo dõi riêng máy phát tải và fixture |
| JVM heap/GC, Hikari active/idle/pending | Actuator/Micrometer được bảo vệ hoặc JMX/JFR trong môi trường thử nghiệm |
| PostgreSQL connections, wait/lock, query latency/WAL | `pg_stat_activity`, `pg_stat_statements` nếu được bật, pool metrics; ghi riêng ba database |
| ClickHouse/S3 | Query/merge/backlog và request/error/latency của object storage |

Hiện Control Plane chỉ expose `health,info`; crawler/capture chủ yếu có health.
Phase 2 cần chốt và kiểm chứng collector tối thiểu cho các chỉ số trên. Đây là
thay đổi phục vụ **đo lường**, không được dùng để tối ưu trước baseline. Metrics
không gắn URL, token, email hoặc scan ID làm label có cardinality cao.

SLO giả thuyết ban đầu cho API đọc trên môi trường đã ổn định: p95 < 300 ms,
p99 < 1 giây, unexpected error < 1%. Báo cáo cả từng endpoint và toàn workload;
HTTP 409/429 có chủ đích được thống kê riêng, không giấu trong tỷ lệ lỗi. Scan
admission phải bền vững, không mất hoặc nhân đôi scan; throughput được báo cùng
host policy và tỷ lệ page thành công. SLO capture/large scan được chốt sau baseline
vì thời gian phụ thuộc fixture, browser engine và artifact size. Ngưỡng 1 giây
trong script k6 hiện tại sẽ được đồng bộ với SLO đã review ở Phase 2.

Định nghĩa **mức bền vững**: đạt SLO trong plateau, không tăng queue age/backlog
liên tục, tài nguyên không cạn, và tự hồi phục sau khi giảm tải. **Saturation
point** là bậc đầu tiên mà latency/error hoặc backlog vượt ngưỡng ổn định qua
nhiều cửa sổ đo, hoặc máy phát tải không giữ nổi target rate. Phải phân biệt
generator, fixture, network và WebLens trước khi quy bottleneck.

k6 dùng `constant-vus` cho bậc concurrent API user, `ramping-vus` cho
stress/spike, và `constant-arrival-rate` để kiểm tra throughput request độc lập
với độ trễ phản hồi. VU của k6 **không** phải active scan của crawler: k6 chỉ
gửi lệnh và theo dõi, còn số scan đang chạy phải lấy từ trạng thái bền vững.
Theo [tài liệu k6 về executor](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/),
arrival-rate và VU là hai mô hình tải khác nhau; báo cáo không so trực tiếp
capacity của chúng như cùng một đơn vị.

## 5. Thứ tự phase và sản phẩm bàn giao

1. **Kiểm kê/kế hoạch (phase này):** chốt đường đo, giới hạn, rủi ro và dữ liệu còn thiếu. Không chạy tải.
2. **Harness và preflight:** dựng synthetic website/identity, giải quyết đường URL an toàn, bổ sung collector cần thiết, chạy E2E nhỏ và kiểm tra backup/restore. Chưa tối ưu runtime.
3. **Baseline:** warm-up và ba lượt lặp cùng dataset cho API 1–10 VU, 1 scan nhỏ và 1 capture; lưu raw k6/host/DB metrics.
4. **API load:** 50 → 100 → 250 → 500 → 1.000 VU, mỗi bậc có warm-up, plateau và recovery; tách shared-account khỏi distinct-user workload. Không gọi 1.000 VU là 1.000 người dùng thật nếu chưa seed 1.000 identity.
5. **Crawler concurrency:** 1 → 5 → 10 → 25 → 50 → 75 → 100 active scan, dataset và hostname mix cố định; ghi accepted/terminal, pages/s, fairness, queue age. Ít nhất 34 account cho bậc 100.
6. **Large scan:** tối đa 10.000 trang/scan; fixture đúng 10.000 trang và `WEBLENS_SCAN_MAX_PAGES=10000` trên test cluster, xác nhận `effectiveConfig` của scan. Đo riêng cấu hình host production và cấu hình pipeline synthetic cô lập nếu cần phân tách politeness khỏi throughput. Không gộp hai kết quả.
7. **Stress:** tăng sau mức cao nhất bền vững đến bậc đầu thất bại có kiểm soát; dừng khi vượt ngân sách lỗi/tài nguyên và kiểm tra phục hồi.
8. **Spike:** tăng/giảm đột ngột trong giới hạn đã quan sát; đo recovery time, backlog và lỗi.
9. **Browser capacity:** target synthetic có HTML tĩnh, JS/delay và resource xác định; đo 1/2/... captures đồng thời, browser process/RAM, capture/s, object bytes, cleanup. Báo Camoufox mặc định và Playwright tùy chọn riêng.
10. **Soak 2–6 giờ:** tải dưới điểm bão hòa, theo dõi memory/GC, pool, queue, ClickHouse/S3, retry, disk, lỗi và khả năng phục hồi.
11. **Tối ưu và đo lại:** chọn đúng bottleneck đầu tiên có bằng chứng; thay một nguyên nhân, giữ nguyên workload/hardware/dataset/config còn lại, lặp ba lần, báo median và độ biến thiên. `% cải thiện latency = (trước − sau)/trước × 100`; `% cải thiện throughput = (sau − trước)/trước × 100`.

Mỗi phase lưu cấu hình và raw artifact dưới `tmp/load/` (ignored), còn kết luận
đã kiểm chứng vào `docs/testing/PERFORMANCE_LOAD_TEST_RESULTS.md`. Báo cáo cuối
nêu environment, capacity bền vững, saturation, bottleneck đầu tiên, before/after
và câu mô tả CV có điều kiện đo. Không tuyên bố “100.000 users” nếu chưa đo.

## 6. Quyết định cần review trước Phase 2

- Chọn máy/VM test riêng hay VPS staging do người dùng sở hữu; ghi CPU/RAM/disk,
  phiên bản DB và quyền truy cập metrics tại đó. Máy Windows hiện tại không đủ
  điều kiện đại diện cho production và Docker đang tắt.
- Chọn domain/IP synthetic do mình kiểm soát, giải quyết đăng ký URL qua API và
  chính sách SSRF cho Crawler/Capture mà không mở ngoại lệ production.
- Chốt ngân sách thời gian/dung lượng cho 10.000 trang và soak, lịch backup/restore,
  số tài khoản/website test và chính sách dọn dữ liệu sau khi đã lưu metric.
