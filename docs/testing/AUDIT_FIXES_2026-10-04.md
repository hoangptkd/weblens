# Audit remediation — 2026-10-04

## Phạm vi và quyền hạn

Người dùng đã cho phép tự động sửa sau audit. Lượt này sửa code và kiểm tra cục bộ;
không commit, push, publish release, deploy, sửa Windows service hoặc truy cập production.
Giữ ba deployable hiện có, không thêm dependency/infrastructure, không thiết kế lại
core schema và không sửa/xóa migration đã áp dụng. Chỉ bổ sung checksum vào bảng
metadata `capture_schema_migrations` do migration runner quản lý.

Workspace có sẵn 44 file tracked bị sửa và nhiều file untracked trước lượt này.
Các thay đổi nền đó không phải kết quả của lượt remediation. Đối chiếu diff ban đầu
cho thấy chỉ sửa tiếp sáu file tracked đã dirty: AuthenticationService, crawler engine
và test, publisher, PostgreSQL store và integration test. Các file dirty còn lại giữ nguyên.
Hai test untracked có sẵn cũng được bổ sung: AuthenticationServiceTest và publisher_test.

## Trạng thái findings

“Đã sửa” dưới đây chỉ nói failure mode cụ thể đã được xử lý trong code và kiểm tra
được nêu; không khẳng định mọi luồng đúng hoặc production đã được chứng minh an toàn.

| Finding | Thay đổi tối thiểu / vị trí | Bằng chứng và giới hạn |
| --- | --- | --- |
| F01 — duplicate ACK | `crawler/internal/events/publisher.go`: nhận `IGNORED_DUPLICATE` như ACK thành công. | `publisher_test.go` kiểm tra ACK thật của Control Plane; go test qua. |
| F02 — capture crash ở lần cuối | `capture-worker/src/database.ts`: claim sweep chuyển lease RENDERING hết hạn ở attempt >= 3 sang FAILED, cùng transaction với terminal event. | PostgreSQL integration xác nhận FAILED và chỉ một terminal event. |
| F03 — stale worker overwrite | `capture-worker/src/index.ts`: recheck lease trước upload; object key chứa lease generation. | Integration chứng minh DB fencing; chưa chạy hai browser/S3 worker thật để mô phỏng overwrite. |
| F04 — cleanup sau COMMIT mơ hồ | `site-worker.ts`, `index.ts`: không xóa final object chỉ vì mất COMMIT response. `site-database.ts`: giữ bản ghi STAGED hết hạn cho GC thay vì xóa reference; dùng lifecycle constraint hiện có. | Hai worker test mô phỏng COMMIT đã áp dụng nhưng mất ACK ở page/publish. PostgreSQL test xác nhận retry và STAGED GC. Lỗi mạng thật giữa DB và S3 chưa inject. |
| F05 — DEAD không recover | `ControlMessagingRepository.java`, crawler `store.go`, capture `database.ts`/`site-database.ts`: DEAD đến hạn được claim lại, giữ ID/payload, cooldown ít nhất 5 phút sau 20 attempts. | Go và capture PostgreSQL test xác nhận cooldown/recovery cùng identity. Control Plane SQL chưa được integration-test cục bộ vì Docker không chạy. DEAD vẫn tham gia ordering/backpressure; poison payload vẫn cần cảnh báo và xử lý vận hành. |
| F06 — budget/memory | `capture.ts`: chặn request vượt số lượng, copy bounded slice để không giữ oversized backing Buffer; `safe-proxy.ts`: đếm transport bytes, đóng socket khi vượt budget. | Buffer regression và proxy socket/budget test qua. **Sửa một phần:** encrypted/compressed wire bytes không phải decompressed/browser memory; managed context dùng budget proxy theo session, chưa có per-job wire budget riêng. Chưa có hard process-tree memory/CPU isolation. |
| F07 — remote I/O trong transaction | `CaptureService.java`: remote page read trước short write transaction; revalidate dưới user lock. Capture/site report & artifact methods dùng NOT_SUPPORTED. `AuthenticationService.java`: bcrypt registration ngoài transaction; user/session write cùng transaction. | Spring proxy boundary test cho capture remote read, replay không gọi crawler và registration hashing/write qua. Không dùng mock đơn thuần để suy ra annotation transaction đã hoạt động. |
| F08 — download RAM/admission | Capture `storage.ts`/`server.ts` và Java `ArtifactDownload`/DTO/controllers/filter: archive spool qua file tạm, đếm bytes thực, kiểm SHA-256 trước response; tối đa hai persisted artifact transfers mỗi service. | Unknown Content-Length overflow/hash tests; Java filter cleanup khi client disconnect và reject transfer thứ ba; owner/integrity server tests qua. Chưa đo peak RAM/disk dưới tải; crash có thể để lại temp file cần cleanup policy. Screenshot/resource nhỏ phía Java vẫn dùng bounded byte array. |
| F09 — page concurrency race | `site-database.ts`: advisory transaction lock serialize admission ngắn, không serialize rendering. | PostgreSQL integration: tám concurrent claims với pageConcurrency=1 chỉ nhận một page, page tiếp theo được nhận sau complete. Chưa benchmark throughput của global admission lock. |
| F10 — readiness giả | `analytics.ts`: kiểm `success` của ClickHouse SDK ping. | Fake SDK trả success=false phải fail readiness; chưa gọi ClickHouse thật trong lượt này. |
| F11 — truncated HTML là complete | crawler `engine.go`: BODY_TRUNCATED => FAILED/warning, return trước parse và deterministic content findings. | Regression test qua. Thay đổi này chủ động không cung cấp kết luận nội dung trên body thiếu dữ liệu. |
| F12 — browser panel ordering/lifecycle | `ManagedBrowserPanel.tsx`: poll tuần tự, generation/sequence guard, action admission, revoke object URL và reset khi clone đổi/unmount. | Hai panel regression test qua; không coi đây là full browser E2E. |
| F13 — release thiếu runtime | `build-release.ps1`: giữ runtime trong ZIP, dùng staging directory duy nhất. `deploy.ps1`: nhận bundled runtime mới, fallback runtime cũ chỉ khi checksum khớp. | Bảy fixture smoke scenarios qua, không chạy deploy script đầy đủ. Chưa build ZIP thật với Camoufox hay khởi động WinSW. |
| F14 — migration không checksum | `database.ts`: SHA-256 check, fail mismatch/missing file; legacy NULL checksum bootstrap. `deploy.ps1`: đối chiếu migration với previous release trước bootstrap. | PostgreSQL test migrate hai lần và reject checksum mismatch; smoke reject migration sửa nội dung. Legacy DB không có checksum không thể tự chứng minh lịch sử trước baseline; cần previous release tin cậy. |
| F15 — lỗi ghi retry làm thoát delivery loop (bổ sung lúc sửa, P1) | `index.ts`, `site-worker.ts`: catch/log lỗi retry persistence; vòng tiếp tục claim, lease hết hạn vẫn recover được từ DB. | Worker regression mô phỏng delivery 503 + DB retry failure và xác nhận vòng tiếp tục polling. Chưa fault-inject DB outage thật. |

