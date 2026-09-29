# Kết quả performance/load test WebLens

Ngày cập nhật: 2026-09-30. **Phase 6 hoàn tất; lượt chẩn đoán 10 × 1.000 đã
xác định truy vấn receipt tuần tự là bottleneck. Sau tối ưu, 10/10 scan và
10.000/10.000 trang hoàn tất ở 9,52 trang/giây; thời gian tra receipt mỗi trang
giảm 94,11%. Chưa đo lại capacity 50 scan hoặc breaking point.**
Chỉ ghi số đo sau khi phase tương ứng có môi trường, raw artifact và kiểm chứng.

## Phase 1 — Kiểm kê và kế hoạch

Hoàn tất. Xem [PERFORMANCE_LOAD_TEST_PLAN.md](PERFORMANCE_LOAD_TEST_PLAN.md).
Đã xác định trần runtime, khác biệt giữa VU/scan/page/browser, quota ba scan mỗi
user, giới hạn host hai slot và thiếu metrics production. SLO API p95 300 ms,
p99 1 giây, lỗi bất ngờ dưới 1% là giả thuyết để đo, chưa phải cam kết.

## Phase 2 — Harness và preflight

Trạng thái: **hoàn tất và đã được người dùng review trước khi chạy baseline**.

| Mục | Kết quả |
| --- | --- |
| Môi trường đích | Người dùng chọn VPS production đang phục vụ `jobnext.top`; SSH cũ được xác minh bằng thao tác chỉ đọc. |
| VPS | Windows Server 2019, 8 logical processor, khoảng 7,00 GiB RAM; production đã deploy commit `f873c77903965b4d6c9ad2498969d594e7b01401`. |
| Cấu hình effective | Hikari 10; Tomcat 100 thread; scan tối đa 1.000 trang/concurrency 20; crawler 20 slot, host 2; Capture 1, site clone 1; Camoufox. |
| Nguồn đích synthetic | `jobnext.top` resolve trực tiếp tới IP VPS. Fixture được mở rộng để chạy dưới prefix riêng; runner tính đúng health path theo prefix. |
| Kiểm thử local | `node tools/load/smoke-test.mjs` đạt: 40 yêu cầu API giả lập và một crawl fixture 40 trang qua runner. Đã sửa lỗi fixture để mọi path ngoài prefix trả 404, kể cả health/robots; smoke kiểm tra link và canonical vẫn nằm trong prefix. k6 2.2.0 nằm ở `C:\Program Files\k6\k6.exe`; archive/cú pháp và phép thử chặn remote không xác nhận đều đạt. Chưa chạy k6 trên WebLens thật. |
| Dữ liệu production | Fixture 1.000 trang chạy bằng Windows service manual-start `WebLensFixture`, tài khoản ảo `NT SERVICE\WebLensFixture`, chỉ bind `127.0.0.1:19090`. Identity/website benchmark riêng đã chạy đúng một scan và capture trang lá; chi tiết nằm dưới. |
| Backup | Backup mới ngay trước baseline đã tạo cho cả ba PostgreSQL tại commit production hiện tại, tải ra `tmp/load/offhost-backups/performance-preflight-20260927T164814Z`, kiểm SHA-256 và `pg_restore --list` đều đạt. Restore drill trước đó có source/target counts giống hệt nhau; recovery ClickHouse/R2 vẫn phụ thuộc provider. |
| Metrics | Actuator metrics đã deploy, thiếu token trả 401 và token đúng đọc được 117 metric. Collector v2 production thu được JVM/memory/GC/thread, Hikari, Tomcat thread, HTTP, ba PostgreSQL và hai ClickHouse; smoke chống rò secret đạt trên local và VPS. |
| Route công khai | Đã bật đúng prefix bằng Caddy. Kiểm chứng ngoài VPS: health trả JSON `UP` với 1.000 trang; trang 999 trả đúng HTML fixture 4.096 byte, không redirect, TLS hợp lệ; POST trả 405. Hai path ngoài prefix trả frontend SPA và không chứa dữ liệu fixture. |
| Lưu ý deploy | Mỗi release thay junction `C:\WebLens\current`, nên route fixture tạm thời phải được bật lại sau deploy. Sau commit cuối, script route đã validate/restart/kiểm tra lại thành công: fixture và route đều khỏe, public path bị cô lập, 1.000 trang. |

Gói ban đầu đã triển khai có SHA-256
`52AE75EB947CBF4F5138052B8C2B91BB558D2796CD0B305D99EE737FFE9E0831`. Gói v3 tại
`tmp/load/weblens-performance-fixture-phase2-v3.zip` có SHA-256
`127692AC402D110F0B373E56FF6977D11C18F28FCA034FD5304881F4DDD00E6F`; gói thêm
Windows service tạm thời dùng `NT SERVICE\WebLensFixture` và script quản lý route.
Script route sao lưu Caddyfile, validate, restart `WebLensCaddy`, kiểm tra nội dung
JSON/trang fixture công khai và tự hoàn tác nếu kiểm tra thất bại. Caddy 2.11.4
trên VPS đã validate cấu hình đề xuất; route hiện đã được áp dụng lại sau release
cuối và status đạt toàn bộ kiểm tra.

Lần `enable` đầu tiên dừng trước khi restart vì Windows PowerShell diễn giải log
`info` trên stderr của `caddy validate` thành `NativeCommandError`. Nhánh catch đã
khôi phục Caddyfile gốc. Kiểm tra sau lỗi xác nhận `WebLensCaddy` vẫn chạy, route
công khai vẫn trả frontend, fixture service vẫn khỏe và chạy bằng
`NT SERVICE\WebLensFixture`. Script được sửa để quyết định theo exit code của
Caddy trong khi vẫn giữ output chẩn đoán. Hotfix v4 tại
`tmp/load/weblens-fixture-route-hotfix-v4.zip` có SHA-256
`F2C4DF0465C8B8367E62809F923701DCB7E23A92D5B0050945C22189553CC775`.

Preflight production dùng trang lá `/__weblens-load/page/999` để scan đúng một
trang trước khi tăng tải. Script tạo/đăng nhập identity benchmark riêng bằng mật
khẩu nhập ẩn, sau đó đối chiếu scan terminal, report fresh, page 200 thành công,
capture terminal, snapshot khớp page/capture và JPEG artifact. Report không ghi
email hoặc credential. Ở mốc gói v5, mock E2E trên Windows đã đạt toàn bộ luồng
và xác nhận report không chứa token/mật khẩu; production sau đó đã chạy và hoàn
tất như phần preflight bên dưới.
Gói `tmp/load/weblens-phase2-preflight-v5.zip` có SHA-256
`EC0F6BC5EBDBB3C29C486C6C627508544DA59422346C934C9A69FC3B37F68407`.

Lần chạy production đầu tiên dừng trước authentication vì script gọi
`https://jobnext.top/actuator/health`; Caddy phục vụ frontend HTML tại path này
thay vì proxy backend. Không có identity, website, scan hoặc capture được tạo.
Kiểm tra tiếp theo xác nhận Control Plane, Crawler và Capture đều trả `UP` qua
loopback. Script được sửa để kiểm tra riêng ba endpoint loopback trước khi dùng API
công khai.
Gói sửa `tmp/load/weblens-phase2-preflight-v6.zip` có SHA-256
`4FD456DA5D01B28A90DAE03A425783B4DCF8419002EC64931F27C2E608DEC33A`.

