FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY sim_service ./sim_service
RUN pip install --no-cache-dir .
ENV SIM_WORKERS=2
EXPOSE 8081
CMD ["uvicorn", "sim_service.api:app", "--host", "0.0.0.0", "--port", "8081"]
