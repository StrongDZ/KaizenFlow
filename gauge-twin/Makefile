# gauge-twin monorepo. Every target runs its tools inside the tools image, so
# the host only needs Docker and make. Set GAUGE_TOOLS=local to run the tools
# from PATH instead (used by CI, which already runs inside the tools image).
SHELL := /bin/bash
.DEFAULT_GOAL := help

PROJECT     := gauge-twin
# Tagged with a checksum of its Dockerfile, so it is only rebuilt when the
# toolchain changes (a rebuild needs the network, the other targets do not).
TOOLS_IMAGE ?= $(PROJECT)-tools:$(shell cksum tools/Dockerfile | cut -d ' ' -f 1)
COMPOSE     := docker compose -f infra/compose/dev.yml
PROFILES    := --profile dev --profile cluster

GO_MODULES  := gen/go server edge/decode edge/edge-agent sim/edge-sim
PY_PROJECTS := sim ml

EDGE_SIM_HTTP_PORT ?= 9100
CONFIG_API_PORT ?= 8090
EDGE_MACHINES ?= SIM/L01/machine_001

# Git ref that `make breaking` compares the schemas against.
BREAKING_AGAINST ?= main

# Credentials of the local stack are never in the repository: gen-env.sh
# writes the missing ones, random, into infra/compose/.env (git-ignored),
# which docker compose and this Makefile both read.
ifeq ($(shell infra/compose/gen-env.sh >/dev/null 2>&1; echo $$?),0)
include infra/compose/.env
endif
POSTGRES_USER ?= gauge
POSTGRES_DB   ?= gauge
DB_AUTH       := $(POSTGRES_USER):$(POSTGRES_PASSWORD)

ifeq ($(GAUGE_TOOLS),local)
RUN       :=
RUN_NET   :=
TOOLS_DEP :=
DATABASE_URL ?= postgres://$(DB_AUTH)@localhost:5432/$(POSTGRES_DB)?sslmode=disable
else
DOCKER_RUN := docker run --rm --user $(shell id -u):$(shell id -g) \
	-v "$(CURDIR)":/work -w /work -v $(PROJECT)-tools-cache:/cache
RUN       := $(DOCKER_RUN) $(TOOLS_IMAGE)
RUN_NET   := $(DOCKER_RUN) --network $(PROJECT) $(TOOLS_IMAGE)
TOOLS_DEP := tools-image
DATABASE_URL ?= postgres://$(DB_AUTH)@timescaledb:5432/$(POSTGRES_DB)?sslmode=disable
endif

.PHONY: help tools-image up up-cluster down proto migrate migrate-down \
	test test-go test-py test-sql lint breaking render \
	test-integration edge-sim-image edge-sim sim-up sim-down sim-check server-up server-down seed-configs seqcheck \
	test-zmq-interop test-ds-sim ds-sim-image edge-up edge-down telemetry-tail ml-image test-ml dataset train-digit train-dial eval-digit eval-dial eval-public time-displays export-digit export-dial

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

tools-image: ## Build the tools image if tools/Dockerfile changed (Go, buf, protoc, migrate, Python 3.11, ffmpeg)
	@docker image inspect $(TOOLS_IMAGE) >/dev/null 2>&1 || docker build -t $(TOOLS_IMAGE) tools

up: ## Start the dev profile (1 EMQX, 1 Redpanda) and create the Kafka topics
	$(COMPOSE) --profile dev up -d --wait
	KAFKA_RF=1 $(COMPOSE) run --rm kafka-init

up-cluster: ## Start the cluster profile (3 EMQX, 3 Redpanda) and create the Kafka topics
	$(COMPOSE) --profile cluster up -d --wait
	KAFKA_RF=3 $(COMPOSE) run --rm kafka-init

down: ## Stop everything; data volumes are kept (DOWN_FLAGS=-v removes them)
	$(COMPOSE) $(PROFILES) --profile init down --remove-orphans $(DOWN_FLAGS)

proto: $(TOOLS_DEP) ## Lint the protos and generate Go, Python and C++ code into gen/
	$(RUN) bash -c 'set -euo pipefail; cd schemas; \
		buf lint; \
		rm -rf ../gen/go/denso ../gen/python ../gen/cpp; \
		buf generate; \
		buf generate --template buf.gen.cpp.yaml --path proto/denso/gauge/v1/frame_result.proto'

migrate: $(TOOLS_DEP) ## Apply all SQL migrations to TimescaleDB
	$(RUN_NET) migrate -path schemas/sql -database "$(DATABASE_URL)" up

migrate-down: $(TOOLS_DEP) ## Roll back the last SQL migration
	$(RUN_NET) migrate -path schemas/sql -database "$(DATABASE_URL)" down 1

test: test-go test-py test-sql ## Run all tests