Lần chạy v6 đã tạo và hoàn tất scan/capture một trang, sau đó dừng khi tải JPEG:
client gửi `Accept: application/json` nên API trả 406. Log Capture xác nhận capture
`c8a68416-9fef-408f-956b-26713319da8d` đã staged với một network request và
reconstruction `PUBLISHED`. Bản sửa gửi `Accept: image/jpeg` và có chế độ
`-ResumeLatest` để đối soát chính scan/capture này mà không tạo workload thứ hai.
Gói `tmp/load/weblens-phase2-preflight-v7.zip` có SHA-256
`4BFCB7EEBE8E85A10E3BE47583E8A245CAB3CB9224FF2521C2BDE8528988EAB0`.

Preflight production cuối cùng hoàn tất và được đối chiếu từ raw report
`preflight-20260927T150643Z.json`. Cả ba service trả `UP`; scan
`bb18a147-b168-43b8-a933-c15a72721f0e` hoàn tất 1/1 trang trong 2.344 ms, report
fresh, trang trả HTTP 200 trong 67 ms với 4.096 byte. Capture
`c8a68416-9fef-408f-956b-26713319da8d` hoàn tất trong 39.563 ms bằng Camoufox
152.0.4-beta.28; JPEG 27.073 byte có SHA-256
`9b3c98d51e7b66ca43b77e75f2d2514b98f6cf79f222d83d522f17fd7d53cf75`.
Reconstruction đóng gói 1/1 trang, trạng thái `PUBLISHED`, completeness
`COMPLETE`, archive 5.309 byte. Đây là bằng chứng E2E chức năng, không phải số đo
capacity hoặc browser throughput.

### Bảng thu số liệu cho lần đo đầu tiên

Chỉ dùng các nguồn sau khi quyền đọc, thời gian lấy mẫu và chỗ lưu raw artifact đã
được kiểm chứng. Mẫu thống nhất UTC mỗi 5 giây, chụp ít nhất 60 giây trước tải,
toàn bộ tải và 5 phút hồi phục. Gắn run ID ở tên artifact, không gắn URL, email,
token hoặc scan ID vào nhãn metric. Máy phát tải và fixture phải có mẫu CPU/RAM
riêng để loại trừ bão hòa nguồn phát/nguồn trang.

| Chỉ số | Nguồn và cách đối chiếu | Trạng thái |
| --- | --- | --- |
| API p50/p95/p99, lỗi, req/s, dropped iterations | k6 JSON theo endpoint và toàn workload; lưu cả cấu hình, thời gian, số VU, SLO và status code. | Kịch bản có; chưa chạy WebLens thật. |
| CPU/RAM, disk, network, process/browser count | `tools/load/collect-windows.ps1` ghi CPU/RAM, disk/network I/O, TCP state, service, process CPU/I/O/thread/handle/working set và browser process count. Máy k6 dùng cùng collector. | Smoke local/VPS và mẫu production đạt. |
| JVM heap/GC/thread, Hikari active/idle/pending | Actuator metrics chỉ qua loopback, yêu cầu `X-WebLens-Service-Token`; collector bỏ toàn bộ tag để không xuất URI/ID. | Đạt production: 401 khi thiếu token, 200 khi token đúng; có JVM memory, năm GC metric, JVM thread, mười Hikari metric, ba Tomcat thread metric và HTTP server metric. Public Caddy không trả catalog metrics. |
| Ba PostgreSQL: connection, wait/lock, transaction và query latency | Collector dùng `pg_stat_activity`, `pg_stat_database`, `pg_locks`, timeout 2 giây và không xuất query text. Production là PostgreSQL 17.11; cả ba role đọc được aggregate. `pg_stat_statements` chưa bật nên query latency chi tiết ghi `extension-disabled`; WAL chưa có quyền/nguồn riêng. | Đạt trong JSONL production. |
| Active/queued scan, pages/s, retry và queue age | Snapshot tổng hợp `scans`, `crawl_executions`, `scan_pages`, host lease và outbox. Retry được tính từ phần attempt vượt lần đầu; pages/s lấy delta page terminal giữa hai mẫu. | Truy vấn production đạt; preflight không để queue tồn. |
| Browser workers, capture queue/retry, artifact | Tổng hợp `capture_jobs`, `site_reconstruction_*`, outbox, `page_snapshots`; đối chiếu browser process trên host. | Truy vấn và process discovery đạt; số đo dưới tải sẽ lấy ở phase browser capacity. |
| ClickHouse và object storage | Hai role ClickHouse tách biệt đọc row counter của đúng database. Snapshot production: crawl 1.420 page metrics/ingestion receipts, 2.581 findings, 44.701 links; capture 1 rendered page/1 request/1 receipt, 0 resource body. | JSONL cuối thu đủ hai nguồn trong 369 ms và 110 ms. Có một lần kết nối tạm thời timeout, cần theo dõi khi baseline. R2 provider request/error/latency chưa có nguồn; ghi `N/A`, chỉ đối chiếu reference byte/object từ Capture PostgreSQL. |

Collector Windows ghi JSONL UTF-8, từ chối ghi đè file cũ và không đọc command
line của tiến trình. Chỉ khi có `-ProductionTelemetry`, nó đọc tệp environment
được bảo vệ trong bộ nhớ để xác thực tới các nguồn telemetry; URL kết nối,
credential, token và SQL không được serialize. Smoke bằng secret giả đạt. CPU
tiến trình là thời gian tích lũy; phải lấy delta giữa hai mẫu, chia cho thời gian
và số logical processor để ra CPU %. Quyền cho các truy vấn PostgreSQL/ClickHouse
đã được kiểm chứng; vòng JSONL production sau deploy metrics đã chạy thành công.

Restore drill PostgreSQL `postgres-migration-20260927-125717` đã được đối chiếu:
11 bảng Control Plane, 14 bảng Crawler và 13 bảng Capture có source/target count
giống từng byte. Ba dump lần lượt 369.150, 781.430 và 178.959 byte; SHA-256 khớp
manifest sau khi sao chép ra khỏi VPS. Đây là bằng chứng restore cho snapshot lúc
migration, không thay thế backup mới trước baseline và chưa chứng minh recovery
cho ClickHouse Cloud hoặc R2.

Gói collector/backup cuối tại `tmp/load/weblens-phase2-telemetry-v8b.zip` có
SHA-256 `33DDE90E513E0EF552A0E9BDE62AA5F99257BB955765918C747470454D4F90BC`.
Gói đã triển khai trên VPS và smoke test đạt. Nó chứa collector production,
smoke test chống rò secret, script backup ba PostgreSQL và README; không chứa
environment file hay credential. Mẫu production cuối nằm tại
`C:\ProgramData\WebLens\performance-fixture\runtime\telemetry-preflight-20260927T164747Z.jsonl`.

Backup trước baseline `performance-preflight-20260927T164814Z` gắn đúng commit
`f873c77903965b4d6c9ad2498969d594e7b01401`. Ba dump `weblens`,
`weblens_crawler`, `weblens_capture` lần lượt có kích thước 372.477, 776.723 và
181.572 byte; checksum trong manifest khớp bản sao ngoài VPS và cả ba TOC đọc
được bằng `pg_restore --list`.

Các truy vấn quan sát production phải chỉ đọc, có `statement_timeout` ngắn, không
quét HTML/payload hoặc xuất dữ liệu cá nhân. Khi một metric thiếu, không suy nó từ
CPU hay từ kết quả k6; cột đó để `N/A`, và không kết luận bottleneck tương ứng.

### Production preflight và rào chắn

VPS được người dùng chọn là production. Web chưa công khai không làm thay đổi việc
máy vẫn phục vụ domain và lưu dữ liệu thật. Chỉ mở route chính xác cho prefix
synthetic, giữ prefix khi reverse proxy, giới hạn phương thức và xác minh ngoài
prefix không bị fixture xử lý. Fixture trực tiếp trả 404 ngoài prefix, còn Caddy
tiếp tục phục vụ frontend hiện có; reverse proxy phải giữ nguyên prefix (`handle`,
không dùng `handle_path` của Caddy). Không đổi chính sách SSRF. Fixture bind loopback và chạy bằng tài
khoản ít quyền. Trước E2E cần xác nhận đường đi từ Crawler và Capture tới hostname
synthetic, fixture không redirect ra ngoài, và không có URL bên thứ ba trong scan.

