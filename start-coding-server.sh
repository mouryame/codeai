#!/bin/bash

# Start llama-server for Coding Model (Qwen2.5-Coder)
# Port: 8081

MODEL="/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/Qwen2.5-14B-Instruct-GGUF/Qwen2.5-14B-Instruct-Q4_K_M.gguf"

echo "💻 Starting Coding Model Server..."
echo "📍 Model: Qwen2.5-14B-Instruct"
echo "🌐 Server: http://localhost:8081"
echo ""

llama-server \
  -m "$MODEL" \
  --port 8081 \
  --ctx-size 32768 \
  --n-gpu-layers 0 \
  --threads 4 \
  --log-disable