test-go: proto ## Go unit tests of every module in go.work
	$(RUN) bash -c 'set -euo pipefail; for m in $(GO_MODULES); do \
		if [ -n "$$(find $$m -name "*.go" -print -quit)" ]; then (cd $$m && go test ./...); fi; \
	done'

test-py: proto ## Python unit tests
	$(RUN) bash -c 'set -euo pipefail; for p in $(PY_PROJECTS); do (cd $$p && pytest -q); done'

ifeq ($(GAUGE_TOOLS),local)
test-sql: ## Migration test against DATABASE_URL (must be an empty database)
	DATABASE_URL="$(DATABASE_URL)" schemas/test/migrate_test.sh
else
test-sql: $(TOOLS_DEP) ## Migration test against a throwaway TimescaleDB container
	schemas/test/run_in_docker.sh $(TOOLS_IMAGE)
endif

lint: $(TOOLS_DEP) ## Lint protos, Go, Python and the compose file
	$(RUN) bash -c 'set -euo pipefail; \
		(cd schemas && buf lint && buf format --diff --exit-code); \
		for m in $(GO_MODULES); do \
			if [ -n "$$(find $$m -name "*.go" -print -quit)" ]; then (cd $$m && golangci-lint run ./...); fi; \
		done; \
		ruff check $(PY_PROJECTS); \
		ruff format --check $(PY_PROJECTS)'
ifneq ($(GAUGE_TOOLS),local)
	$(COMPOSE) $(PROFILES) --profile init config --quiet
endif

breaking: $(TOOLS_DEP) ## Check the protos for breaking changes against BREAKING_AGAINST
	$(RUN) buf breaking schemas --against '.git#ref=$(BREAKING_AGAINST),subdir=schemas'

# Example: make render ARGS="--stations 20 --minutes 30 --fps 10 --seed 42 --out data/sim/"
render: proto ## Render synthetic station videos with ground truth (pass options in ARGS)
	$(RUN) bash -c 'PYTHONPATH=gen/python:sim/gauge-renderer python -m gauge_renderer.cli $(ARGS)'

test-integration: proto ## Integration tests against the running stack (needs `make up && make migrate`)
	$(RUN_NET) bash -c 'cd sim/edge-sim && EDGE_SIM_TEST_BROKER=emqx:1883 \
		go test -tags integration -count=1 -run Integration -v ./...'
	$(RUN_NET) bash -c 'cd server && BRIDGE_TEST_MQTT=emqx:1883 BRIDGE_TEST_KAFKA=redpanda:9092 \
		CONFIG_API_TEST_MQTT=emqx:1883 CONFIG_API_TEST_DATABASE_URL="$(DATABASE_URL)" \
		INGEST_TEST_DATABASE_URL="$(DATABASE_URL)" INGEST_TEST_REDIS=redis:6379 \
		STATE_TEST_DATABASE_URL="$(DATABASE_URL)" STATE_TEST_REDIS=redis:6379 \
		QUERY_API_TEST_DATABASE_URL="$(DATABASE_URL)" \
		go test -tags integration -count=1 -run Integration -v ./...'

EDGE_SIM_IMAGE ?= $(PROJECT)-edge-sim:local

edge-sim-image: proto ## Build the edge-sim image
	docker build -f sim/edge-sim/Dockerfile -t $(EDGE_SIM_IMAGE) .

# Example: make edge-sim ARGS="--machines 1000 --window 1 --duration 10m"
# The sequence log is written to data/edge-sim/seq.jsonl; metrics on :9100.
edge-sim: edge-sim-image ## Run edge-sim against the stack started by `make up` (options in ARGS)
	mkdir -p data/edge-sim
	docker run --rm --name $(PROJECT)-edge-sim --network $(PROJECT) --user $(shell id -u):$(shell id -g) \
		-v "$(CURDIR)/data/edge-sim":/out -p $(EDGE_SIM_HTTP_PORT):9100 \
		$(EDGE_SIM_IMAGE) --broker emqx:1883 --seq-log /out/seq.jsonl $(ARGS)

SIM_COMPOSE := docker compose -f infra/compose/sim.yml

sim-up: ## Loop the videos in data/sim/ as RTSP streams rtsp://mediamtx:8554/<machine_id>
	$(SIM_COMPOSE) up -d --wait

sim-down: ## Stop the RTSP publisher
	$(SIM_COMPOSE) down

# Example: make sim-check MACHINE=machine_001 READ_SECONDS=30 LENGTH=12
sim-check: ## Read a stream past its loop point and check the timestamps
	$(SIM_COMPOSE) exec -T rtsp-publisher /bin/sh /scripts/check-rtsp.sh $(MACHINE) $(READ_SECONDS) $(LENGTH)

SERVER_COMPOSE := docker compose -f infra/compose/server.yml

