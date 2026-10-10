# CPU reference pipeline (ds-sim): reads RTSP, runs the ONNX models with
# onnxruntime and sends FrameResult over ZeroMQ. Build from the repository
# root after `make proto`:
#   docker build -f sim/ds-sim/Dockerfile -t gauge-twin-ds-sim .
# The discover target adds the gauge detector of discover-svc (torch on CPU,
# transformers and the OWLv2 weights, about 2 GB); the default target does not.
# The code is copied last, so that changing it does not rebuild the dependencies.
FROM python:3.11-slim-bookworm AS deps

# Keep in sync with sim/ds-sim/pyproject.toml.
RUN pip install --no-cache-dir \
      numpy==2.1.3 opencv-python-headless==4.10.0.84 onnxruntime==1.20.1 \
      pyzmq==26.2.0 protobuf==5.28.3 pytest==8.3.3
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp PYTHONPATH=/app:/app/gen
WORKDIR /app

FROM deps AS detector
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 \
 && pip install --no-cache-dir transformers==4.46.3 pillow==11.0.0 scipy==1.14.1
# The detector weights are part of the image: the service needs no internet access.
ARG DETECTOR_MODEL=google/owlv2-base-patch16-ensemble
ENV HF_HOME=/opt/hf DETECTOR_MODEL=${DETECTOR_MODEL} HF_HUB_OFFLINE=1
RUN HF_HUB_OFFLINE=0 python -c "import os; from transformers import Owlv2ForObjectDetection, Owlv2Processor; \
m = os.environ['DETECTOR_MODEL']; Owlv2Processor.from_pretrained(m); Owlv2ForObjectDetection.from_pretrained(m)"

FROM detector AS discover
COPY gen/python /app/gen
COPY sim/ds-sim/ds_sim /app/ds_sim
USER 65534:65534
ENTRYPOINT ["python", "-m", "ds_sim.discover"]

FROM deps
COPY gen/python /app/gen
COPY sim/ds-sim/ds_sim /app/ds_sim
USER 65534:65534
ENTRYPOINT ["python", "-m", "ds_sim"]
