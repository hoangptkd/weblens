# ADR-014 — Camoufox local browser engine experiment

Status: Superseded for runtime defaults and production deployment by ADR-015, 2026-09-23.

## Context

SeleniumBase/CDP vẫn nhận Turnstile `600010` trên ShineShop. WebLens cần thử
fingerprint ở browser-engine layer mà không bỏ SafeProxy, context isolation,
HTTPS validation hoặc biến một browser REST server thành deployable thứ tư.

`camofox-browser` dùng `camoufox-js` và Camoufox Firefox fork. WebLens chỉ dùng
engine tương ứng trong Capture Worker; không chép hoặc chạy server REST, SQLite,
profile persistence, telemetry, cookie import hay proxy pool của dự án đó.

## Decision

1. Thêm `CAPTURE_BROWSER_ENGINE=camoufox` cho local Linux Docker. Mặc định trong
   repository và production vẫn là `playwright`; `seleniumbase` vẫn là rollback.
2. Pin `camoufox-js` 0.11.5 và Camoufox 152.0.4-beta.28. Docker xác minh SHA-256
   của binary chính thức trước khi giải nén; amd64 và arm64 có checksum riêng.
3. Khởi chạy Camoufox trực tiếp qua Playwright API trong Capture Worker. Giữ ba
   deployable hiện tại, không có port browser mới và không có database/schema mới.
4. Chỉ truyền allowlist biến môi trường cần cho browser. Không truyền credential
   PostgreSQL, ClickHouse, S3 hoặc service token. Không persist profile/cookie.
5. Giữ SafeProxy làm browser proxy. Bật Firefox preference cho phép proxy hóa
   loopback; smoke test phải chứng minh browser không kết nối trực tiếp private
   listener. WebRTC bị chặn để không tạo đường egress ngoài proxy.
6. Loại addon UBO mặc định để capture không tự chặn tài nguyên trang. Không bật
   `disable_coop`, bỏ TLS validation, CAPTCHA solver, residential proxy hoặc ZIP
   challenge gate.
7. Camoufox hiện yêu cầu context `viewport: null`; kích thước window được ràng
   buộc khi launch. Phiên đăng nhập đo viewport thực tế để ánh xạ click đúng với
   screenshot thay vì giả định luôn là 1365x768.

## Verification and limits

Smoke thật chạy Playwright, SeleniumBase và Camoufox ở headless/headed, kiểm tra
render, screenshot, fetch, cookie sharing/isolation, Service Worker và private
egress. Lần thử Camoufox local ngày 2026-09-23 trên `https://shineshop.org/` đã
tải challenge, click một lần, nhận `/api/consent` HTTP 200 và đóng iframe mà
không thấy `600010`. Đây là một kết quả thử nghiệm, không phải cam kết vượt mọi
Cloudflare/CAPTCHA hoặc cho mọi IP.

Camoufox và `camoufox-js` dùng MPL-2.0. Trước khi phân phối image production phải
hoàn tất nghĩa vụ notice/source availability và benchmark tài nguyên. VPS
Windows-native chưa được bật engine này.

Rollback local: đặt `CAPTURE_BROWSER_ENGINE=seleniumbase` hoặc `playwright`, rồi
recreate Capture Worker. Recreate đóng mọi phiên đăng nhập tạm thời.

Sources:

- https://github.com/jo-inc/camofox-browser
- https://github.com/apify/camoufox-js
- https://github.com/daijro/camoufox
