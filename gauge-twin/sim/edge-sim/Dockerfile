# Build from the repository root after `make proto`:
#   docker build -f sim/edge-sim/Dockerfile -t gauge-twin-edge-sim .
FROM golang:1.22.12-bookworm AS build
WORKDIR /src
# The generated protobuf module is a local dependency (replace directive).
COPY gen/go gen/go
COPY sim/edge-sim sim/edge-sim
WORKDIR /src/sim/edge-sim
RUN CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags="-s -w" -o /edge-sim .

FROM scratch
COPY --from=build /edge-sim /edge-sim
USER 65534:65534
EXPOSE 9100
ENTRYPOINT ["/edge-sim"]
