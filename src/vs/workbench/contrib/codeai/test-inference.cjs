#!/usr/bin/env node

/**
 * Quick test script to verify GGUF and MLX inference is working.
 * Run this from the VS Code root directory:
 * 
 *   node src/vs/workbench/contrib/codeai/test-inference.js
 */

const { spawn } = require('child_process');
const path = require('path');

// Your configured model paths from modelsConfig.ts
const GGUF_MODEL = '/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF/DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf';
const MLX_MODEL = '/Users/mouryachiranjeevi/.lmstudio/models/lmstudio-community/Qwen2.5-Coder-14B-Instruct-MLX-4bit';

console.log('🧪 Testing CodeAI Inference Setup\n');

// Test 1: Check GGUF model file exists
console.log('1️⃣  Checking GGUF model file...');
const fs = require('fs');
if (fs.existsSync(GGUF_MODEL)) {
	const stats = fs.statSync(GGUF_MODEL);
	console.log(`   ✅ GGUF model found (${(stats.size / 1024 / 1024 / 1024).toFixed(2)} GB)`);
} else {
	console.log(`   ❌ GGUF model not found at: ${GGUF_MODEL}`);
}

// Test 2: Check MLX model directory exists
console.log('\n2️⃣  Checking MLX model directory...');
if (fs.existsSync(MLX_MODEL)) {
	console.log(`   ✅ MLX model directory found`);
} else {
	console.log(`   ❌ MLX model not found at: ${MLX_MODEL}`);
}

// Test 3: Check node-llama-cpp availability
console.log('\n3️⃣  Checking node-llama-cpp...');
try {
	require.resolve('node-llama-cpp');
	console.log('   ✅ node-llama-cpp is installed');
} catch (e) {
	console.log('   ⚠️  node-llama-cpp not installed (will use llama-cli fallback)');
	
	// Check for llama-cli
	const { execSync } = require('child_process');
	try {
		execSync('which llama-cli', { stdio: 'pipe' });
		console.log('   ✅ llama-cli found in PATH');
	} catch (e) {
		console.log('   ❌ llama-cli not found. Install with: brew install llama.cpp');
	}
}

// Test 4: Check MLX Python package
console.log('\n4️⃣  Checking mlx-lm Python package...');
const pythonTest = spawn('python3', ['-c', 'import mlx_lm; print("OK")']);
let mlxOutput = '';

pythonTest.stdout.on('data', (data) => {
	mlxOutput += data.toString();
});

pythonTest.on('close', (code) => {
	if (code === 0 && mlxOutput.includes('OK')) {
		console.log('   ✅ mlx-lm is installed');
	} else {
		console.log('   ❌ mlx-lm not installed. Install with: pip install mlx-lm');
	}
	
	// Final summary
	console.log('\n' + '='.repeat(60));
	console.log('📊 Summary:');
	console.log('='.repeat(60));
	console.log('\nTo start using CodeAI:');
	console.log('1. Build VS Code: npm run compile');
	console.log('2. Launch: ./scripts/code.sh');
	console.log('3. Open Auxiliary Bar (Cmd+Opt+B)');
	console.log('4. Look for ⚡ CodeAI (Local) in the sidebar');
	console.log('\nFor more info, see:');
	console.log('  src/vs/workbench/contrib/codeai/README.md\n');
});
