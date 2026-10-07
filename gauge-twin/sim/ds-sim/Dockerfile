# CPU reference pipeline (ds-sim): reads RTSP, runs the ONNX models with
# onnxruntime and sends FrameResult over ZeroMQ. Build from the repository
# root after `make proto`:
#   docker build -f sim/ds-sim/Dockerfile -t gauge-twin-ds-sim .
FROM python:3.11-slim-bookworm

# Keep in sync with sim/ds-sim/pyproject.toml.
RUN pip install --no-cache-dir \
      numpy==2.1.3 opencv-python-headless==4.10.0.84 onnxruntime==1.20.1 \
      pyzmq==26.2.0 protobuf==5.28.3 pytest==8.3.3

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp
WORKDIR /app
COPY gen/python /app/gen
COPY sim/ds-sim/ds_sim /app/ds_sim
ENV PYTHONPATH=/app:/app/gen
USER 65534:65534
ENTRYPOINT ["python", "-m", "ds_sim"]
