# Build từ thư mục gốc repo: docker compose build gauge-bridge (context: .)
FROM python:3.12-slim
WORKDIR /app
COPY services/gauge-bridge /app
RUN pip install --no-cache-dir .
ENV KF_API_URL=http://api:8080 GAUGE_QUERY_URL=http://host.docker.internal:8097
CMD ["python", "-m", "gauge_bridge.bridge"]
