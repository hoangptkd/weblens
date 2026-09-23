# ADR-016 — VPS tự nhận bản phát hành qua HTTPS

Trạng thái: Accepted theo yêu cầu deploy tự động, 2026-09-24. Thay đường truyền
release bằng SSH từ GitHub Actions trong ADR-010; cách đóng gói Windows-native,
chuyển junction, health check và rollback vẫn được giữ.

## Lý do

GitHub hosted runner có IP outbound thay đổi. Có runner kết nối SSH tới VPS
thành công, có runner timeout trước khi upload. Retry trên cùng runner không thể
khắc phục đường mạng bị chặn. Đặt self-hosted Actions runner đặc quyền trên
repository công khai tạo đường chạy mã PR từ fork trên VPS.

## Quyết định

- CI chạy test và build trên GitHub hosted runner như trước, sau đó xuất bản ZIP
  Windows có commit trong tên dưới dạng GitHub Release công khai. ZIP không chứa
  credential; release chứa thông báo giấy phép Camoufox và checksum từng file.
  Browser binary và `node_modules` được kiểm tra trong CI, nhưng không tải lại ở
  mỗi release. VPS chỉ tái sử dụng chúng từ release đang chạy khi SHA-256 của
  Camoufox executable và npm lock nội bộ khớp manifest trong ZIP mới; nếu khác,
  deployment từ chối và phải cung cấp runtime tương thích bằng quy trình riêng.
- Windows Scheduled Task `WebLensDeployPoll` chạy mỗi 5 phút dưới SYSTEM. Nó chỉ
  đọc GitHub Releases của `hoangptkd/weblens` qua HTTPS, chọn tag `deploy-<SHA>`
  đã publish, kiểm tra tên/URL asset và SHA-256 do GitHub cung cấp, rồi gọi
  `deploy.ps1` hiện có. Không có SSH ingress từ GitHub runner và không lưu GitHub
  token trên VPS.
- ZIP được giải nén vào thư mục tạm trong `C:\WebLens\releases`, kiểm tra commit và
  file tối thiểu, sau đó mới chuyển thành release. Health check thất bại vẫn
  rollback. Lỗi dọn release cũ sau khi hệ thống đã khỏe chỉ là cảnh báo.
- Frontend phục vụ `/release.json` chứa commit. Job deploy trên GitHub chỉ pass
  khi URL công khai đã trả đúng commit và API trả trạng thái xác thực hợp lệ.

## Giới hạn

Deploy có độ trễ tối đa một chu kỳ poll cộng thời gian tải/giải nén và restart.
Artifact công khai cỡ lớn cần theo dõi dung lượng, băng thông và retention; có
thể chuyển sang R2 với cùng checksum contract khi lưu trữ release tăng đáng kể.
Scheduled Task là deploy helper trên VPS, không phải product deployable thứ tư.
