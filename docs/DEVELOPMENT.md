# Development

## Theo dõi render và tra log Design Clone

Trang chi tiết Design Clone có Render Monitor: snapshot mới mỗi 5 giây khi job
còn chạy, phần trăm ứng viên đã xử lý, phase, page đang render và danh sách có
lọc/phân trang. `SUCCEEDED` nghĩa là đã tạo bundle ứng viên, không bảo đảm page
được giữ trong ZIP cuối (còn deduplicate layout khi assembly). URL bị loại có
trạng thái `CANCELLED` kèm reason code; không tính thành lỗi render.

Chọn **Tra log và thông tin chẩn đoán** để sao chép `siteCloneRequestId`, `scanId`,
`correlationId`; nút ở từng page thêm `pageId`, `attempt` và mã lỗi. Dùng shell
trên máy đang chạy Compose, từ thư mục repository:

```powershell
docker compose -f infra/compose.yml logs --since 1h --tail 10000 capture-worker | Select-String -SimpleMatch '<siteCloneRequestId>'
```

Production dùng `-f infra/production/compose.yml` và cùng Compose project name
đã dùng khi deploy. Với Linux:

```sh
docker compose -f infra/production/compose.yml logs --since 1h --tail 10000 capture-worker | rg -F '<siteCloneRequestId>'
```

Log JSON mới có sự kiện selection/render/assembly/publish, phase, attempt,
durationMs khi hoàn tất, mã job/page/scan và correlation. `accepted=false` ở
page completed nghĩa là bundle không được nhận làm kết quả thành công.
`retryEligible=true` chỉ là còn retry budget, không bảo đảm đã retry thành công.
Lease hết hạn cho thấy worker có thể gián đoạn; không tự suy ra job thất bại.
Tăng cửa sổ `--since`/`--tail` nếu cần; log cũ đã rotate không thể khôi phục từ UI.
Không dán token, cookie, HTML hay URL chứa thông tin nhạy cảm vào báo cáo lỗi.

API mới: `GET /api/v1/site-clones/{id}/progress?after=-1&limit=50&status=ALL&q=`.
Control Plane authorize owner trước khi gọi worker. Worker dùng snapshot
REPEATABLE READ read-only, timeout query 3 giây; cursor là ordinal, không OFFSET.
Counters toàn job độc lập bộ lọc; rows có thể đổi nhóm giữa hai lần polling nên
về đầu danh sách để thấy các page vừa chuyển trạng thái. Query aggregate vẫn
đọc page rows của job (trần 100.000); cần benchmark nhiều người xem đồng thời
trước khi tuyên bố capacity production. Không có migration hoặc index mới.

Rollout: rebuild/restart Capture Worker, Control Plane và frontend để endpoint
mới có hiệu lực. Trạng thái của job cũ vẫn xem được từ rows đã lưu; log sự kiện
mới chỉ có cho công việc chạy sau cập nhật. Không restart giữa render đang chạy
nếu chưa có cửa sổ bảo trì; worker có lease/retry nhưng có thể phải render lại.

## Current implementation state

Repository có Control Plane Java 21/Spring Boot, Crawler Go, Playwright Capture
Worker và frontend React/TypeScript, ba database PostgreSQL local, ClickHouse và
MinIO. Control Plane đã dispatch scan qua
outbox/inbox bền vững; Crawler đã thực thi bounded HTTP crawl, analytical
ingestion và page-report query có owner scope. Capture Worker đã thực thi browser
capture, staging analytics và lưu artifact lớn trong MinIO.
Mỗi capture mới còn tạo best-effort một archive clone tĩnh một trang theo
ADR-007. Metadata reconstruction được publish bằng lease fencing trong PostgreSQL;
ZIP và manifest nằm trong MinIO, không nằm trong ClickHouse.

Theo ADR-005, backend hiện hữu là WebLens Control Plane. Go Crawler Service dựa
trên bản fork CrawlObserver nằm trong `crawler/`, có boundary và license AGPL
riêng. Playwright Capture Worker nằm trong `capture-worker/` và giữ database,
migration cùng runtime boundary riêng. Không chuyển source AGPL vào `backend/`.

## Chạy runtime duy nhất trên máy local

1. Copy `.env.example` to `.env` and replace all example credentials.
2. Khởi động ba PostgreSQL, ClickHouse, MinIO và Capture Worker:
   `docker compose --env-file .env -f infra/compose.yml up -d`.
3. Từ `backend/`, chạy `.\mvnw.cmd spring-boot:run` bằng Java 21, không chọn profile.
4. Từ `crawler/`, nạp các biến `CRAWLER_*` rồi chạy `go run ./cmd/weblens-crawler`.
5. Đặt `VITE_API_BASE_URL` của frontend tới Control Plane, chạy `npm ci`,
   `npm run build`, rồi phục vụ artifact bằng
   `npm run preview -- --host 127.0.0.1 --port 5173`.

Frontend chỉ có production API adapter tại `VITE_API_BASE_URL`; không có mock mode
hoặc environment switch. Website và scan history dùng page-number pagination.
Page evidence dùng cursor pagination để tránh chi phí offset trên tập kết quả lớn.

Backend không còn profile `dev` hoặc `loadtest`. `application.yml` là cấu hình
runtime duy nhất và dùng mức 100.000 trang/scan, depth 4, 24 giờ, 10.000 scan
concurrency cùng trần Tomcat 100.000 connection. Database password, JWT secret và
service token không có default nên startup sẽ fail-fast nếu thiếu. Khi chạy local,
`.env` có thể đặt `WEBLENS_OPENAPI_ENABLED=true` và `WEBLENS_COOKIE_SECURE=false`;
deployment có TLS phải giữ cookie secure.