server-up: proto ## Build and start the server services (needs `make up`)
	$(SERVER_COMPOSE) up -d --build

server-down: ## Stop the server services
	$(SERVER_COMPOSE) down

# Registers the configs of the machines edge-sim simulates, so ingest validates
# their telemetry: make seed-configs MACHINES=200
MACHINES ?= 200
FULL ?= 0
seed-configs: edge-sim-image ## Write and register station configs for MACHINES simulated machines
	mkdir -p data/edge-sim/configs
	docker run --rm --user $(shell id -u):$(shell id -g) -v "$(CURDIR)/data/edge-sim":/out \
		$(EDGE_SIM_IMAGE) --machines $(MACHINES) --emit-configs /out/configs
	loadtest/seed-configs.sh data/edge-sim/configs http://localhost:$(CONFIG_API_PORT)

seqcheck: $(TOOLS_DEP) ## Compare data/edge-sim/seq.jsonl with the database
	$(RUN_NET) bash -c 'DATABASE_URL="$(DATABASE_URL)" loadtest/seqcheck.sh data/edge-sim/seq.jsonl'
# ---------------------------------------------------------------- ml/ ----
# TORCH_VARIANT=cpu|cu121 selects the PyTorch wheels; on a GPU server use
#   make train-dial TORCH_VARIANT=cu121 DEVICE=cuda ML_DOCKER_FLAGS="--gpus all"
TORCH_VARIANT   ?= cpu
DEVICE          ?= cpu
ML_DOCKER_FLAGS ?=
ML_IMAGE        ?= $(PROJECT)-ml:$(TORCH_VARIANT)-$(shell cksum ml/Dockerfile | cut -d ' ' -f 1)
SIM_DATA        ?= data/sim-ml
ML_DATA         ?= data/ml
ML_RUNS         ?= data/ml-runs
ML_RUN := docker run --rm --user $(shell id -u):$(shell id -g) --shm-size 1g $(ML_DOCKER_FLAGS) \
	-v "$(CURDIR)":/work -w /work -v $(PROJECT)-ml-cache:/cache -e PYTHONPATH=/work/ml $(ML_IMAGE)
# Same, with the API keys of the labelling run passed through from the host environment.
ML_RUN_KEYS := $(subst $(ML_IMAGE),-e ANTHROPIC_API_KEY -e GEMINI_API_KEY $(ML_IMAGE),$(ML_RUN))

ml-image: ## Build the training image if ml/Dockerfile changed (TORCH_VARIANT=cpu|cu121)
	@docker image inspect $(ML_IMAGE) >/dev/null 2>&1 || \
		docker build --build-arg TORCH_VARIANT=$(TORCH_VARIANT) -t $(ML_IMAGE) ml

test-ml: ml-image proto ## Tests of ml/ (render a tiny dataset, train a few epochs, export)
	$(ML_RUN) bash -c 'cd ml && pytest -q'

dataset: ml-image ## Build the training datasets from the stations rendered in SIM_DATA
	$(ML_RUN) python -m gauge_ml.dataset.builder --sim $(SIM_DATA) --out $(ML_DATA) $(ARGS)

train-digit: ml-image ## Train the digit classifier (DEVICE=cpu|cuda, extra options in ARGS)
	$(ML_RUN) python -m gauge_ml.train_digit --data $(ML_DATA) --out $(ML_RUNS)/digit --device $(DEVICE) $(ARGS)

train-dial: ml-image ## Train the dial keypoint model (DEVICE=cpu|cuda, extra options in ARGS)
	$(ML_RUN) python -m gauge_ml.train_dial --data $(ML_DATA) --out $(ML_RUNS)/dial --device $(DEVICE) $(ARGS)

eval-digit: ml-image ## Evaluate the digit classifier on the test split
	$(ML_RUN) python -m gauge_ml.eval_digit --data $(ML_DATA) --weights $(ML_RUNS)/digit/best.pt \
		--device $(DEVICE) --out $(ML_RUNS)/digit/test-metrics.json $(ARGS)

eval-dial: ml-image ## Evaluate the dial model on the test split
	$(ML_RUN) python -m gauge_ml.eval_dial --data $(ML_DATA) --weights $(ML_RUNS)/dial/best.pt \
		--device $(DEVICE) --out $(ML_RUNS)/dial/test-metrics.json $(ARGS)

PUBLIC_DATA ?= data/public
ONNX_DIR    ?= $(ML_RUNS)/onnx
eval-public: ml-image ## Evaluate the ONNX models on real public datasets in PUBLIC_DATA (see README, section Model)
	$(ML_RUN) python -m gauge_ml.eval_public --public $(PUBLIC_DATA) --models $(ONNX_DIR) \
		--out $(ML_RUNS)/public/$(subst /,-,$(patsubst $(ML_RUNS)/%,%,$(ONNX_DIR))).json $(ARGS)

