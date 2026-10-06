# Edge offline

## Triệu chứng

- `edge_online` giảm; trong `edge_node`, `status = 'offline'` hoặc `last_seen` cũ hơn 120 s.
- Máy của edge đó không có reading mới trên dashboard.
- Edge đang mất mạng thì **không mất dữ liệu**: edge-agent ghi mọi bản tin vào SQLite (giới hạn 500 MB, giữ 24 giờ sau PUBACK) và xả lại khi kết nối lại.

## Kiểm tra

1. Edge nào, từ lúc nào:
   ```sql
   SELECT edge_id, machine_ids, status, last_seen, updated_at, sw_version
   FROM edge_node WHERE status <> 'online' OR last_seen < now() - interval '2 minutes'
   ORDER BY updated_at;
   ```
   `updated_at` của dòng offline là lúc server nhận last will, tức lúc edge mất kết nối.
2. Nhiều edge cùng lúc → nghi phía server/mạng xưởng, không phải từng edge:
   - EMQX: `docker exec gauge-twin-emqx-1 emqx ctl cluster status` (profile cluster: `emqx1-1`).
   - mqtt-bridge có subscribe không: `sum(bridge_mqtt_connected)` phải bằng số replica.
3. Một edge: trên thiết bị edge
   - `docker ps` (edge-agent, ds-pipeline/ds-sim có đang chạy, `RestartCount`).
   - `curl -s localhost:8081/metrics | grep -E 'edge_agent_mqtt_connected|edge_buffer_messages|edge_agent_reconnects_total'`.
   - `docker logs --since 30m <edge-agent>`: lỗi kết nối broker, DNS, TLS.
   - Nguồn điện, cáp mạng, switch của line.
4. Buffer còn bao nhiêu: `edge_buffer_bytes{edge_id="..."}` (state ghi từ heartbeat cuối). Gần 500 MB nghĩa là sắp bắt đầu xóa bản tin cũ nhất.

## Xử lý

- Mạng xưởng/broker: sửa mạng hoặc khởi động lại node EMQX hỏng (`docker restart gauge-twin-emqx2-1`); edge tự kết nối lại với backoff tối đa 60 s, không cần đụng vào edge.
- edge-agent treo: `docker restart <edge-agent>`. Buffer SQLite nằm trên volume nên không mất.
- Pipeline (ds-pipeline) chết: watchdog của edge-agent tự gửi RESTART; nếu lặp lại liên tục xem `edge_agent_pipeline_commands_total` và log pipeline (thường do RTSP camera hoặc GPU).
- Edge mất mạng dự kiến > 20 giờ: báo trước, vì sau 24 giờ hoặc 500 MB bản tin cũ nhất bị xóa và tính là mất.

## Xác nhận đã hết

- `edge_node.status = 'online'`, `last_seen` mới.
- `edge_buffer_messages` của edge về 0 (xả với tối đa 50 msg/s; 1 giờ offline của 8 máy ≈ 10 phút xả).
- `increase(edge_seq_gap_total{edge_id="..."}[1h]) == 0`. Nếu > 0: state đã tự gửi `cmd/resend`; chỉ những khoảng edge trả lời "không còn" mới là mất thật, xem log state `telemetry lost: the edge no longer holds it`.
