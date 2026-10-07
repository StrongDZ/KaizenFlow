# Dừng khẩn cấp test tải trên server dùng chung

Test tải (SPEC mục 8) chạy trên server dùng chung `ai-hub-dev` trong khung giờ đã hẹn. Mọi container của nó có tên bắt đầu bằng `gauge-twin`, không mở cổng ra host, bị giới hạn CPU/RAM và ghim lõi (hạ tầng 8–31, edge-sim 0–7). Nếu máy vẫn bị quá tải, **bất kỳ ai có quyền Docker** đều được dừng nó, không cần hỏi trước.

## Dừng

```bash
sudo /home/huyenntt/gauge-twin/loadtest/stop-full.sh
```

Script dừng các script test tải đang chạy rồi xóa mọi container thuộc các project `gauge-twin*`. Không đụng container, tiến trình hay cổng của người khác; volume dữ liệu được giữ.

Nếu không chạy được script:

```bash
sudo docker ps -aq --filter name=^gauge-twin | xargs -r sudo docker rm -f
```

Không restart Docker daemon: các container khác trên máy (ví dụ của `aihub`) không có restart policy và sẽ không tự lên lại.

## Kiểm tra máy đã nhẹ

```bash
sudo docker ps --format '{{.Names}}' | grep ^gauge-twin   # không còn dòng nào
uptime; free -g
```

## Tự dừng

Mỗi đợt chạy có giới hạn cứng `MAX_HOURS` (thời lượng dự kiến + 1 giờ). Hết giờ, `run-full.sh` tự gọi `stop-full.sh`, nên đợt chạy không lấn sang giờ làm việc.

| Đợt | Lệnh | Giới hạn |
| --- | --- | --- |
| Đêm 1 | `MAX_HOURS=8 loadtest/run-full.sh 2 3 3g 4 5a 5b 6 7` | 8 giờ |
| Đêm 2 | `MAX_HOURS=5.5 loadtest/run-full.sh 1` | 5,5 giờ |
| Đêm 3 | `MAX_HOURS=13.5 loadtest/run-full.sh 8` | 13,5 giờ |

## Sau khi dừng

Báo người chạy test (huyenntt). Tiến độ và log của đợt nằm trong `~/gauge-twin/data/loadtest/full-*/progress.txt`.
