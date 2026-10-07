# Toolchain image for gauge-twin: Go, buf, protoc, golang-migrate, linters and
# Python 3.11. Every Makefile target runs inside this image so a new machine
# only needs Docker and make.
FROM golang:1.22.12-bookworm

ARG BUF_VERSION=1.47.2
ARG PROTOC_VERSION=28.3
ARG PROTOC_GEN_GO_VERSION=v1.35.1
ARG MIGRATE_VERSION=v4.18.1
ARG GOLANGCI_LINT_VERSION=1.61.0

# bookworm ships Python 3.11, the version required for sim/ and ml/.
# ffmpeg is only used by the simulator to encode H.264 (GPL libx264; this
# image is internal tooling and is never shipped to the edge).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv postgresql-client unzip make ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) buf_arch=x86_64;  protoc_arch=x86_64 ;; \
      arm64) buf_arch=aarch64; protoc_arch=aarch_64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/buf \
      "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-Linux-${buf_arch}"; \
    chmod +x /usr/local/bin/buf; \
    curl -fsSL -o /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-${protoc_arch}.zip"; \
    unzip -q /tmp/protoc.zip -d /usr/local 'bin/*' 'include/*'; \
    chmod -R a+rX /usr/local/bin/protoc /usr/local/include/google; \
    rm /tmp/protoc.zip; \
    curl -fsSL \
      "https://github.com/golang-migrate/migrate/releases/download/${MIGRATE_VERSION}/migrate.linux-${arch}.tar.gz" \
      | tar -xz -C /usr/local/bin migrate; \
    curl -fsSL \
      "https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI_LINT_VERSION}/golangci-lint-${GOLANGCI_LINT_VERSION}-linux-${arch}.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 \
          "golangci-lint-${GOLANGCI_LINT_VERSION}-linux-${arch}/golangci-lint"; \
    GOBIN=/usr/local/bin go install \
      "google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOC_GEN_GO_VERSION}"; \
    rm -rf /go/pkg /root/.cache

# protobuf runtime must match the protoc release above (28.x <-> 5.28.x).
# The remaining packages are the sim/ dependencies (keep in sync with
# sim/pyproject.toml); ffmpeg from apt provides the libx264 encoder.
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir \
      protobuf==5.28.3 pytest==8.3.3 ruff==0.7.1 \
      numpy==2.1.3 opencv-python-headless==4.10.0.84 pillow==11.0.0 pyarrow==18.0.0
ENV PATH=/opt/venv/bin:$PATH

# Containers run as the host user, so caches live in a world-writable
# directory that the Makefile backs with a named volume.
RUN mkdir -p /cache && chmod 1777 /cache \
 && git config --system --add safe.directory '*'
ENV HOME=/tmp \
    GOCACHE=/cache/go-build \
    GOMODCACHE=/cache/go-mod \
    GOLANGCI_LINT_CACHE=/cache/golangci-lint \
    BUF_CACHE_DIR=/cache/buf \
    RUFF_CACHE_DIR=/cache/ruff \
    GOFLAGS=-buildvcs=false \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /work