Trước tải lớn phải chụp backup PostgreSQL mới và sao chép ra ngoài VPS; restore
drill ba database đã đạt trên snapshot migration. Vẫn phải xác minh phương án
khôi phục ClickHouse/R2, dung lượng còn lại và thời gian phục hồi. Đặt ngưỡng dừng cho CPU/RAM/disk, lỗi API,
queue age, retry và sức khỏe dịch vụ dựa trên baseline; giám sát cả thời gian hồi
phục. Bài đầu chỉ một scan/capture nhỏ bằng tài khoản riêng, kết thúc và đối soát
page/report/artifact rồi mới cân nhắc tăng tải. Raw artifact giữ ngoài kho Git;
dữ liệu benchmark chỉ dọn sau khi đã đối chiếu kết quả.

Tại điểm đóng Phase 2, chưa chạy baseline hoặc tối ưu runtime và
`READY_FOR_PHASE_3_BASELINE = YES`. Người dùng sau đó đã review, cho phép chạy
baseline; kết quả nằm ở Phase 3 dưới đây. Các bậc API lớn, crawler concurrency,
large scan, stress, spike, browser capacity và soak vẫn chưa chạy.

### Điều kiện hoàn tất Phase 2

1. Đạt: fixture synthetic chạy bằng tài khoản ảo ít quyền, route prefix riêng và
   chỉ trỏ đến tài nguyên do mình kiểm soát.
2. Đạt: test identity/website riêng; scan và capture một trang hoàn tất, đã đối
   chiếu report/page/JPEG/reconstruction.
3. Đạt: collector thu được CPU/RAM/process/browser, Actuator, ba PostgreSQL,
   ClickHouse, queue/retry và ghi rõ R2 provider telemetry là `N/A`.
4. Đạt: backup mới đã sao chép ra ngoài VPS và kiểm checksum/TOC; restore drill
   ba PostgreSQL trước đó đạt. Đã đến điểm dừng để người dùng review Phase 2.

## Phase 3 — Baseline production

Trạng thái: **hoàn tất; dừng tại review gate trước Phase 4**.

Lượt hợp lệ có run ID `20260928T040938Z`, release
`f873c77903965b4d6c9ad2498969d594e7b01401`. Raw artifact nằm ngoài Git tại
`tmp/load/phase3-20260928T040938Z`; `manifest.json`, sáu k6 summary/JSONL,
telemetry generator/VPS, scan/capture report và `analysis.json` đều đã được đối
chiếu. Diagnostic loopback được lưu ở `crawler-report-direct.json`. Summary k6
đã bỏ `setup_data`; kiểm tra lại không còn access token. Không
có email hoặc mật khẩu benchmark trong manifest/report.

### Môi trường và workload

| Thành phần | Cấu hình đã đo |
| --- | --- |
| Máy phát k6 | Windows 11 Pro 10.0.26200; AMD Ryzen 7 PRO 6850HS, 8 core/16 logical processor; 33.622.609.920 byte RAM; k6 2.2.0. |
| VPS production | Windows Server 2019 Datacenter 10.0.17763; 8 vCPU Intel Xeon Gold 6133; 7.515.635.712 byte RAM. |
| Control Plane | Temurin JRE 21.0.12.1, `-Xms256m`, `-Xmx1280m`; Tomcat max 100 thread; Hikari max 10 connection. |
| Dữ liệu | Một identity/website riêng; fixture 1.000 trang, fanout 10, delay 2 ms, body 4.096 byte; chỉ URL dưới `/__weblens-load/`. |
| API baseline | Warm-up 1 VU/30 giây; ba lượt 1 VU và ba lượt 10 VU, mỗi lượt 60 giây, nghỉ 10 giây giữa lượt. Mỗi vòng đọc 5 endpoint bằng cùng một account. |
| Scan/capture | Một scan bounded bắt đầu tại trang 9, graph đúng 100 trang; sau đó một capture cùng trang. |
| Thu thập | Local và VPS trong 15 phút, recovery 5 phút. Khoảng lấy mẫu thực tế median là 7,10 giây trên generator và 16,48 giây trên VPS do thời gian chạy các probe, dù interval cấu hình là 5 giây. |

### API baseline

Số dưới đây là median của ba lượt. `req/s` là `http_reqs` của k6 nên gồm hai
request setup cho mỗi lượt; số request đọc loại trừ setup.

| VU | Request đọc | req/s | p50 | p95 | p99 | Lỗi |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 535 | 2,956 | 21,3 ms | 605,6 ms | 620,1 ms | 0% |
| 10 | 5.085 | 27,195 | 19,1 ms | 774,7 ms | 886,9 ms | 0% |

Tăng từ 1 lên 10 VU làm throughput tăng khoảng 820%, trong khi p95 toàn workload
tăng 27,9%. Cả sáu lượt đều vượt giả thuyết SLO p95 < 300 ms, nhưng nguyên nhân
tập trung ở một endpoint:

| Endpoint | 1 VU p95 / p99 | 10 VU p95 / p99 |
| --- | ---: | ---: |
| `dashboard_summary` | 26,8 / 55,2 ms | 26,5 / 37,5 ms |
| `website_list` | 37,6 / 72,0 ms | 31,1 / 48,0 ms |
| `scan_list` | 31,5 / 43,0 ms | 31,4 / 45,9 ms |
| `scan_progress` | 26,4 / 37,6 ms | 28,3 / 42,0 ms |
| `scan_pages` | 627,6 / 733,2 ms | 891,3 / 1.011,8 ms |

Bốn API Control Plane thông thường đạt p95 < 300 ms. `scan_pages` chiếm 20% mix
và làm p95 tổng vượt SLO ngay ở 1 VU. Với Phase 4, giữ SLO p95 < 300 ms và p99 <
1 giây cho bốn endpoint thông thường; đề xuất tách SLO ban đầu của report
`scan_pages` thành p95 < 1 giây, p99 < 1,5 giây và lỗi < 1%. Đây là SLO để phát
hiện regression/capacity, không phải lý do bỏ qua việc tối ưu report.

### Scan và browser capture đơn

| Chỉ số | Kết quả |
| --- | ---: |
| Scan | `COMPLETED`, 100 discovered/processed/succeeded, 0 failed |
| Thời gian scan quan sát | 55,736 giây |
| Throughput scan | khoảng 1,79 trang/giây |
| Queue crawler | tối đa 86 trang; oldest queued age tối đa 36,644 giây; về 0 khi kết thúc |
| Retry trong cửa sổ đo | page/crawler analytics/crawler event: 0 |
| Capture | `COMPLETED` trong 27,153 giây; JPEG 38.079 byte; reconstruction `PUBLISHED`/`COMPLETE` |
| Browser process | tối đa 7, về 0 sau capture |

Đây chỉ là service time của một scan và một capture. Nó chưa phải crawler hoặc
browser capacity vì chưa có concurrency.

### Tài nguyên, DB và phục hồi

