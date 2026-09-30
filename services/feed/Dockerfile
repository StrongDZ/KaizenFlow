# Build từ thư mục gốc repo: docker compose build feed (context: .)
FROM python:3.12-slim
WORKDIR /app
COPY services/sim /sim
COPY services/feed /app
RUN pip install --no-cache-dir /sim .
ENV KF_API_URL=http://api:8080
EXPOSE 8090
CMD ["uvicorn", "feed_service.app:app", "--host", "0.0.0.0", "--port", "8090"]
