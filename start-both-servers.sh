#!/bin/bash

# Start both llama-server instances for CodeAI
# This script starts both reasoning and coding model servers in the background

echo "🚀 Starting CodeAI Model Servers..."
echo ""

# Start reasoning model server
echo "🧠 Starting Reasoning Model (port 8080)..."
./start-reasoning-server.sh &
REASONING_PID=$!

# Wait a moment
sleep 2

# Start coding model server
echo "💻 Starting Coding Model (port 8081)..."
./start-coding-server.sh &
CODING_PID=$!

echo ""
echo "✅ Both servers started!"
echo "   Reasoning: http://localhost:8080 (PID: $REASONING_PID)"
echo "   Coding:    http://localhost:8081 (PID: $CODING_PID)"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

# Wait for both processes
wait $REASONING_PID $CODING_PID
