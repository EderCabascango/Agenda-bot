/**
 * Cross-platform test runner for App-Agenda.
 * Automatically resolves virtualenv binaries on Windows, Linux, and macOS.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function findExecutable(relWin, relUnix, fallback) {
  const winPath = path.join(ROOT_DIR, relWin);
  const unixPath = path.join(ROOT_DIR, relUnix);

  if (IS_WIN && fs.existsSync(winPath)) return winPath;
  if (!IS_WIN && fs.existsSync(unixPath)) return unixPath;
  return fallback;
}

const PYTHON = findExecutable('backend/.venv/Scripts/python.exe', 'backend/.venv/bin/python', IS_WIN ? 'python' : 'python3');
const PYTEST = findExecutable('backend/.venv/Scripts/pytest.exe', 'backend/.venv/bin/pytest', 'pytest');

console.log('============================================================');
console.log('EJECUTANDO SUITE COMPLETA DE PRUEBAS (Cross-Platform)');
console.log(`Plataforma: ${process.platform} | Python: ${PYTHON}`);
console.log('============================================================\n');

const steps = [
  {
    name: '1. Tests Unitarios Frontend (SyncCore)',
    cmd: process.execPath,
    args: ['--test', path.join(ROOT_DIR, 'web/test_sync_core.js')]
  },
  {
    name: '2. Tests Unitarios e Integración Backend (Pytest)',
    cmd: PYTEST,
    args: [path.join(ROOT_DIR, 'backend')]
  },
  {
    name: '3. Tests de Integración Cliente-Servidor (Sync)',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_integration.py')]
  },
  {
    name: '4. Tests E2E Playwright Multi-Contexto',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_e2e_playwright.py')]
  }
];

for (const step of steps) {
  console.log(`\n>>> Ejecutando: ${step.name}...`);
  const result = spawnSync(step.cmd, step.args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env }
  });

  if (result.status !== 0) {
    console.error(`\n❌ Error en: ${step.name} (código de salida: ${result.status})`);
    process.exit(result.status || 1);
  }
}

console.log('\n============================================================');
console.log('✓ TODAS LAS SUITES DE PRUEBAS PASARON EXITOSAMENTE (100% OK)');
console.log('============================================================\n');