| Chỉ số | Kết quả |
| --- | --- |
| Generator | CPU p95 11,65%, max 26%; RAM dùng max khoảng 16,38 GiB/31,31 GiB. Không bão hòa nguồn phát. |
| VPS | Toàn lượt CPU p95 26,96%, max 47,6%; RAM dùng max khoảng 5,31 GiB/7,00 GiB; disk queue luôn 0. |
| VPS theo API | 1 VU: CPU median/max 7,85/8,8%. 10 VU: 22,6/30,1%. RAM dùng max khoảng 5,09 GiB ở 10 VU. |
| JVM/GC | `jvm.memory.used` max khoảng 370 MiB; 11 GC pause với tổng 0,268 giây; GC overhead max 0; live thread max 28. |
| Pool/thread | Hikari active max 6/10, pending 0, timeout tăng 0; Tomcat busy max 8/100. |
| PostgreSQL | Active connection max Control/Crawler/Capture lần lượt 1/2/5; lock wait 0, deadlock tăng 0, temp byte tăng 0. `pg_stat_statements` chưa bật nên query latency chi tiết là `N/A`. |
| ClickHouse probe | 55/55 mẫu available. Crawl query median/p95/max 301/372/527 ms; Capture 111/119/132 ms. Đây là probe tổng hợp, không phải timing từng query của API. |
| Object storage | Provider latency/error vẫn `N/A`; chỉ có reference counter từ Capture PostgreSQL. |
| Recovery 5 phút | CPU VPS median 5,4%, disk p95 1%, active scan 0, queued page 0, browser process 0. Ba service health trả 200/UP, fixture vẫn 1.000 trang, API ẩn danh 401 và release commit không đổi. |

### Bottleneck đầu tiên có bằng chứng

Điểm chậm đầu tiên là **đường đọc analytical report của Crawler cho
`GET /api/v1/scans/{scanId}/pages`**. Bằng chứng:

1. Ở 1 VU, `scan_pages` p50/p95 là 599,4/627,6 ms; bốn endpoint còn lại có p95
   26,4–37,6 ms.
2. Gọi trực tiếp Crawler qua loopback, bỏ Caddy/TLS/Control Plane, 10 request cùng
   report cho p50 587,0 ms và p95 599,1 ms. Gần toàn bộ độ trễ nằm sau boundary
   Crawler.
3. Code hiện tại đọc report state từ PostgreSQL rồi chạy tuần tự `ListPages`,
   `listFindingsForPages` và `ScanSummary` trên ClickHouse. Probe ClickHouse crawl
   riêng có median 301 ms.
4. Trong cùng cửa sổ, CPU, JVM, Hikari, Tomcat và PostgreSQL không cạn; không có
   lock, timeout hoặc lỗi HTTP.

Kết luận đủ chắc để khoanh vùng Crawler analytical report/chuỗi query ClickHouse,
nhưng chưa đủ để quy một query cụ thể vì production chưa có timing từng query.
Không thay đổi query, index, cache hoặc concurrency trong Phase 3. Trước tối ưu,
cần thêm timing cho ba bước hoặc benchmark từng query; sau đó chỉ thay một nguyên
nhân và chạy lại đúng workload ba lượt.

### Ghi chú thực thi và giới hạn

- Lần khởi động đầu dừng trước workload vì Crawler readiness tạm trả 503; hai lần
  kiểm tra kế tiếp và toàn lượt hợp lệ đều 200/UP. Chưa có đủ mẫu để gọi đây là
  sự cố tải.
- Một lượt bị loại đã hoàn tất scan/capture nhưng warm-up k6 gửi 0 request do k6
  2.2.0 không có global `URL`. Harness được sửa bằng phép tách hostname tương
  thích và archive/cú pháp đạt trước lượt hợp lệ.
- Collector nền VPS ban đầu bị Windows OpenSSH kết thúc cùng phiên SSH. Launcher
  cuối giữ phiên collector suốt lượt đo và có cleanup khi lỗi.
- Collector bắt đầu ngay trước scan nên không có 60 giây idle trước tải. Recovery
  cung cấp 21 mẫu idle sau tải; đây là baseline hồi phục tương đương, nhưng các
  spike ngắn hơn interval thực tế 16,48 giây có thể bị bỏ sót.
- Workload dùng một account chung và tối đa 10 VU. Không suy số distinct users,
  capacity hoặc saturation từ Phase 3.

`READY_FOR_PHASE_4_API_LOAD = YES`, sau khi người dùng review Phase 3 và chấp
nhận SLO tách riêng cho `scan_pages`. Phase 4 bắt đầu ở 50 VU với stop guard tài
nguyên/queue và không nhảy thẳng đến bậc cao hơn.

## Phase 4 — API load production

Trạng thái: **hoàn tất tại stop guard 50 VU; dừng tại review gate trước Phase 5**.

Lượt hợp lệ có run ID `20260928T051717Z`, cùng release và dataset của Phase 3.
Raw artifact nằm ngoài Git tại `tmp/load/phase4-20260928T051717Z`; gồm manifest,
k6 summary/JSONL, telemetry generator/VPS, seed report và `analysis.json`. Workload
dùng một account/token chung, 50 VU chạy tuần tự năm API đọc, nghỉ một giây sau
mỗi vòng. Vì vậy, VU ở đây là mức đồng thời của workload, không phải số người dùng
phân biệt.

### Kết quả 50 VU

| Cửa sổ | Thời lượng cấu hình | Request đọc | req/s | p50 | p95 | p99 | Lỗi |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Warm-up | 30 giây | 2.370 | 70,254 | 371,0 ms | 1.203,5 ms | 1.504,0 ms | 0% |
| Plateau | 60 giây | 4.785 | 75,022 | 345,1 ms | 1.105,5 ms | 1.455,3 ms | 0% |

`req/s` là `http_reqs` của k6 và gồm hai request setup. Warm-up và plateau đều
vượt cùng nhóm SLO, nên đây không phải nhiễu riêng của một cửa sổ. Chi tiết
plateau:

| Endpoint | p50 | p95 | p99 | SLO đạt? |
| --- | ---: | ---: | ---: | --- |
| `dashboard_summary` | 332,1 ms | 761,2 ms | 938,6 ms | Không, p95 |
| `website_list` | 256,4 ms | 571,7 ms | 745,4 ms | Không, p95 |
| `scan_list` | 264,0 ms | 672,8 ms | 872,3 ms | Không, p95 |
| `scan_progress` | 247,2 ms | 724,7 ms | 1.205,6 ms | Không, p95 và p99 |
| `scan_pages` | 927,5 ms | 1.430,6 ms | 1.896,3 ms | Không, p95 và p99 |

So với median baseline 10 VU, throughput chỉ tăng 175,9% khi số VU tăng 400%;
p50 tăng 1.709,7%, p95 tăng 42,7% và p99 tăng 64,1%. Không có lỗi HTTP, nhưng
độ trễ và hiệu suất mở rộng đã không còn đạt SLO.

### Tài nguyên, pool và phục hồi

| Chỉ số | Kết quả |
| --- | --- |
| Generator | CPU max 8%; RAM dùng max 46,43%. Nguồn phát không bão hòa. |
| VPS | CPU max 29,4%; RAM dùng max 71,19%. Không bão hòa CPU/RAM. |
| JVM/GC | `jvm.memory.used` max khoảng 358 MiB; 12 GC pause, tổng 0,209 giây; GC overhead max 0,038%; live thread max 68. |
| Hikari | Active max 10/10, idle min 0, pending max 28; timeout tăng 0. Pending đã về 0 ở mẫu đầu sau request cuối, không muộn hơn 1,174 giây. |
| Tomcat | Busy max 39/100, current max 50; chưa chạm trần thread. |
| PostgreSQL | Active query max Control/Crawler/Capture là 2/1/1; lock wait 0, deadlock tăng 0, temp byte Control tăng 0. Query latency chi tiết vẫn `N/A` vì `pg_stat_statements` chưa bật. |
| ClickHouse probe | Crawl median/p95/max 308/397,7/432 ms; Capture 113/121,6/123 ms. Đây là probe tổng hợp. |
| Queue/retry/browser | Không tạo scan trong phase này; active scan, queued page và mọi retry delta đều 0; browser process cuối là 0. |
| Recovery 90 giây | Control Plane, Crawler và Capture trả HTTP 200; fixture `UP`; API ẩn danh 401; queued page và browser process bằng 0. |

