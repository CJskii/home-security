#!/usr/bin/env bash
# Production image build only. No service startup, migrations or secret loading.
set -Eeuo pipefail
docker build -f web/Dockerfile --target runtime -t home-security-dashboard:coolify .
docker build -f deploy/live/Dockerfile -t home-security-gateway:coolify .
