# One image definition for every server service. Build from the repository
# root after `make proto`:
#   docker build -f server/Dockerfile --build-arg SERVICE=mqtt-bridge -t gauge-twin-mqtt-bridge .
FROM golang:1.22.12-bookworm AS build
ARG SERVICE
WORKDIR /src
# Local modules (replace directives): generated protobuf and the shared decoder.
COPY gen/go gen/go
COPY edge/decode edge/decode
COPY server server
WORKDIR /src/server
RUN CGO_ENABLED=0 GOWORK=off go build -trimpath -ldflags="-s -w" -o /service ./${SERVICE}

FROM scratch
COPY --from=build /service /service
USER 65534:65534
EXPOSE 8080
ENTRYPOINT ["/service"]