## Các rủi ro xác minh từ audit

- R01 — Auth throttling: thêm single-node 60 requests/IP/phút và tối đa bốn auth
  requests đồng thời. Map bounded 10.000 địa chỉ; chỉ đọc hop X-Forwarded-For cuối
  khi peer là loopback. Test không cho public peer bypass bằng spoofed header.
  Chưa triển khai account/distributed limiter; cần xác nhận API chỉ nhận traffic
  qua proxy tin cậy và NAT/shared-IP policy phù hợp. Restart sẽ reset counters.
- R02 — Browser deadline/isolation: thêm launch/capture deadlines, proxy connect/idle
  timeouts, socket shutdown, environment allowlist cho cả Chromium và shutdown watchdog.
  Deadline ở application không bảo đảm browser child process bị OS thu hồi khi crash/hang;
  managed session setup/context vẫn cần stress/fault-injection và hard isolation review.
- R03 — Release approval: chuyển production environment gate lên release job trước
  khi publish artifact; workflow không cancel run đang active. Static gate placement
  check qua. **Required reviewers/rules của GitHub environment là cấu hình bên ngoài,
  chưa xác minh**; YAML không tự tạo approval rule. Chưa chạy workflow thật/actionlint.
- R04 — Browser session liên instance: giữ in-memory session theo single-capture-instance
  topology; deduplicate concurrent starts cùng clone/owner. Không bổ sung persistence
  cookie hoặc hạ bảo vệ ownership. Scale-out cần thiết kế riêng và approval.
- R05 — Retention: GC giữ ownership của STAGED object khi retry. Chưa xác minh R2/MinIO
  bucket lifecycle, object không có DB reference, DB/ClickHouse purge hoặc temp-file
  retention sau process crash. Không tự chọn retention/schema khi chưa có workload.
- R06 — Backup/restore/rollback: chưa chạy restore drill hoặc rollback với migration
  thật. Junction rollback không hoàn tác schema. Phải chứng minh compatibility của
  release trước với schema mới trước production rollout.
