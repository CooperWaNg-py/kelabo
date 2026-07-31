# Usage: make rig-setup && make rig-build && make rig-up (rig-down, rig-logs)
RIG_NAME ?= kelabo-rig
RIG_IMAGE ?= kelabo/rig:dev
RIG_VOLUME ?= kelabo-rig-workspace
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)

rig-setup:
	node rig/rig-setup.mjs

rig-build:
	docker build -f rig/Dockerfile -t $(RIG_IMAGE) $(ROOT)

rig-up:
	docker volume create $(RIG_VOLUME) >/dev/null
	docker run -d --name $(RIG_NAME) \
		-v $(abspath rig/rig-profile.json):/run/rig-profile.json:ro \
		-v $(RIG_VOLUME):/workspace \
		$(RIG_IMAGE)

rig-down:
	-docker rm -f $(RIG_NAME)

rig-logs:
	docker logs -f $(RIG_NAME)

.PHONY: rig-setup rig-build rig-up rig-down rig-logs