### Biên capacity đã đo và stop guard

Stop guard dừng ngay ở bậc 50 VU vì k6 fail SLO và Hikari có request chờ. Các
bậc 100, 250, 500 và 1.000 VU không chạy để tránh đẩy production qua một mức đã
biết là không bền vững.

- Mức cao nhất đã đo và đạt SLO: **10 shared VU**.
- Mức đầu tiên đã đo và không đạt: **50 shared VU**.
- Khoảng 11–49 VU chưa đo; chưa thể nêu một con số capacity chính xác hơn.
- Chưa đo distinct-user workload, nên không quy đổi thành 10 hay 50 người dùng.

### Bottleneck đầu tiên và nguyên nhân ứng viên

Tại 50 VU, Hikari đạt 10/10 và pending 28 trong khi PostgreSQL Control Plane chỉ
có tối đa hai query active, CPU VPS 29,4%, Tomcat busy 39/100 và lỗi HTTP 0%.
Điều này cho thấy connection đã checkout bị giữ trong lúc request chờ thành phần
khác, thay vì PostgreSQL đang thực thi đủ mười query.

`ScanReportService` hiện đặt `@Transactional(readOnly = true)` ở cấp class.
`listPages` đọc user/scan từ PostgreSQL rồi gọi đồng bộ sang Crawler trước khi
method và transaction kết thúc. Crawler tiếp tục chạy tuần tự phần đọc state,
`ListPages`, findings và `ScanSummary`; direct Crawler baseline p50 khoảng 587 ms.
Nguyên nhân ứng viên mạnh nhất là transaction quá rộng giữ Hikari connection qua
độ trễ Crawler/ClickHouse. Đây là kết luận từ tương quan telemetry và code path;
chưa có tracing theo request để chứng minh thời gian giữ từng connection.

Thay đổi có chủ đích đề xuất cho phase tối ưu là kết thúc phần DB authorization
trước outbound Crawler call, không tăng pool trước. Sau thay đổi phải chạy lại đúng
50 VU warm-up/plateau và baseline ba lượt để tính before/after. Chưa áp dụng tối
ưu nào trong Phase 4.

`READY_FOR_PHASE_5_CRAWLER_LOAD = YES`, sau khi người dùng review Phase 4. Việc
tối ưu API được giữ lại cho phase before/after sau khi các baseline cần thiết đã
được đo.

## Phase 5 — Crawler load production

Trạng thái: **hoàn tất tại rào chắn tài nguyên trước bậc 50 scan; dừng tại review
gate trước Phase 6**.

Các lượt hợp lệ dùng cùng release
`f873c77903965b4d6c9ad2498969d594e7b01401`. Raw artifact nằm ngoài Git tại:

- `tmp/load/phase5-20260928T080429Z`: bậc 1 và 5 scan.
- `tmp/load/phase5-20260928T081801Z`: lượt xác nhận sạch bậc 10 scan.
- `tmp/load/phase5-20260928T082634Z`: bậc 25 scan.
- `tmp/load/phase5-analysis-20260928/analysis.json`: kết quả hợp nhất.

Mỗi scan dùng một tài khoản, website và hostname synthetic riêng dưới wildcard do
người dùng kiểm soát. Cách này đo concurrency giữa các scan mà không bị giới hạn
hai slot cho cùng host làm sai mục tiêu. Mỗi hostname chỉ phục vụ
`/__weblens-load/*` qua HTTP tới fixture loopback; mọi path khác trả 404. Mỗi scan
có graph đúng 100 trang, fanout 10, delay 2 ms và body 4.096 byte. Route wildcard
tạm đã được tắt sau đo; route fixture chính HTTPS vẫn khỏe với 1.000 trang.

### Kết quả crawler concurrency

| Scan đồng thời | Accepted/terminal | Trang | Wall time | Throughput | Admission p95 | Scan median | Scan p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 100 | 55,523 giây | 1,8011 trang/giây | 102,3 ms | 55,522 giây | 55,522 giây |
| 5 | 5/5 | 500 | 113,136 giây | 4,4195 trang/giây | 105,1 ms | 113,001 giây | 113,022 giây |
| 10 | 10/10 | 1.000 | 214,531 giây | 4,6613 trang/giây | 99,2 ms | 213,796 giây | 213,972 giây |
| 25 | 25/25 | 2.500 | 527,294 giây | 4,7412 trang/giây | 202,9 ms | 503,778 giây | 524,672 giây |

Tất cả scan hợp lệ đều `COMPLETED`, 100% trang thành công và retry delta bằng 0.
Từ 1 lên 5 scan, throughput tăng 145,38%. Từ 5 lên 10, throughput chỉ tăng 5,47%
trong khi scan median tăng 89,20%. Từ 10 lên 25, throughput chỉ tăng thêm 1,71%
trong khi scan median tăng 135,64%. Vì vậy:

- Mức cao nhất đã đo bền vững: **25 concurrent scans**.
- Plateau throughput đầu tiên đã đo: **10 concurrent scans**.
- Breaking point: **chưa đo được**.
- Bậc 50 scan không được gửi vì RAM production trước tải không xuống dưới rào
  chắn 80%; bậc 75 và 100 không chạy vì bậc 50 chưa qua pre-load gate.

Không được diễn giải 25 là giới hạn tối đa của crawler. Đây chỉ là cận dưới đã đo
trong workload 100 trang/scan và cấu hình production hiện tại.

### Bottleneck đầu tiên có bằng chứng

Bottleneck đầu tiên là **throughput của đường persist/deliver analytics trong
Crawler**. Evidence chính:

1. Ở 10 scan, queued page đạt tối đa 715, `PERSISTING` đạt 723 và analytics
   pending đạt 623; fetch queue đã về 0 lúc `08:20:21Z`, nhưng active scan chỉ về
   0 lúc `08:22:51Z`.
2. Ở 25 scan, queued page đạt tối đa 1.410, `PERSISTING` đạt 2.093 và analytics
   pending đạt 1.993; fetch queue về 0 lúc `08:29:38Z`, nhưng active scan chỉ về
   0 lúc `08:37:04Z`.
3. Số analytics record claimed cùng lúc chạm đúng 100 ở các bậc 5, 10 và 25.
   Worker hiện là một vòng xử lý gọi `ClaimAnalytics(..., 100, ...)`; poll interval
   mặc định là 500 ms tại `crawler/internal/analytics/worker.go` và
   `crawler/internal/config/config.go`.
4. Throughput gần như phẳng ở 4,4195 → 4,6613 → 4,7412 trang/giây, trong khi độ
   trễ mỗi scan tăng mạnh và fetch queue đã rỗng trước khi scan hoàn tất.

Đây là bằng chứng mạnh để khoanh vùng analytics persistence/delivery. Chưa có
benchmark timing riêng cho từng thao tác insert/ack ClickHouse, nên chưa kết luận
một câu lệnh cụ thể là nguyên nhân cuối cùng. Phase này không thay batch size,
poll interval hoặc số worker.

### Tài nguyên, DB và phục hồi

