#!/bin/bash

# Start llama-server for Reasoning Model (DeepSeek-R1)
# Port: 8080

MODEL="/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf"

echo "🧠 Starting Reasoning Model Server..."
echo "📍 Model: DeepSeek-R1-Distill-Qwen-7B"
echo "🌐 Server: http://localhost:8080"
echo ""

llama-server \
  -m "$MODEL" \
  --port 8080 \
  --ctx-size 32768 \
  --n-gpu-layers 0 \
  --threads 4 \
  --log-disable
