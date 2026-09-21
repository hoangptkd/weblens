# WebLens Frontend

Frontend sản phẩm bằng React 19, TypeScript strict, React Router và Vite. Giao diện
tiếng Việt thực hiện hành trình V1/V1.5 từ đăng ký, quản lý website, chạy scan tới
xem page evidence, browser capture và clone archive. Mọi dữ liệu nghiệp vụ đến từ
Spring Boot Control Plane; không có runtime mock mode.

## Khởi chạy

```powershell
npm install
npm run dev
```

Để `VITE_API_BASE_URL` trống khi phát triển local; Vite proxy `/api` cùng origin
tới `http://localhost:8080`. Cách này tránh trộn `localhost` với `127.0.0.1`, vốn
làm refresh cookie `SameSite=Strict` không được gửi. Production nên dùng cùng site
hoặc reverse proxy; chỉ đặt URL tuyệt đối khi frontend và API thực sự cùng site.

## Kiểm tra

```powershell
npm run lint
npm test
npm run build
npm run preview
```

## Cấu trúc chính

- `src/pages/`: landing, auth và các màn hình dashboard.
- `src/components/`: shell, trạng thái giao diện và thành phần dùng chung.
- `src/domain/`: kiểu dữ liệu nghiệp vụ độc lập với UI.
- `src/api/`: HTTP adapter cho Control Plane và hợp đồng transport.
- `src/services/`: interface service độc lập với transport.
- `src/test/`: fixture chỉ dành cho kiểm thử, không được import bởi runtime.

Website và lịch sử scan dùng page-number pagination. Page evidence dùng cursor
pagination do Crawler/ClickHouse cung cấp; các thống kê trên màn hình scan ghi rõ
khi chỉ phản ánh trang dữ liệu hiện tại.

HTML được capture từ website tham chiếu chỉ nằm trong `.reference/` và không được đóng gói vào ứng dụng.
