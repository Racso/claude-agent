#!/bin/bash
# Converts text to speech using OpenAI TTS API.
# Usage: ./speak.sh <text> <output-file>
# Writes OGG Opus audio to output-file.
set -euo pipefail

TEXT="${1:?Usage: speak.sh <text> <output-file>}"
OUTPUT="${2:?Usage: speak.sh <text> <output-file>}"
RUN_WITH_KEY="/home/racso/.claude/plugins/cache/my-claude-marketplace/agent/1.2.0/scripts/run-with-key"

BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

python3 -c "
import json, sys
print(json.dumps({
    'model': 'tts-1',
    'input': sys.argv[1],
    'voice': 'alloy',
    'response_format': 'opus',
}))
" "$TEXT" > "$BODY_FILE"

"$RUN_WITH_KEY" curl -sf https://api.openai.com/v1/audio/speech \
    -H "Authorization: Bearer {openai_key}" \
    -H "Content-Type: application/json" \
    -d "@$BODY_FILE" \
    -o "$OUTPUT"
