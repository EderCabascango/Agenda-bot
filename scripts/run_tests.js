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
    name: '1.a Tests Unitarios Frontend (SyncCore)',
    cmd: process.execPath,
    args: ['--test', path.join(ROOT_DIR, 'web/test_sync_core.js')]
  },
  {
    name: '1.b Tests Unitarios Frontend (FocusCore)',
    cmd: process.execPath,
    args: ['--test', path.join(ROOT_DIR, 'web/test_focus_core.js')]
  },
  {
    name: '1.c Tests Unitarios Frontend (TimerCore)',
    cmd: process.execPath,
    args: ['--test', path.join(ROOT_DIR, 'web/test_timer_core.js')]
  },
  {
    name: '1.d Tests Unitarios Frontend (StatsCore)',
    cmd: process.execPath,
    args: ['--test', path.join(ROOT_DIR, 'web/test_stats_core.js')]
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
  },
  {
    name: '5.a E2E Meta Semanal por Materia (Semana Actual vs Histórico)',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point1_meta_semanal.py')]
  },
  {
    name: '5.b E2E Sesiones Huérfanas Sin Materia',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point2_sin_materia.py')]
  },
  {
    name: '5.c E2E Fase E: Ratings, XSS, Notes, Export & Immutable Activity',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point2_fase_e_flow.py')]
  },
  {
    name: '5.d E2E Estadísticas: Barras 7d/30d y Heatmap Accesible 15->14',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point3_stats.py')]
  },
  {
    name: '5.e E2E Campo Configurable allow_focus',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point4_allow_focus.py')]
  },
  {
    name: '5.f E2E Tarjeta Mis Materias con Datos Reales Semanales',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point5_subjects_card.py')]
  },
  {
    name: '5.g E2E Modo Offline e Iconos Locales',
    cmd: PYTHON,
    args: [path.join(ROOT_DIR, 'scripts/test_point6_offline_icons.py')]
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