TIME_DISPLAYS ?= $(PUBLIC_DATA)/time-displays
time-displays: ml-image ## Collect openly licensed time-display photos and label them with Claude + Gemini (needs ANTHROPIC_API_KEY, GEMINI_API_KEY; ARGS for autolabel, e.g. --limit 30 --audit 50)
	$(ML_RUN) python -m gauge_ml.timedisp.collect --root $(TIME_DISPLAYS)
	$(ML_RUN_KEYS) python -m gauge_ml.timedisp.autolabel --root $(TIME_DISPLAYS) $(ARGS)

export-digit: ml-image ## Export the digit classifier to ONNX and register it in MLflow
	$(ML_RUN) python -m gauge_ml.export --model digit --weights $(ML_RUNS)/digit/best.pt --out $(ML_RUNS)/onnx $(ARGS)

export-dial: ml-image ## Export the dial model to ONNX and register it in MLflow
	$(ML_RUN) python -m gauge_ml.export --model dial --weights $(ML_RUNS)/dial/best.pt --out $(ML_RUNS)/onnx $(ARGS)

# ------------------------------------------------------------- edge/ ----
DS_SIM_IMAGE ?= $(PROJECT)-ds-sim:local

ds-sim-image: proto ## Build the CPU reference pipeline image
	docker build -q -f sim/ds-sim/Dockerfile -t $(DS_SIM_IMAGE) .

test-ds-sim: ds-sim-image ## Unit tests of ds-sim
	docker run --rm --user $(shell id -u):$(shell id -g) -v "$(CURDIR)":/work -w /work/sim/ds-sim \
		-e PYTHONPATH=/work/sim/ds-sim:/work/gen/python --entrypoint python $(DS_SIM_IMAGE) -m pytest -q

# The pure-Go ZeroMQ library of edge-agent against libzmq (pyzmq): PUSH/PULL
# for frames and REQ/REP for commands, over ipc on a shared volume.
test-zmq-interop: ds-sim-image $(TOOLS_DEP) ## Check go-zeromq/zmq4 talks to libzmq
	docker volume create $(PROJECT)-zmq-test >/dev/null
	docker run --rm --user 0 --entrypoint chmod -v $(PROJECT)-zmq-test:/tmp/zmq $(DS_SIM_IMAGE) 1777 /tmp/zmq
	-docker rm -f $(PROJECT)-zmq-peer >/dev/null 2>&1
	docker run -d --rm --name $(PROJECT)-zmq-peer --user $(shell id -u):$(shell id -g) \
		-v $(PROJECT)-zmq-test:/tmp/zmq -v "$(CURDIR)/sim/ds-sim":/src:ro -e PYTHONPATH=/src:/app/gen \
		--entrypoint python $(DS_SIM_IMAGE) /src/tests/zmq_peer.py ipc:///tmp/zmq/frames ipc:///tmp/zmq/control 120
	$(DOCKER_RUN) -v $(PROJECT)-zmq-test:/tmp/zmq \
		-e ZMQ_FRAMES_ENDPOINT=ipc:///tmp/zmq/frames -e ZMQ_CONTROL_ENDPOINT=ipc:///tmp/zmq/control \
		$(TOOLS_IMAGE) bash -c 'cd edge/edge-agent && go test -tags interop -count=1 -v ./internal/zmqio/'; \
		status=$$?; docker rm -f $(PROJECT)-zmq-peer >/dev/null 2>&1; exit $$status

EDGE_COMPOSE := docker compose -f infra/compose/edge.yml

# Example (8 cameras on one edge):
#   make edge-up EDGE_MACHINES="SIM/L01/machine_001,SIM/L01/machine_002,..."
edge-up: proto ## Start ds-sim + edge-agent (needs `make up`, `make sim-up` and exported models)
	EDGE_MACHINES="$(EDGE_MACHINES)" $(EDGE_COMPOSE) up -d --build

edge-down: ## Stop the simulated edge (DOWN_FLAGS=-v also removes its buffer and configs)
	$(EDGE_COMPOSE) down $(DOWN_FLAGS)

# Example: make telemetry-tail ARGS="--seconds 30"
telemetry-tail: $(TOOLS_DEP) ## Print telemetry and status messages as JSON lines
	@$(RUN_NET) bash -c 'cd edge/edge-agent && go run ./cmd/telemetry-tail --broker emqx:1883 $(ARGS)'

# Load tests (SPEC section 8). Short by default; FULL=1 runs the spec size.
# Reports are written to loadtest/reports/.
loadtest-%: edge-sim-image $(TOOLS_DEP) ## Run load-test scenario N (1..8), e.g. make loadtest-7 FULL=1
	FULL=$(FULL) TOOLS_IMAGE=$(TOOLS_IMAGE) loadtest/scenario-$*.sh
