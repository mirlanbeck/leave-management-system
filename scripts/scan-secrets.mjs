// Секреты: gitleaks по истории HEAD (как job secrets в CI) и по рабочему дереву, включая неотслеживаемые
// файлы (docs/sessions/ до коммита экспорта). ROADMAP S9 (аудит 3, безопасность: секреты); DECISIONS 2026-11-01 18:11.
// Запуск: npm run scan:secrets   (нужен Docker; код выхода 1 при находке, значения скрыты --redact)
import { spawnSync } from 'node:child_process';

// Та же версия и digest, что в .github/workflows/ci.yml
const IMAGE =
  'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

function gitleaks(mode) {
  console.log(`\n== gitleaks ${mode}`);
  const args = ['run', '--rm', '-v', `${process.cwd()}:/repo:ro`, IMAGE, mode, '/repo'];
  args.push('--config', '/repo/.gitleaks.toml', '--redact', '--no-banner', '--verbose');
  const { status, error } = spawnSync('docker', args, { stdio: 'inherit' });
  if (error) throw error;
  return status;
}

const statuses = [gitleaks('git'), gitleaks('dir')];
process.exit(statuses.every((s) => s === 0) ? 0 : 1);
