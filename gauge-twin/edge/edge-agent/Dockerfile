# Build from the repository root after `make proto`:
#   docker build -f edge/edge-agent/Dockerfile -t gauge-twin-edge-agent .
# Pure Go (no cgo), so the same Dockerfile builds for x86 and for Jetson (arm64).
FROM golang:1.22.12-bookworm AS build
WORKDIR /src
# Local modules (replace directives): generated protobuf and the shared decoder.
COPY gen/go gen/go
COPY edge/decode edge/decode
COPY edge/edge-agent edge/edge-agent
WORKDIR /src/edge/edge-agent
RUN CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags="-s -w" -o /edge-agent .

FROM scratch
COPY --from=build /edge-agent /edge-agent
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/edge-agent"]
