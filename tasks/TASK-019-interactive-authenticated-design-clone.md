# TASK-019 — Authenticated Design Clone và nội dung động

Trạng thái: **HOÀN THÀNH PHẦN CODE — 2026-09-22**. Unit/build pass; integration
PostgreSQL/S3 và browser smoke local chờ Docker/Playwright Chromium runtime.

## Goal

Cho phép owner tự đăng nhập/nhập OTP trong phiên Chromium tạm thời, render root
khi crawler không có page thành công, và xử lý bounded scroll/click/hover. Theo
quyết định sản phẩm, crawler bỏ qua `robots.txt` cho mọi người dùng.

## Scope

- Phiên browser in-memory, owner-scoped, một phiên/process, timeout 10 phút.
- Screenshot polling và tập action hữu hạn qua Control Plane.
- Reuse authenticated `BrowserContext` trong site-clone renderer.
- Synthetic root idempotent bằng site-clone ID khi selection rỗng.
- Không migration, dependency, CAPTCHA/WAF/Cloudflare bypass hay lưu credential.

## Acceptance criteria

- Robots disallow không còn tạo `ROBOTS_DISALLOWED`; các guard SSRF/budget còn nguyên.
- Sai owner không xem/điều khiển được phiên; text/OTP không xuất hiện trong response/log.
- Continue giải phóng renderer; restart/timeout yêu cầu đăng nhập lại.
- Dynamic interaction bị chặn bởi page deadline và giới hạn 10/3/8.
- HTML archive không giữ form value; archive vẫn download-only.
- Go, Capture Worker, backend và frontend build/test liên quan đều pass.
