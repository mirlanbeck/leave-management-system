// Smoke: docker compose up -> /health = 200, перезапуск api, повторный up, том Postgres.
// RULES §8-1 (Mailpit и Postgres поднимаются вместе с сервисом), ROADMAP S0.
// Запуск: node scripts/smoke-compose.mjs [--keep]   (--keep: не останавливать стек в конце)
import { execFileSync } from 'node:child_process';

const keep = process.argv.includes('--keep');
const API = 'http://127.0.0.1:3000';
const WEB = 'http://127.0.0.1:8080';

const run = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const compose = (...args) => run(['compose', ...args]);
const step = (msg) => console.log(`\n== ${msg}`);

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
}

// Повтор нужен после restart контейнера: keep-alive соединение к старому процессу сбрасывается.
async function status(url, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      return (await fetch(url)).status;
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function psql(sql) {
  return compose('exec', '-T', 'postgres', 'psql', '-U', 'leave', '-d', 'leave', '-tA', '-c', sql).trim();
}

function ps() {
  return compose('ps', '--format', 'json')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertAllHealthy() {
  const services = ps();
  const names = services.map((s) => s.Service).sort();
  assert(names.join(',') === 'api,mailpit,postgres,web', `запущены 4 сервиса: ${names.join(', ')}`);
  for (const s of services) assert(s.Health === 'healthy', `${s.Service} healthy`);
}

function assertLoopbackOnly() {
  for (const s of ps()) {
    for (const p of s.Publishers ?? []) {
      if (p.PublishedPort) {
        assert(p.URL === '127.0.0.1', `${s.Service}:${p.PublishedPort} слушает только 127.0.0.1 (${p.URL})`);
      }
    }
  }
}

async function assertEndpoints() {
  assert((await status(`${API}/health`)) === 200, 'GET api /health = 200');
  assert((await status(`${WEB}/api/health`)) === 200, 'GET web /api/health = 200 (nginx срезает /api)');
  assert((await status(`${WEB}/`)) === 200, 'GET web / = 200');
}

try {
  step('docker compose up --build --wait');
  compose('up', '-d', '--build', '--wait');
  assertAllHealthy();
  assertLoopbackOnly();
  await assertEndpoints();

  step('том Postgres: данные переживают down/up');
  psql('CREATE TABLE IF NOT EXISTS smoke_marker (v text); INSERT INTO smoke_marker VALUES (\'kept\')');
  compose('down');
  compose('up', '-d', '--wait');
  assert(psql("SELECT count(*) FROM smoke_marker WHERE v='kept'") === '1', 'данные сохранились в именованном томе');
  psql('DROP TABLE smoke_marker');

  step('перезапуск api (миграции и seed идемпотентны)');
  compose('restart', 'api');
  compose('up', '-d', '--wait');
  await assertEndpoints();

  step('повторный up без изменений');
  compose('up', '-d', '--wait');
  assertAllHealthy();
  await assertEndpoints();

  step('healthcheck api падает при не-200');
  const apiId = compose('ps', '-q', 'api').trim();
  const test = JSON.parse(run(['inspect', '--format', '{{json .Config.Healthcheck.Test}}', apiId]));
  assert(test[0] === 'CMD', 'healthcheck api в форме CMD');
  compose('stop', 'postgres');
  assert((await status(`${API}/health`)) === 503, 'при остановленной БД /health = 503');
  let exitCode = 0;
  try {
    run(['exec', apiId, ...test.slice(1)]);
  } catch (e) {
    exitCode = e.status ?? 1;
  }
  assert(exitCode !== 0, `healthcheck при 503 завершается с ненулевым кодом (${exitCode})`);
  compose('start', 'postgres');
  compose('up', '-d', '--wait');
  await assertEndpoints();

  step('итог');
  console.log(compose('ps'));
  console.log('\nSMOKE OK');
} finally {
  if (!keep) compose('down');
}
