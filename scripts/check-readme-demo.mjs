// Демо-сценарий README на поднятом стеке: Mailpit, вход, демо-часы, seed:demo, письма и очереди.
// ROADMAP S9 и S10 (fresh-clone по командам README), README «Демо-сценарий согласования».
// Запуск из корня репозитория при запущенном стеке: node scripts/check-readme-demo.mjs
// Без npm ci: только встроенные модули Node. Часы ставятся PUT /clock, тем же путём, что кнопка
// «Установить» (DECISIONS 2026-10-30 14:24).
import { execSync } from 'node:child_process';

const WEB = 'http://127.0.0.1:8080';
const MAILPIT = 'http://127.0.0.1:8025';
const MAIL_WAIT_MS = 30_000;

const step = (msg) => console.log(`\n== ${msg}`);

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok: ${msg}`);
}

async function api(method, path, token, body) {
  const res = await fetch(`${WEB}/api${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FAIL: ${method} ${path} = ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function login(name) {
  const { accessToken } = await api('POST', '/auth/login', null, { login: name, password: 'demo1234' });
  return accessToken;
}

async function mailSubjects() {
  const res = await fetch(`${MAILPIT}/api/v1/messages?limit=100`);
  if (!res.ok) throw new Error(`FAIL: Mailpit /api/v1/messages = ${res.status}`);
  return (await res.json()).messages.map((m) => m.Subject);
}

const period = (v) => `${v.startDate}..${v.endDate}`;

// Очередь «Согласование»: одна заявка с ожидаемым автором, датами и пересечениями (README, шаг 5).
async function assertQueue(approver, employee, dates, overlaps) {
  const items = await api('GET', '/approvals', await login(approver));
  const got = items.map((i) => `${i.vacation.employee.fullName} ${period(i.vacation)}`);
  assert(
    got.length === 1 && got[0] === `${employee} ${dates}`,
    `${approver}: в очереди ${employee} ${dates} (${got.join('; ') || 'пусто'})`,
  );
  const ov = items[0].overlaps.map((o) => `${o.employee.fullName} ${period(o)}`);
  assert(ov.join('; ') === overlaps.join('; '), `${approver}: пересечения [${ov.join('; ')}]`);
}

try {
  step('Mailpit и вход (README, шаг 2)');
  assert((await fetch(`${MAILPIT}/`)).status === 200, 'Mailpit :8025 = 200');
  const james = await login('james');
  assert(Boolean(james), 'вход james');

  step('демо-часы 21.10.2026 09:00 (README, шаг 3)');
  const clock = await api('PUT', '/clock', james, { date: '2026-10-21', time: '09:00' });
  assert(clock.now === '2026-10-21T03:00:00.000Z', `часы ${clock.now} (09:00 Asia/Bishkek)`);

  step('npm run seed:demo (README, шаг 4)');
  execSync('npm run seed:demo', { stdio: 'inherit' });
  console.log('ok: npm run seed:demo, код 0');

  step('Mailpit: 10 писем, 7 о новых заявках и 3 о решениях (README, шаг 5)');
  let subjects = [];
  for (const deadline = Date.now() + MAIL_WAIT_MS; Date.now() < deadline;) {
    subjects = await mailSubjects();
    if (subjects.length >= 10) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const fresh = subjects.filter((s) => /новая заявка/i.test(s)).length;
  const decided = subjects.filter((s) => /заявка на отпуск (одобрена|отклонена)/i.test(s)).length;
  assert(
    subjects.length === 10 && fresh === 7 && decided === 3,
    `писем ${subjects.length}: о новых заявках ${fresh}, о решениях ${decided}`,
  );

  step('очереди «Согласование» при часах 21.10.2026 (README, шаг 5)');
  await assertQueue('daniel', 'Sophie Bennett', '2026-11-11..2026-11-17', ['James Walker 2026-11-09..2026-11-13']);
  await assertQueue('olivia', 'Grace Morgan', '2026-11-16..2026-11-20', []);
  await assertQueue('emily', 'Margaret Collins', '2026-11-09..2026-11-13', []);
  await assertQueue('thomas', 'Emily Carter', '2026-11-16..2026-11-20', []);
  const mine = await api('GET', '/vacations?scope=mine', await login('emily'));
  const own = mine.map((v) => `${v.status} ${period(v)}`);
  assert(own.join('; ') === 'PENDING 2026-11-16..2026-11-20', `emily: «Мои заявки» ${own.join('; ') || 'пусто'}`);

  console.log('\nREADME DEMO OK');
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 1;
}