| Chỉ số | Kết quả |
| --- | --- |
| Generator | Ở 25 scan: CPU max 33%, RAM dùng max 57,52%. Nguồn phát không bão hòa. |
| VPS | Ở 25 scan: CPU max 47,8%, RAM dùng max 88,55%. CPU chưa bão hòa; RAM là rào chắn để không gửi bậc 50. |
| JVM/GC | Ở 25 scan: heap metric dùng max khoảng 404,6 MiB/2,48 GiB metric max; 10 GC pause, tổng 0,173 giây; GC overhead max 0,041%; live thread max 36. |
| Hikari/Tomcat | Hikari active max 1/10, pending 0, timeout tăng 0; Tomcat busy max 2/100. Control Plane không phải điểm nghẽn của workload crawler này. |
| PostgreSQL | Active connection max Control/Crawler/Capture là 2/3/2; có một mẫu lock wait ở Control nhưng không có deadlock. `pg_stat_statements` vẫn tắt nên query latency chi tiết là `N/A`. |
| ClickHouse probe | Ở 25 scan, crawl query median/p95/max là 313,5/358,2/387 ms. Đây là probe tổng hợp, không phải timing insert/ack của analytics worker. |
| Queue/retry | Sau recovery, active scan, active execution, queued page, persisting page và analytics pending/claimed đều về 0; page, analytics và event retry delta của mỗi lượt hợp lệ đều 0. |
| Dịch vụ | Control Plane, Crawler, Capture và fixture đều trả 200/`UP`; browser process bằng 0; release commit không đổi. |

RAM không trở lại dưới 80% sau bậc 25 và bước seed chuẩn bị bậc 50, dù toàn bộ
queue đã sạch và dịch vụ khỏe. Harness ghi lượt `phase5-20260928T083934Z` là
`STOPPED_BEFORE_LOAD`; 50-scan workload chưa hề được submit.

### Lượt chẩn đoán bị loại

- `phase5-20260928T080429Z/10-scans` chỉ accepted 8/10 vì hai request admission
  timeout ở 5 giây. Hệ thống tự hồi phục; lượt xác nhận độc lập sau đó accepted và
  hoàn tất 10/10, nên chỉ lượt xác nhận được dùng trong bảng.
- Các lượt trước đó dừng ở health/pre-load gate hoặc lỗi helper của harness không
  được dùng để tính capacity. Một lượt một scan có RAM pre-load 90,58% cũng bị
  loại để tránh baseline bẩn.

`READY_FOR_PHASE_6_LARGE_SCAN = YES`, sau khi người dùng review Phase 5. Phase 6
phải bắt đầu bằng large scan có rào chắn tài nguyên; chưa tối ưu analytics trước
khi hoàn tất các baseline cần thiết.

## Phase 6 — Large scan trên production

Trạng thái: **hoàn tất lượt 1.000 và 10.000 trang**. Dừng tại review gate trước
phase tiếp theo; không dùng các lượt bị hủy để tính capacity.

Trước khi chạy đã backup mới cả ba PostgreSQL và tải bản sao ra máy local tại
`tmp/load/offhost-backups/performance-preflight-20260928T091312Z`; SHA-256 và TOC
được đối chiếu. Cùng release
`f873c77903965b4d6c9ad2498969d594e7b01401`, fixture synthetic do mình kiểm
soát, fanout 10, delay 2 ms, body 4.096 byte. VPS Windows Server 2019 có 8 vCPU,
RAM khoảng 7 GiB; mỗi scan có effective concurrency 20, Crawler 20 slot
toàn cục và 2 slot/host. Không gửi tải tới website bên thứ ba.

### Lượt 1.000 trang hợp lệ

Raw artifact: `tmp/load/phase6-20260928T094636Z-1000-pages`. Scan
`18adcb09-92d9-467f-8aff-dbdb07a3a005` trả `COMPLETED`, đúng 1.000/1.000
trang thành công, 0 trang lỗi. Effective config xác nhận `maxPages=1000`, depth 4,
concurrency 20. Runner chạy **548,464 giây**, throughput đầu cuối **1,8233
trang/giây**. Mốc này bao gồm admission, crawl, persist và chờ trạng thái terminal;
không phải tốc độ riêng của fetch worker.

| Chỉ số | Kết quả |
| --- | --- |
| API runner | 111 request thành công, 0 lỗi; p50/p95/p99 là 61/104/169 ms. Đây là request điều khiển và polling, không phải latency từng trang. |
| VPS | CPU max 25%; RAM dùng max 68,53%; host lease max 2. |
| Queue | `QUEUED` max 888 trang; `PERSISTING` max 10; analytics pending/claimed max 5/6. Tất cả về 0 sau recovery. |
| JVM/DB | GC tăng 5 pause, tổng 0,128 giây; Hikari pending max 0. Query latency chi tiết chưa có vì `pg_stat_statements` tắt. |
| Retry/browser | Page, analytics và event retry delta đều 0; browser process max 0. |

### Lượt 10.000 trang không hợp lệ để tính capacity

Production và fixture được tạm nâng lên 10.000 trang; health và effective config
đều xác nhận giới hạn này. Lượt `phase6-20260928T101147Z-10000-pages`, scan
`0f05bedb-4104-44b8-b673-cdb3f2ed37e6`, chạy tới 1.577 trang thành công.
Phiên giám sát local bị ngắt khi scan còn chạy; scan sau đó được hủy có chủ đích
qua API. Trạng thái cuối trong database là `CANCELLED` với 8.423 trang bị hủy.
Telemetry VPS đã sao chép về cùng thư mục artifact: CPU max 32,5%, RAM max
66,86%, `QUEUED` max 8.881 trang trong cửa sổ quan sát. Các số này chỉ mô tả
lượt dở dang; không suy ra thời gian hoàn tất hoặc saturation point 10.000 trang.
Một lượt 10.000 trước đó bị loại ngay vì Backend cũ vẫn dùng giới hạn 1.000.

Script hoàn nguyên ban đầu chờ Backend health 30 giây, quá ngắn cho lần restart
production này. Sau khi tăng thời gian chờ lên 120 giây, hoàn nguyên thành công:
`WEBLENS_SCAN_MAX_PAGES=1000`, fixture config/health cùng 1.000 trang, state tạm
đã xóa. Control Plane, Crawler, Capture và fixture trả `UP`; release không đổi;
active scan/execution, queued page, host lease, analytics pending và browser
process đều bằng 0. RAM dùng 64,05% ở mẫu hậu kiểm. Route HTTPS trả fixture
health 1.000 trang và trang 999 đúng 4.096 byte; path ngoài prefix vẫn là
frontend. Không có tối ưu runtime nào được áp dụng trong Phase 6.

### Lượt 10.000 trang hợp lệ

Trước lượt cuối, backup mới cả ba PostgreSQL được tải ra local tại
`tmp/load/offhost-backups/performance-preflight-20260928T113245Z`; SHA-256 và
`pg_restore --list` đạt. Tác vụ Windows độc lập giữ runner và guard hoạt động khi
phiên điều khiển ngắt, tự hoàn nguyên production sau khi thu telemetry. Một lượt
trước đó bị 401 do access token hết hạn sau 15 phút đã được hủy và hoàn nguyên;
runner được sửa để đăng nhập lại trước khi token hết hạn. Lượt đó không tính vào
benchmark.

Raw artifact hợp lệ: `tmp/load/phase6-20260928T113419Z-10000-pages`, gồm
`manifest.json`, `runner-report.json`, telemetry generator/VPS và guard. Scan
`dfb15eff-b36a-413e-93bd-e7de3160f7ba` trả `COMPLETED`, đúng
**10.000/10.000 trang thành công**, 0 trang lỗi. Effective config xác nhận
`maxPages=10000`, depth 4, concurrency 20. Runner đăng nhập lại 6 lần, chạy
**5.718,569 giây** (95,31 phút), throughput đầu cuối **1,7487 trang/giây**.
Thời gian này gồm admission, crawl, persist và chờ trạng thái terminal; không phải
tốc độ riêng của fetch worker. Fixture do mình kiểm soát có fanout 10, delay 2 ms
và body 4.096 byte.

