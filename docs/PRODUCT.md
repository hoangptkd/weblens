# Product

## Problem statement

Developers responsible for production websites often inspect performance, failures, deployments, and page changes across disconnected tools. Point-in-time scores do not explain what changed, whether it matters, or what to fix first. WebLens aims to build an evidence trail across scans and turn regressions into prioritized, understandable engineering actions.

## Target users

- Solo developers and freelancers
- Small development teams
- Developers managing multiple production websites

These are market hypotheses, not validated product-market fit. Early discovery must test their willingness to configure scans, trust the evidence, and act on recommendations.

## Value proposition

WebLens should help a developer answer: what changed, how confident are we, what evidence supports it, and what should be investigated first? AI explanations augment deterministic scan data; they do not replace it.

## Product principles

- Prefer actionable evidence and historical context over a single generic score.
- Make uncertainty, missing data, and scan limitations visible.
- Keep collection bounded, safe, reproducible, and respectful of target sites.
- Use simple deterministic analysis before advanced ML.
- Earn architectural complexity through measured needs.
- Treat security, privacy, and observability as product behavior.

## V1

V1 bao gồm authentication, đăng ký website, on-demand bounded scan, limited-page
crawling, basic page/performance metrics, progress, cancellation, deterministic
findings, scan report và scan history. Control Plane và Crawler Service là hai
deployable độc lập nhưng phải tạo thành một hành trình sản phẩm thống nhất; lỗi
mạng hoặc restart giữa hai service không được làm mất scan đã chấp nhận.
Page, finding và link analytics được lưu trong ClickHouse; durable workflow và
public lifecycle vẫn nằm trong PostgreSQL.

## V1.5

V1.5 bổ sung Capture Worker Playwright/Chromium cô lập, rendered page snapshot,
screenshot, eligible resource và network-metadata capture, S3-compatible object
storage, content hashing và snapshot inspection. Capture Worker là deployable
riêng và không chạy mã trang web trong Control Plane hoặc Crawler Service.
Network/resource analytics đã redaction được truy vấn từ ClickHouse.
Mỗi browser capture mới cũng tạo best-effort một archive clone tĩnh của đúng một
trang theo ADR-007: same-origin, có manifest, giới hạn 100 file/50 MiB input/64
MiB archive, lưu private trong object storage và chỉ cho tải xuống trong 7 ngày.

Ngày 2026-09-18, hướng sản phẩm V1.5 được mở rộng để bổ sung clone toàn website
theo ADR-007 revision 2. Từ revision 3 ngày 2026-09-20, workflow này mặc định là
**Design Clone**: WebLens giữ một trang đại diện cho mỗi chức năng, route template
và layout khác biệt thay vì sao lưu mọi URL chỉ khác nội dung hoặc locale. Người
dùng nhập URL; WebLens tự tạo scan mới, chọn representative deterministic, render
bằng Capture Worker, deduplicate asset xuyên page và tạo archive download-only
không chứa screenshot. Người dùng không phải chọn scan. Baseline workload, schema
và runtime đã được phê duyệt trong TASK-015; TASK-018 không đổi database schema.
Tuyên bố sức chứa production vẫn phải dựa trên benchmark phần cứng thực tế.

## Explicitly not V1

V1 và V1.5 không phải nền tảng SEO, security, accessibility hoặc billing đầy đủ.
Chúng không bao gồm penetration testing, scan comparison, regression detection,
AI root-cause analysis, scheduled monitoring, advanced ML training, RAG,
OpenSearch, multi-agent AI, Kubernetes, multi-cloud hoặc việc tiếp tục chia nhỏ
ngoài ba deployable đã duyệt. Crawler có thể scale nhiều instance trong boundary
của chính nó, nhưng Kafka-based distributed scheduling, multi-region execution
và service decomposition bổ sung chưa thuộc phạm vi.

## Long-term possibilities

Trình tự được duyệt là V2 comparison/regression; V3 AI root-cause analysis; V4
scheduled scans/alerts; V5 broker hoặc coordination hạ tầng lớn khi benchmark
chứng minh REST + PostgreSQL outbox/inbox không đủ; V6 RAG; V7 ML anomaly; V8
cloud operations và scaling. Mỗi phần mở rộng vẫn cần requirement và ADR tương ứng.

## V1 success criteria

- A target user can complete the register-scan-review flow without operator help. Comparison begins in V2.
- Scan status and failures are understandable and do not falsely imply completeness.
- The crawler enforces documented safety bounds.
- Browser capture keeps untrusted execution isolated and enforces resource bounds.
- Core domain behavior and critical security boundaries have automated tests.

Commercial demand, retention, acceptable scan duration, useful page limits, and trusted regression thresholds remain hypotheses to validate.
