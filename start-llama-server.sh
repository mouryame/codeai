#!/bin/bash

# Start llama-server for CodeAI
# This script starts the llama.cpp server with the configured models

REASONING_MODEL="/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf"
CODING_MODEL="/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/Qwen2.5-14B-Instruct-GGUF/Qwen2.5-14B-Instruct-Q4_K_M.gguf"

echo "🚀 Starting llama-server for CodeAI..."
echo "📍 Model: $REASONING_MODEL"
echo "🌐 Server: http://localhost:8080"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

llama-server \
  -m "$REASONING_MODEL" \
  --port 8080 \
  --ctx-size 32768 \
  --n-gpu-layers 0 \
  --threads 4 \
  --log-disable

# Note: For the coding model, you can switch the -m parameter
# or run a second server on a different port