| Chỉ số | Kết quả |
| --- | --- |
| API runner | 1.121 request thành công, 0 lỗi/timeout; p50/p95/p99 là 61/202/574 ms. Đây là request điều khiển và polling, không phải latency từng trang. |
| VPS | CPU max 33,1%; RAM dùng max 69,32%; host lease max 2/2. Ba health endpoint luôn trả 200 trong guard. |
| Queue | `QUEUED` max 8.879 trang, `PERSISTING` max 60; analytics pending/claimed max 27/52. Các queue và host lease đều về 0 ở mẫu cuối. |
| JVM/DB | JVM memory used max khoảng 362 MiB; GC tăng 40 pause, tổng 1,220 giây; Hikari active max 1/10, pending 0; PostgreSQL active max Control/Crawler/Capture là 2/3/3. Query latency chi tiết vẫn `N/A` vì `pg_stat_statements` tắt. |
| Retry/browser | Page, analytics và event retry delta đều 0; browser process trên VPS max 0. Đây không phải benchmark browser worker. |
| Máy phát tải | CPU median/p95/max 7/54/100%; RAM dùng median/p95/max 61,97/86,55/92,52%. Có các đỉnh tài nguyên cục bộ, nên không quy đổi lượt này thành capacity tổng quát. |
| Recovery | Telemetry tiếp tục 180 giây sau scan; Control Plane, Crawler, Capture khỏe, queue/lease bằng 0. |

Tác vụ kết thúc `COMPLETED_RESTORED`. Kiểm tra trực tiếp sau đó xác nhận
`managed=false`, `WEBLENS_SCAN_MAX_PAGES=1000`, fixture config/health cùng 1.000
trang, Backend và fixture khỏe. Route HTTPS trả health 1.000 trang; release
`f873c77903965b4d6c9ad2498969d594e7b01401` không đổi. Lượt 10.000 chỉ
chứng minh **một scan 10.000 trang hoàn tất** dưới workload và cấu hình này;
không xác định được số concurrent large scans, saturation hay breaking point.
Không có tối ưu runtime trong Phase 6, nên không có số liệu before/after.

### Preflight ngày 2026-09-29: 50 tài khoản × 1.000 trang

Yêu cầu mới là 50 tài khoản riêng, mỗi tài khoản gửi một scan 1.000 trang đồng
thời, tổng workload dự kiến 50.000 trang trên 50 hostname synthetic riêng. Bài
đo **chưa được gửi tải** vì VPS production không đạt rào chắn tài nguyên trước
load (`RAM < 80%` ở hai mẫu liên tiếp). Ba mẫu trực tiếp lúc
04:44:23/04:45:29/04:46:45 UTC cho thấy RAM dùng lần lượt
87,84%/88,84%/88,26%; RAM trống khoảng 0,85/0,78/0,82 GiB. CPU tương ứng
45,75%/38%/38,38%. Release vẫn là
`f873c77903965b4d6c9ad2498969d594e7b01401`; giới hạn production và fixture
đều 1.000 trang, Backend/fixture khỏe, route hostname synthetic vẫn tắt. Không
tạo tài khoản, website hay scan cho lượt này.

Lượt 25 scan × 100 trang trước đó đã chạm 88,55% RAM, nên không ngoại suy nó
thành khả năng chạy 50 scan × 1.000 trang. Khi production trở lại dưới rào chắn,
cần chạy bằng harness có timeout phù hợp với 50.000 trang, guard hủy scan nếu
dịch vụ hoặc tài nguyên vượt ngưỡng, và đối chiếu 50 trạng thái terminal trước
khi công bố capacity. **Tại thời điểm preflight này chưa có số liệu 50 user crawl
đồng thời.**

## Bài đo bổ sung 2026-09-29 — 50 tài khoản × 1.000 trang

Trạng thái: **đã gửi tải, dừng bởi guard; chưa chứng minh 50 scan hoàn tất**.
Mỗi tài khoản riêng có một website synthetic trên hostname riêng và gửi đúng một
scan. VPS vẫn chạy release `f873c77903965b4d6c9ad2498969d594e7b01401`, giới
hạn 1.000 trang/scan. Backup mới của ba PostgreSQL đã tải ra local tại
`tmp/load/offhost-backups/performance-preflight-20260929T091746Z`; dung lượng,
SHA-256 và TOC đều khớp. Route hostname synthetic được tắt sau lượt chạy.

Lượt đầu `tmp/load/phase7-50x1000-20260929T091118Z` **không hợp lệ để tính
capacity**: harness trỏ trang bắt đầu tới `/__weblens-load/page/0`, trong khi
fixture đặt trang 0 ở `/__weblens-load/`. 50/50 scan được nhận rồi `FAILED` sau
một trang trả 404 mỗi scan. Đã sửa URL và kiểm tra trang gốc trả HTTP 200 trước
khi chạy lại.

Lượt chạy lại có raw artifact tại
`tmp/load/phase7-50x1000-20260929T091943Z`. API nhận **50/50 scan**; admission
p50/p95 là 190,1/276,1 ms, k6 không báo lỗi admission. Đến khoảng 09:40 UTC,
guard yêu cầu hủy vì Crawler readiness thất bại. Trong cửa sổ thu mẫu, VPS CPU
max 66,2%, RAM dùng max 49,56%; Hikari pending max 0, timeout delta 0; retry
page/analytics/event delta đều 0. Peak active scan/execution là 50/50. Collector
ghi 8.523 trang mới ở trạng thái `SUCCEEDED` trước khi kết thúc cửa sổ thu mẫu,
nhưng **không có 50 scan terminal thành công** nên không tính pages/sec capacity.

Crawler `/health/live` trả 200 nhưng `/health/ready` trả 503. Code readiness kiểm
tra analytics outbox `PENDING`/`CLAIMED`/`DEAD` cũ hơn ngưỡng mặc định 15 phút;
production không override ngưỡng này. Telemetry tại thời điểm dừng cho thấy
analytics `PENDING` khoảng 28.447, trang `PERSISTING` khoảng 28.547. Đây là bằng
chứng backlog analytics làm Crawler mất readiness; không có bằng chứng CPU/RAM
hoặc Hikari cạn. Sau 10 phút chờ hủy và 90 giây recovery, 7 scan của lượt này
đã `CANCELLED`, 43 scan còn `CANCEL_REQUESTED`; Crawler readiness vẫn 503.
Recovery chưa hoàn tất tại 09:55 UTC. Việc theo dõi chỉ đọc sau đó cho thấy
analytics outbox giảm đều từ 24.147 bản ghi lúc 09:59 UTC về **0 lúc 11:25 UTC**.
Hai mẫu 11:25 và 11:26 UTC xác nhận không còn scan active, Control Plane/Crawler
live/Crawler ready/Capture đều HTTP 200. Truy vấn đúng nhóm tài khoản của lượt
chạy lại trong Control Plane cho thấy **50/50 scan cuối cùng `CANCELLED`**.
Production giữ nguyên release, giới hạn 1.000 trang/scan, fixture chính khỏe và
route 50 hostname synthetic đã tắt. Credential tạm của harness không được lưu.

Kết luận có thể dùng: **WebLens nhận được 50 yêu cầu scan đồng thời trên workload
1.000 trang/tài khoản, nhưng không duy trì được Crawler readiness đến khi chúng
hoàn tất**. Đây là mức đầu tiên đã đo cho workload 50 × 1.000 và bị stop guard;
không phải bằng chứng rằng hệ thống hỗ trợ 50 concurrent users crawl hoàn tất.
Điểm nghẽn đầu tiên có bằng chứng là đường delivery/ack analytics: backlog làm
readiness vượt ngưỡng 15 phút trong khi CPU, RAM và Hikari còn dư.

