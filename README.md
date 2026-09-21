# WebLens

WebLens là nền tảng hỗ trợ kỹ sư đăng ký website, chạy lượt quét có giới hạn và xem bằng chứng kỹ thuật theo từng trang. Kiến trúc V1/V1.5 gồm frontend React/TypeScript, Java 21/Spring Boot Control Plane, Go Crawler Service dựa trên bản fork CrawlObserver, PostgreSQL tự triển khai cho workflow, ClickHouse tự triển khai cho analytics và Playwright Capture Worker cô lập.

## Status

Control Plane V1 đã có JWT access/refresh rotation, Website CRUD, Scan lifecycle,
durable command outbox và event inbox. Go Crawler Service nhận command idempotent,
duy trì frontier/lease trong PostgreSQL, crawl HTTP(S) có SSRF guard, stage kết quả
bền vững và đưa metrics/findings/links vào ClickHouse trước khi công bố progress.
Page-report query đi qua Control Plane với owner scope và ingestion watermark.
Browser capture V1.5 đã có Playwright Worker cô lập, PostgreSQL workflow,
ClickHouse analytics, MinIO artifact và snapshot viewer có owner scope. Mỗi
capture mới còn tạo best-effort một ZIP clone tĩnh một trang theo Pagesource
adapter, kèm manifest và thời hạn tải 7 ngày. Frontend chỉ dùng Control Plane API;
runtime không còn mock mode hoặc dữ liệu scan mô phỏng.

## V1 goal

V1/V1.5 tập trung vào đăng ký website, chạy bounded scan, theo dõi tiến trình, xem kết quả và bằng chứng capture. Compare/Regression thuộc V2; AI Root Cause Analysis thuộc V3. V4–V8 lần lượt mở rộng sang lịch quét và cảnh báo, xử lý phân tán, RAG, ML anomaly detection và vận hành cloud production-grade.

## Architecture direction

Kiến trúc được duyệt trong [ADR-005](docs/adr/ADR-005-tach-crawler-thanh-microservice.md) có ba deployable chính: Spring Boot Control Plane, Go Crawler Service và Playwright Capture Worker. [ADR-006](docs/adr/ADR-006-tich-hop-clickhouse-cho-analytics.md) bổ sung ClickHouse làm analytical store; PostgreSQL vẫn sở hữu workflow và S3/MinIO sở hữu artifact lớn. Control Plane giữ modular boundaries nội bộ; mỗi service có database/role riêng. Kafka, Redis, Kubernetes và service bổ sung chưa thuộc V1/V1.5.

## Repository structure

- `backend/`: Spring Boot foundation đang được chuyển thành Control Plane và migration Flyway thuộc ownership của service này
- `frontend/`: React/TypeScript product frontend dùng Control Plane API
- `crawler/`: deployable Go mang giấy phép AGPL-3.0, provenance CrawlObserver và migration thuộc Crawler
- `capture-worker/`: Playwright/TypeScript deployable, migration PostgreSQL và ClickHouse thuộc ownership của Capture Worker
- `infra/`: ba PostgreSQL workflow database, ClickHouse, MinIO và Capture Worker local bằng Compose
- `docs/`: product and engineering sources of truth
- `docs/adr/`: architecture decision records
- `tasks/`: scoped implementation specifications

