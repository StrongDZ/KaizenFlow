#!/usr/bin/env bash
# Scenario 5a: broker node failure without resend requests (see scenario-5.sh).
MODE=a exec "$(dirname "$0")/scenario-5.sh"