`CAPTURE_RECONSTRUCTION_GC_POLL_MS` điều khiển chu kỳ tìm artifact clone cần dọn,
mặc định 30 giây. Metadata `STAGED` chỉ được chuyển `PUBLISHED` khi capture lease
generation còn hợp lệ. `STAGED` mồ côi có grace period một giờ; archive publish
giữ 7 ngày rồi được xóa khỏi MinIO. Không giảm chu kỳ GC quá thấp nếu chưa đo tải
PostgreSQL và object storage.

Site clone dùng cùng chu kỳ GC cho archive shard hết hạn và page bundle tạm sau
khi job terminal. Budget nằm trong các biến `WEBLENS_SITE_CLONE_*`; concurrency
Chromium toàn Capture Worker nằm ở `CAPTURE_SITE_CLONE_CONCURRENCY`. Mức mặc định
là baseline an toàn về cấu trúc, không phải kết quả benchmark capacity.

## Verification commands

- Backend: `.\mvnw.cmd verify` using Java 21. Docker must be running for PostgreSQL Testcontainers integration tests.
- Crawler unit/static: `go test ./...` và `go vet ./...` bằng phiên bản Go trong
  `crawler/go.mod`.
- Crawler PostgreSQL integration: cấp một database thử nghiệm rỗng qua
  `WEBLENS_TEST_POSTGRES_URL`, sau đó chạy `go test ./internal/postgres -run
  TestStoreWorkflowIntegration -v`. Test tự tạo và xóa schema cô lập; không dùng
  database production.
- Crawler ClickHouse integration: cấp instance thử nghiệm riêng qua
  `WEBLENS_TEST_CLICKHOUSE_ADDR`, `WEBLENS_TEST_CLICKHOUSE_USERNAME` và
  `WEBLENS_TEST_CLICKHOUSE_PASSWORD`, rồi chạy `go test ./internal/analytics -run
  TestClickHouseBatchIntegration -v`. CI đã cấu hình PostgreSQL 17.6 và ClickHouse
  26.3 cho hai integration suite này.
- Frontend: `npm run lint`, `npm test`, and `npm run build`.
- Capture Worker unit/build: trong `capture-worker/`, chạy `npm test`,
  `npm run typecheck` và `npm run build`.
- Capture Worker PostgreSQL integration: cấp database thử nghiệm qua
  `CAPTURE_TEST_DATABASE_URL`, rồi chạy `npm run test:integration`. Test tạo/xóa
  schema cô lập và xác minh duplicate command, fencing, `STAGED → PUBLISHED`,
  owner scope và retention GC.
- Health: `GET http://localhost:8080/actuator/health`.
- OpenAPI khi `WEBLENS_OPENAPI_ENABLED=true`: `GET http://localhost:8080/v3/api-docs`.

## Task workflow

1. Copy `tasks/TEMPLATE.md` to a clearly named task file and fill it with observable scope.
2. Read the sources of truth and applicable ADRs/agent instructions.
3. Inspect affected modules and write an implementation plan including failure, security, and consistency cases.
4. Implement the smallest complete change. Explain new dependencies in the task or ADR.
5. Run formatting, build, relevant tests, and migration/integration checks.
6. Review the diff for unrelated changes, secrets, generated output, and documentation drift.
7. Report results and the concepts the developer should understand before acceptance.

## Configuration and secrets

Copy `.env.example` to `.env` for local-only values when Compose exists. Never commit `.env`. Production configuration will be injected through the hosting platform and a secret manager. Tests should use isolated generated credentials and containers.

## Architecture changes

Update documentation with the code. Any material boundary, datastore, messaging, deployment, or trust-model change needs an ADR before implementation. Supersede old ADRs; do not rewrite their history.

Kiến trúc hiện hành nằm trong ADR-005 và ClickHouse đã được phê duyệt trong
ADR-006. Service mới, Kafka, Redis, Kubernetes hoặc thay đổi ownership tiếp theo
phải có ADR mới. Mỗi service sở hữu migration và database role riêng; không dùng
direct table access làm integration.

## Giới hạn đã biết của clone tĩnh

- Clone hiện chỉ gồm một trang và resource same-origin đã quan sát được trong cùng
  Playwright session; không khôi phục source React/Next.js hoặc backend.
- Query được redaction khỏi URL/path/manifest, nhưng website có thể tự nhúng một
  chuỗi giống secret trong nội dung HTML/JavaScript. Không tuyên bố archive đã
  quét sạch mọi secret nằm trong source body do website cung cấp.
- Download archive hiện bị chặn ở 64 MiB và được kiểm tra SHA-256 tại Capture
  Worker lẫn Control Plane. Control Plane đang buffer archive có giới hạn trong
  RAM; phải benchmark 100/1.000 download đồng thời trước production để quyết định
  chuyển sang temp-file streaming hoặc presigned URL có authorization tương đương.
- Crash đúng trong cửa sổ sau khi object upload nhưng trước khi metadata `STAGED`
  commit có thể để lại object không có row đối chiếu. Runtime xóa best-effort khi
  stage lỗi; inventory sweep theo prefix cần bổ sung nếu production yêu cầu
  zero-orphan tuyệt đối.
