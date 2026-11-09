#!/bin/sh
# Starts Squirl's own Ollama server, separate from the Ollama app:
#   - models live on the pendrive (no copy on the laptop's disk)
#   - listens on 127.0.0.1:11435 only, so nothing on the network can reach it
#   - pulls the model the first time
# Ctrl+C stops it. Your regular Ollama (port 11434) is untouched.
set -e

MODELS_DIR="${SQUIRL_MODELS_DIR:-/Volumes/mushroom/models}"
HOST="${SQUIRL_LLM_HOST:-127.0.0.1:11435}"
MODEL="${LLM_MODEL:-qwen3.5:9b}"

command -v ollama >/dev/null || { echo "Ollama is not installed: https://ollama.com/download"; exit 1; }
[ -d "$(dirname "$MODELS_DIR")" ] || { echo "$(dirname "$MODELS_DIR") not found. Is the drive plugged in?"; exit 1; }
mkdir -p "$MODELS_DIR"

if curl -sf "http://$HOST/api/version" >/dev/null; then
  echo "Squirl's model server is already running on $HOST."
  exit 0
fi

# 8k context fits the category list plus a batch of transactions.
# KEEP_ALIVE=-1: once loaded, the model stays in memory (~7 GB) until this server stops. Loading it
# from a USB stick takes minutes, so unloading after idle time would make the next request wait that long.
OLLAMA_MODELS="$MODELS_DIR" OLLAMA_HOST="$HOST" OLLAMA_CONTEXT_LENGTH=8192 OLLAMA_KEEP_ALIVE=-1 ollama serve &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' INT TERM EXIT

until curl -sf "http://$HOST/api/version" >/dev/null; do sleep 0.5; done

if ! OLLAMA_HOST="$HOST" ollama show "$MODEL" >/dev/null 2>&1; then
  echo "Downloading $MODEL to $MODELS_DIR (about 6.5 GB, once)…"
  OLLAMA_HOST="$HOST" ollama pull "$MODEL"
fi

# Load it now, so the first summary or suggestion doesn't wait. An empty request just loads the model.
echo "Loading $MODEL into memory (about 3 minutes from the drive)…"
curl -sf "http://$HOST/api/generate" -d "{\"model\": \"$MODEL\", \"keep_alive\": -1}" >/dev/null \
  && echo "Ready: $MODEL on http://$HOST (models in $MODELS_DIR). Uses ~7 GB of RAM; Ctrl+C to stop and free it." \
  || echo "Couldn't load $MODEL; requests will try again."
wait $SERVER
