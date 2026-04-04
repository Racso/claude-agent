#!/bin/bash
# Transcribes an audio file using OpenAI Whisper API.
# Usage: ./transcribe.sh <audio-file>
# Prints the transcribed text to stdout.
set -euo pipefail

FILE="${1:?Usage: transcribe.sh <audio-file>}"
RUN_WITH_KEY="/home/racso/.claude/plugins/cache/my-claude-marketplace/agent/1.2.0/scripts/run-with-key"

result=$("$RUN_WITH_KEY" curl -sf https://api.openai.com/v1/audio/transcriptions \
    -H "Authorization: Bearer {openai_key}" \
    -F "model=whisper-1" \
    -F "file=@$FILE")

echo "$result" | jq -r '.text'