## Chẩn đoán analytics 2026-09-30 — trước tối ưu

Release chẩn đoán `5f7d6c3194209b221f618526d54f91ec9a98555c` chỉ thêm timing
theo stage, không thay đổi concurrency hoặc hành vi xử lý. Workload dùng 10 tài
khoản, 10 scan đồng thời và tối đa 1.000 trang/scan trên fixture synthetic. Sau
khi thu đủ 11 batch đầy đủ, toàn bộ scan được yêu cầu hủy để giới hạn ảnh hưởng
lên production.

Mỗi batch chứa 100 trang. Giá trị trung bình của 11 batch:

| Stage | Thời gian trung bình | Tỷ lệ trên tổng |
|---|---:|---:|
| Claim PostgreSQL | 46,45 ms | 0,21% |
| Tra receipt ClickHouse | 18.314,45 ms | 83,29% |
| Insert page metrics | 505,18 ms | 2,30% |
| Insert findings | 516,18 ms | 2,35% |
| Insert links | 469,36 ms | 2,13% |
| Insert receipts | 436,64 ms | 1,99% |
| Acknowledge PostgreSQL | 1.636,09 ms | 7,44% |
| Tổng | 21.988 ms | 100% |

`receiptExists` thực hiện tuần tự một truy vấn ClickHouse cho từng trang. Riêng
100 lần tra receipt mất trung bình 18,31 giây, trong khi bốn lượt insert cộng lại
chỉ khoảng 1,93 giây. Throughput suy ra từ timing là khoảng 4,55 trang/giây,
khớp với plateau 4,4–4,74 trang/giây ở các bài đo crawler trước đó. Đây là bằng
chứng trực tiếp xác định truy vấn receipt tuần tự là bottleneck đầu tiên; bước
acknowledge từng trang trong PostgreSQL là ứng viên thứ hai.

Tại snapshot giữa lượt chạy, 10 scan đang RUNNING, CPU 40,1%, RAM dùng khoảng
49%, Hikari pending 0, analytics retry không tăng; queue có 6.786 trang và
2.269 trang ở `PERSISTING`. Điều này tiếp tục loại trừ CPU, RAM và connection
pool Control Plane là nguyên nhân đầu tiên của plateau trong workload này.

### Tối ưu có chủ đích và benchmark lại

Commit `9e87e8b0c95ea1791dcc4814793e45b1e391ca36` thay 100 truy vấn receipt
tuần tự bằng một truy vấn ClickHouse cho cả batch, dùng đủ bộ khóa
`owner_id`, `aggregate_id`, `batch_id`. Không đổi schema, batch size, concurrency
hay giới hạn scan. `go test ./...`, `go vet ./...`, `git diff --check` và toàn bộ
CI/deploy run `36613927956` đều đạt. Production xác nhận chạy đúng commit này.

Lượt sau tối ưu dùng lại 10 tài khoản riêng, 10 hostname synthetic, 10 scan đồng
thời và 1.000 trang/scan. Hai lượt đầu sau deploy không hợp lệ vì route wildcard
synthetic chưa bật: HTTP bị từ chối ở cổng 80; HTTPS gặp lỗi TLS của hostname
wildcard. Sau khi bật đúng route HTTP và preflight trang fixture trả 200, lượt
`20260929T185759Z` hoàn tất **10/10 scan, 10.000/10.000 trang thành công** trên
cả Crawler và Control Plane, không có trang lỗi. Thời gian từ scan đầu được nhận
đến scan cuối hoàn tất là 1.050,53 giây, tương ứng **9,52 trang/giây** cho toàn
bộ workload. Harness đọc API bị HTTP 401 do access token hết hạn ở cuối lượt;
trạng thái terminal và thời gian được xác nhận trực tiếp từ hai PostgreSQL.

Log analytics của đúng cửa sổ đo có 587 batch, tổng 10.000 receipt được kiểm tra
và acknowledge, 0 batch failed, 0 retry. Batch sau tối ưu chứa trung bình 17,04
trang do tốc độ fetch và poll hiện tại; thời gian tra receipt trung bình là
183,75 ms/batch. Để tránh so sánh hai batch khác kích thước như nhau, chuẩn hóa
theo mỗi trang:

| Chỉ số | Trước | Sau | Thay đổi |
|---|---:|---:|---:|
| Tra receipt/trang | 183,14 ms | 10,79 ms | giảm **94,11%** |
| Lượt tra ClickHouse cho 100 trang | 100 | 1 theo batch 100 trang; 587 lượt cho 10.000 trang thực đo | giảm số lượt theo cơ chế batch |
| Workload 10 × 1.000 hoàn tất | Bị guard hủy sau khi đủ mẫu timing | 10/10 scan, 10.000 trang | Chỉ lượt sau có throughput hoàn chỉnh |

Telemetry sau tối ưu có 49 mẫu từ 18:57:47 đến 19:15:53 UTC: CPU trung bình
27,26%, max 51,6%; RAM dùng max 50,97%; Hikari active max 1, pending max 0,
timeout delta 0; queued page max 7.052, `PERSISTING` max 85; analytics pending
max 28, claimed max 57. Page/analytics/event retry delta đều 0; browser process
max 0. Sau lượt đo, backlog analytics và scan active đều về 0, Control Plane,
Crawler live/ready và Capture đều HTTP 200; cả hai route fixture đã tắt.

**Giới hạn so sánh:** Lượt trước dùng đúng workload 10 × 1.000 nhưng bị hủy có
chủ đích sau khi thu timing, nên không có throughput hoàn chỉnh trước tối ưu để
tính phần trăm cải thiện throughput end-to-end. Con số 94,11% là cải thiện được
đo cho bước tra receipt trên mỗi trang; 9,52 trang/giây là throughput hoàn chỉnh
của lượt sau. Đây chưa phải bằng chứng cho capacity 50 scan × 1.000 trang hoặc
breaking point mới.

## Capacity, saturation, bottleneck và before/after

Trong workload API shared-account đã đo, 10 VU đạt SLO và 50 VU là mức đầu tiên
không đạt; điểm chính xác nằm trong khoảng chưa đo 11–49 VU. Bottleneck API đầu
tiên là pool Hikari Control Plane bị cạn, với ứng viên nguyên nhân là transaction
bao trùm outbound report call.

Trong workload crawler 100 trang/scan, 25 concurrent scans là mức cao nhất đã đo
bền vững và throughput bắt đầu plateau ở 10 scan. Breaking point chưa đo vì bậc
50 dừng trước khi gửi tải theo rào chắn RAM. Bottleneck crawler đầu tiên là backlog
analytics persistence/delivery sau khi fetch queue đã rỗng.

Large scan 1.000 và 10.000 trang đã hoàn tất ở lần lượt 1,8233 và 1,7487
trang/giây trên fixture synthetic trước tối ưu. Hai workload khác độ sâu và thời
lượng, nên không diễn giải chênh lệch này là cải thiện hay suy giảm do tối ưu.
Tối ưu tra receipt giảm 94,11% thời gian stage trên mỗi trang; lượt 10 scan ×
1.000 trang sau tối ưu hoàn tất 10/10 ở 9,52 trang/giây. Chưa có phần trăm cải
thiện throughput end-to-end của cùng workload hoàn chỉnh vì lượt trước bị hủy.
Spike, stress, browser capacity và soak còn chưa đo. Chưa có breaking point mới
hoặc bằng chứng 50 scan × 1.000 trang hoàn tất để ghi CV. Lượt 50 tài khoản ×
1.000 trang ngày 2026-09-29 bị guard dừng vì Crawler readiness 503 khi analytics
backlog quá tuổi; không được tính là 50 scan hoàn tất.