- R07 — Frontend fetch: thêm deadline 30 giây mặc định, 65 giây cho browser-session
  startup, 120 giây artifact, refresh 15 giây; giữ caller AbortSignal. Regression
  kiểm tra deadline selection và cancellation qua. Retry 401 có deadline mới, nên
  không phải total end-to-end deadline cho toàn bộ refresh/retry chain.

## Kiểm tra đã chạy

| Thành phần | Lệnh / môi trường | Kết quả cuối |
| --- | --- | --- |
| Backend | `backend/mvnw.cmd -B verify`, Java 21 | 93 unit/MVC/architecture tests qua; 24 integration tests **skip** vì Docker daemon không có. Build thành công. |
| Crawler | `go test -count=1 ./...` và `go vet ./...`; WEBLENS_TEST_POSTGRES_URL trỏ DB tạm | Qua, gồm PostgreSQL workflow integration. ClickHouse integration skip vì không cấu hình endpoint. |
| Crawler race detector | `go test -race ./...` | Không chạy được: CGO/compiler C chưa cấu hình. Không suy ra absence of races. |
| Capture | `npm test`, `npm run typecheck`, `npm run build`; CAPTURE_TEST_DATABASE_URL trỏ DB tạm | 61 tests: 54 pass, 7 skip (6 browser smoke, 1 MinIO). Hai PostgreSQL integration tests thực sự chạy và qua. |
| Frontend | `npm test`, `npm run lint`, `npm run build` | 39 tests qua, lint/build qua. |
| Release | `infra/production-windows/release-runtime-smoke-test.ps1` | 7 scenarios qua: first install, bundled upgrade, compatible/incompatible legacy, tampered runtime/migration, legacy first install reject. PowerShell parse và static gate check qua. |

PostgreSQL tạm dùng bản local 18.4, bind loopback port 55487, schemas riêng được
test tạo/drop. Không phải DB production hoặc bằng chứng tương thích chính xác PG17
trong CI/production. DB tạm đã được stop sau kiểm tra; cluster files được giữ ở thư
mục tạm do lượt audit tạo, không xóa dữ liệu người dùng. UTF-8 và diff whitespace
checks qua. Backend coverage report có cảnh báo execution data cũ không
khớp ControlMessagingRepository; không dùng coverage đó để tuyên bố mức bao phủ.
Không có full E2E, load test, live ClickHouse/S3, browser process kill drill,
dependency-CVE clearance hay production monitoring validation trong lượt sửa này.

## Điểm cần chốt trước deploy

1. **Mâu thuẫn tài liệu:** ARCHITECTURE và accepted ADR-010 ghi Neon; README/bootstrap
   production hiện ghi PostgreSQL local 17, loopback 5433. Chưa chọn bên nào làm sự thật
   production; không thay runtime topology. Cần người dùng xác nhận rồi cập nhật ADR/docs.
2. Chạy 24 backend integration tests trên Docker/PG17 và live S3/ClickHouse/browser
   smoke. Fault-inject commit ACK loss, worker kill và network outage trong staging.
3. Xác nhận GitHub production required reviewers; build release thật, kiểm ZIP/runtime
   và restart services trên staging. Kiểm tài nguyên archive download và browser limits.
4. Chốt bucket/temp/DB retention, monitoring DEAD backlog và phục hồi poison message;
   restore drill và rollback compatibility. Đây là công việc môi trường/thiết kế tiếp
   theo, không được đánh dấu hoàn tất bằng unit tests.

## What the developer should understand before accepting this code

- Spring annotation chỉ có hiệu lực qua proxy. Remote I/O/bcrypt nằm ngoài transaction;
  bước write phải revalidate dưới lock vì dữ liệu có thể đổi trong lúc chờ.
- Lease/fencing kiểm soát quyền ghi DB; generation-specific object key ngăn stale worker
  ghi đè object của generation mới. Mất COMMIT ACK không chứng minh rollback: không xóa
  artifact có thể đã được tham chiếu; để DB/GC quyết định lifecycle.
- Outbox là at-least-once. DEAD là slow-retry, không phải discard; idempotency vẫn bắt
  buộc, và poison message không được tự sửa payload hoặc bỏ qua ordering.
- Backpressure và bounded spool giảm peak RAM nhưng chuyển áp lực sang disk. Wire budget
  không thay thế OS resource isolation. Các ngưỡng single-node không phải distributed quota.
- Checksum chỉ bảo vệ từ baseline đã biết. Applied migrations giữ nguyên; binary rollback
  chỉ an toàn khi schema vẫn backward-compatible. Các giới hạn chưa kiểm chứng ở trên
  vẫn phải được xử lý trước khi tuyên bố production-ready.
