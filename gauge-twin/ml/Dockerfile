# Training image for ml/. Separate from the tools image because of its size.
#   TORCH_VARIANT=cpu    CPU-only wheels (laptops, CI)
#   TORCH_VARIANT=cu121  CUDA 12.1 wheels (GPU server; run with --gpus all)
FROM python:3.11-slim-bookworm

ARG TORCH_VARIANT=cpu

# ffmpeg and Pillow are only needed by the tests, which render a small
# synthetic dataset with sim/gauge-renderer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      --index-url "https://download.pytorch.org/whl/${TORCH_VARIANT}" \
      torch==2.5.1 torchvision==0.20.1

# Keep in sync with ml/pyproject.toml.
RUN pip install --no-cache-dir \
      numpy==2.1.3 opencv-python-headless==4.10.0.84 pyarrow==18.0.0 pillow==11.0.0 \
      protobuf==5.28.3 onnx==1.17.0 onnxruntime==1.20.1 \
      mlflow-skinny==2.18.0 sqlalchemy==2.0.36 alembic==1.14.0 anthropic==1.11.0 \
      pytest==8.3.3

# Containers run as the host user; caches (pretrained weights) go to /cache.
RUN mkdir -p /cache && chmod 1777 /cache
ENV HOME=/tmp \
    TORCH_HOME=/cache/torch \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /work