Start with [PRODUCT.md](docs/PRODUCT.md), [REQUIREMENTS.md](docs/REQUIREMENTS.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), and [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Chạy production build của frontend trên máy local

Yêu cầu Node.js tương thích với Vite 8. Từ thư mục `frontend`:

```powershell
npm install
npm run build
npm run preview -- --host 127.0.0.1 --port 5173
```

Các lệnh kiểm tra: `npm run lint`, `npm test`, `npm run build`.

Frontend luôn dùng API thật cho auth, website, scan, page report và browser
capture V1.5. Sao chép `frontend/.env.example` thành
`frontend/.env.production.local` và đặt `VITE_API_BASE_URL` tới Control Plane.
Danh sách website và lịch sử scan dùng page-number pagination; page evidence dùng
cursor pagination để duyệt ổn định tập kết quả lớn.

Clone tĩnh chỉ đóng gói HTML sau render cùng CSS, JavaScript, image và font
same-origin thực sự đã capture. Đây không phải source project gốc và không khôi
phục backend/API riêng của website. ZIP chỉ được tải xuống; WebLens không preview
hoặc chạy HTML/JavaScript trong archive trên origin của ứng dụng.

## Chạy runtime production cục bộ

Yêu cầu Java 21 và Docker. Sao chép `.env.example` thành `.env`, thay JWT secret/credential, rồi chạy:

```powershell
docker compose --env-file .env -f infra/compose.yml up -d
cd backend
.\mvnw.cmd spring-boot:run
```

Không còn profile `dev` hoặc `loadtest`: `application.yml` là cấu hình runtime duy
nhất. Mặc định mỗi scan được snapshot tối đa 100.000 trang, depth 4, 24 giờ và
10.000 concurrency; Tomcat nhận trần 100.000 connection. Các giá trị đều có thể
điều chỉnh bằng biến môi trường trong `.env`. Health ở
`http://localhost:8080/actuator/health`; Swagger chỉ bật khi
`WEBLENS_OPENAPI_ENABLED=true`.

Trong terminal thứ hai, nạp các biến `CRAWLER_*`/`CLICKHOUSE_*` từ `.env`, rồi chạy:

```powershell
cd crawler
go run ./cmd/weblens-crawler
```

Crawler liveness/readiness ở `http://localhost:8081/health/live` và
`http://localhost:8081/health/ready`. `CRAWLER_MIGRATE_ON_START=true` chỉ dành
cho local/CI; production phải chạy migration bằng role DDL riêng.

Crawler mặc định cho tối đa 10.000 page fetch toàn hệ thống nhưng giữ giới hạn
hai request đồng thời trên mỗi hostname. Dispatcher không tạo 10.000 polling loop
khi hàng đợi rỗng. Scan đã tạo trước thay đổi vẫn hiển thị snapshot cấu hình cũ;
chỉ scan mới nhận mức 100.000 trang.

Capture Worker tự áp dụng migration thuộc database của nó khi khởi động. Bộ dọn
clone chạy theo `CAPTURE_RECONSTRUCTION_GC_POLL_MS`: artifact upload đã stage
nhưng không publish được sẽ được dọn sau một giờ; archive đã publish hết hạn sau
7 ngày sẽ bị xóa khỏi MinIO và chuyển lifecycle sang `EXPIRED`/`DELETED`.

Clone toàn website nhận duy nhất URL từ UI. Control Plane tự tạo website nếu cần,
tạo một scan mới và chỉ dispatch Capture Worker khi Crawler đã terminal với ít
nhất một page thành công. Baseline có thể cấu hình qua `WEBLENS_SITE_CLONE_*`:
100.000 page, 200 GiB input, 50 GiB archive, shard 256 MiB, 4 page/job, retry 3,
deadline 7 ngày và retention archive 7 ngày. `CAPTURE_SITE_CLONE_CONCURRENCY`
giới hạn Chromium page worker toàn process; không đặt bằng crawler HTTP concurrency.

Các lệnh kiểm tra Capture Worker:

```powershell
cd capture-worker
npm test
npm run typecheck
npm run build
```

Integration test PostgreSQL cần `CAPTURE_TEST_DATABASE_URL` trỏ vào một database
test; suite tự tạo và xóa schema cô lập.

## Development workflow

Create a task from `tasks/TEMPLATE.md`, review the relevant docs and ADRs, plan the change, implement it within existing boundaries, run the relevant build/tests, and review the final diff. Architectural changes require an ADR before implementation.
