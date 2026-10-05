# Runbook vận hành gauge-twin

Mỗi runbook theo cùng khung: triệu chứng → kiểm tra → xử lý → xác nhận đã hết. Lệnh viết cho môi trường compose (`infra/compose/`); trên Kubernetes thay `docker logs`/`docker exec` bằng `kubectl logs`/`kubectl exec` tương ứng.

| Runbook | Khi nào dùng |
| --- | --- |
| [edge-offline.md](edge-offline.md) | Edge mất heartbeat, `edge_online` giảm, máy không có số mới |
| [kafka-lag.md](kafka-lag.md) | Alert `IngestLagHigh` / `IngestLagHighBrokerView`, dữ liệu vào DB chậm |
| [quality-drop.md](quality-drop.md) | `reading_quality` tụt, nhiều flag BLUR/GLARE/ROI_DRIFT, nhiều reading rỗng |
| [model-rollback.md](model-rollback.md) | Model mới đọc sai hoặc quality tụt sau khi rollout |
| [loadtest-emergency-stop.md](loadtest-emergency-stop.md) | Test tải trên server dùng chung làm máy quá tải |

Chung cho mọi sự cố:

- Grafana dashboard `gauge-twin`; Prometheus ở cổng 9090 trong mạng `gauge-twin`.
- Truy vấn nhanh từ bên trong mạng Docker, không cần mở cổng host:
  `docker exec gauge-twin-prometheus-1 wget -qO- --post-data 'query=<PromQL>' http://127.0.0.1:9090/api/v1/query`
- Không bao giờ xóa volume `timescaledb`, `redpanda*`, `emqx*` để "sửa nhanh": đó là dữ liệu chưa xử lý xong.
