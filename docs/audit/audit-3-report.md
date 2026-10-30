# Аудит 3 (финальный) сервиса «Отпуска» — отчёт

Объект: `C:\audit\leave-audit-3` (только чтение). Рабочие файлы: `C:\audit\audit-3-work`. Дата аудита: 2026-10-30.
Источники истины: `TMP-GENERAL-REQ.pdf`, `docs/RULES.md` (версия от 2026-10-29). Список утверждений, составленный до чтения кода: `audit-3-claims.md` (280 утверждений, C-001…C-280).

**Итог в двух строках.** Все штатные проверки зелёные, кроме ожидаемого теста README (README в копии нет): unit 540/541, int 789/789, web 116/116 (и в TZ=America/New_York), e2e 44/44, lint и typecheck чистые. Мои 9 сценариев (≈260 проверок) нашли одно расхождение с RULES (F-1: отрицательный остаток без сдвига даты выхода), две важные проблемы безопасности входа (F-2, F-3) и 10 замечаний. Гонки, письма, видимость SSE, IDOR, JWT и демо-часы без флага в порядке.

## 0. Как запускалось

**Окружение:** Windows 11 Pro 10.0.26200; Docker 29.8.2; Node v24.21.0; npm 11.6.2; Playwright 1.64.1 (Chromium 156, headless). Образы: postgres 17.6-bookworm, axllent/mailpit v1.27.8, nginx/1.28.0 (web). Контейнер api в поясе UTC, `COMPANY_TZ=Asia/Bishkek`, `DEMO_MODE=true` (по умолчанию compose).
Изоляция: `docker compose -p leave-audit-3 …`; для `e2e:reset` и `e2e` задан `COMPOSE_PROJECT_NAME=leave-audit-3`; мои скрипты вызывают тот же `e2e/reset.mjs` с этой переменной. Свободные порты проверены до старта; чужие контейнеры и тома не затрагивались. `test:int` работает на отдельной БД `leave_test` в Postgres этого проекта.

| # | Команда | Результат | Время | Лог |
|---|---|---|---|---|
| 1 | `docker compose -p leave-audit-3 up -d --build` | rc=0, 4 контейнера healthy | 31,6 с | logs/01-compose-up.log |
| 2 | `npm test` | rc=1: api 30 наборов, **540 passed / 1 failed** (`seed-data.spec.ts:102` «таблица в README совпадает с данными seed», README в копии нет — ожидаемо). Web-часть не запустилась из-за `&&` | 14 с | logs/02-npm-test.log |
| 3 | `npm run test:tz` (TZ=America/New_York) | rc=1: api **540/541**, тот же тест README | 11 с | logs/03-test-tz.log |
| 4 | `npm run test:int` | rc=0: 30 наборов, **789/789** | 521 с | logs/04-test-int.log |
| 5 | `npm run lint` | rc=0 (eslint api, web; prettier web, e2e) | 27 с | logs/05-lint.log |
| 6 | `npm run typecheck` | rc=0 (api, web, e2e) | 14 с | logs/06-typecheck.log |
| 7 | `npm run trace-rules` | rc=0: 74 пункта с метками; меток нет у §1-5, §2-1, §3-1, §3-5, §5-8, §7-7, §9-6 | 2 с | logs/07-trace-rules.log |
| 8 | `npm test -w apps/web` | rc=0: 19 файлов, **116/116** | 3 с | logs/08-web-test.log |
| 9 | `TZ=America/New_York npm test -w apps/web` | rc=0: **116/116** | 3 с | logs/09-web-test-ny.log |
| 10 | `npm run test:scripts` | rc=0: **12/12** | 1 с | logs/10-test-scripts.log |
| 11 | `COMPOSE_PROJECT_NAME=leave-audit-3 npm run e2e:reset` | rc=0 | 4 с | logs/11-e2e-reset.log |
| 12 | `COMPOSE_PROJECT_NAME=leave-audit-3 PLAYWRIGHT_HTML_OUTPUT_DIR=…/pw/playwright-report npm run e2e` | rc=0: **44/44 passed** | 4,3 мин | logs/12-e2e.log; HTML: pw/playwright-report |
| 13 | `DEMO_MODE=false docker compose -p leave-audit-3 up -d --no-deps --force-recreate api` (+ s08) | rc=0, api healthy, `DEMO_MODE=false` | — | logs/13-api-no-demo.log, logs/s08-no-demo.log |
| 14 | `docker compose -p leave-audit-3 up -d --no-deps --force-recreate api` (возврат) | rc=0, `DEMO_MODE=true` | — | logs/14-api-restore.log |
| 15 | `docker compose -p leave-audit-3 down` (без `-v`) | rc=0; том `leave-audit-3_pgdata` сохранён | — | logs/15-compose-down.log |

**Мои сценарии** (`scripts/*.mjs`, все против запущенного стека; `lib.mjs` — общие помощники):

| Скрипт | Что проверяет | Итог | Лог |
|---|---|---|---|
| s01-negative-balance.mjs | §6-4 минус без сдвига даты выхода | 2 PASS / **3 FAIL** (F-1) | logs/s01-negative-balance.log |
| s02-mail-matrix.mjs | §8 целиком: 33 ожидаемых письма по 11 видам событий, backstopper, HR, откат часов | 19/19 PASS | logs/s02-mail-matrix.log |
| s03-races.mjs (N=8) | 9 гонок × 8 повторов: approve‖approve, подача‖подача, approve‖reject, approve‖cancel, перенос‖перенос, approve переноса‖cancel переноса‖cancel старого, cancel‖cancel, recall‖recall | 72/72 PASS | logs/s03-races.log |
| s04-security.mjs | 401/404, маршрут × роль, IDOR, DTO, JWT, вход, bcrypt, CORS, заголовки | 99 PASS / **12 FAIL** (F-2, F-3, F-5, F-6, F-7, F-10) | logs/s04-security.log |
| s05-sse.mjs | видимость 11 событий `/events` для 11 пользователей; закрытие по exp | 13 PASS / 1 FAIL — артефакт клиента undici, опровергнут s05b | logs/s05-sse.log |
| s05b-sse-leak.mjs | утечка подписок: 200 сырых подключений/разрывов | 1/1 PASS (ESTABLISHED на :3000 до 1, после 0) | logs/s05b-sse-leak.log |
| s06-live-browser.mjs | PDF-B-7 и PDF-R-11: 5 браузерных контекстов + 2 вкладки одного пользователя, действия через UI; F-1 на экране | 20 PASS / **1 FAIL** (F-1) | logs/s06-live-browser.log; pw/shots/*.png |
| s07-boundaries.mjs, s07b-clock-9999.mjs | крайние значения демо-часов, праздник, «в прошлом», границы отзыва, начало в субботу, откат часов | 16+3 PASS / **1+1 FAIL** (F-4) | logs/s07-*.log |
| s08-no-demo.mjs | §9-2 без флага | 8/8 PASS (+F-11 по наблюдению) | logs/s08-no-demo.log |
| s09-tz-boundary.mjs | граница 1-го числа по COMPANY_TZ (api в UTC) | 3/3 PASS | logs/s09-tz-boundary.log |

**Изменения в копии.** Слепок без `node_modules` (путь, размер, mtime, SHA-256): до — 293 файла (`snapshot-before.csv`), после — 307 (`snapshot-final.csv`); разница в `snapshot-diff.txt`: **добавлено 14, изменено 0, удалено 0**.
- Ожидаемые от штатных команд и оставленные в копии: `apps/api/src/generated/prisma/**` (13 файлов, `prisma generate` в `npm test` / `lint` / `typecheck` / `test:int`) и `apps/api/dist/tsconfig.tsbuildinfo` (typecheck). Оба пути в `.gitignore`.
- Посторонний артефакт перенесён: `e2e/test-results/.last-run.json` → `moved-from-copy/e2e/test-results/`. Причина: аргумент `--output` из `npm run e2e -- --output=…` поглощается корневым `npm test -w e2e` и до Playwright не доходит; `outputDir` по умолчанию — `e2e/test-results`. Во время прогона там же временно лежали трассы `.playwright-artifacts-0/traces/*` с заголовками `Authorization: Bearer …` и паролем `demo1234`; Playwright удалил их сам по завершении (все тесты прошли, `trace: retain-on-failure`). HTML-отчёт ушёл в `pw/playwright-report` (переменная `PLAYWRIGHT_HTML_OUTPUT_DIR` сработала).

## 1. Находки

| ID | Серьёзность | Утверждение | Место | Сценарий (вход → фактическое → ожидаемое) | Воспроизведение | Уверенность |
|---|---|---|---|---|---|---|
| F-1 | **важно** | RULES §6-4: «После сдвига на более позднюю дату остаток может стать отрицательным; он показывается со знаком минус… **Это единственный случай минуса на экране**» | api/vacations/vacation-rules.ts:143-151 (подача проверяется по «доступно на дату начала» с будущими начислениями); api/approvals/approvals.service.ts:186-198 (повторная проверка тем же способом и списание всего отпуска сразу); api/balance/balance.service.ts:104; web/vacation/BalancePanel.tsx:12-13, web/vacation/format.ts:2,8; web/hr/EmployeeBalances.tsx:98; web/calendar/TeamBalances.tsx:18 | Часы 02.11.2026 10:00. Liam (выход 2026-10-12, дата не менялась) — баланс 1,5, «доступно на 07.12» = 4. Подача 07–10.12 (4 раб. дня) → 201; daniel одобряет → 200. Фактически: `GET /me/balance` → `balance: -2.5`; `/hr/balances` → −2,5; календарь руководителя → −2,5; на экране «Отпуск» «Доступно сегодня **−2,5**» с классом `negative`. Ожидаемо по §6-4: минус только после сдвига даты выхода. Так же в штатном e2e: `e2e/vacation.spec.ts:105` разрешает James подать до 40 дней при остатке 37,5 — после одобрения будет −2,5. Причина в самих RULES: §3-10 (прогноз с будущими начислениями) + §4-4 (списание сразу целиком) неизбежно дают минус в «балансе сегодня» (см. раздел 4, В-1) | scripts/s01-negative-balance.mjs; scripts/s06-live-browser.mjs (последний шаг); скриншот pw/shots/liam-negative-balance.png | ПОДТВЕРЖДЕНО запуском |
| F-2 | **важно** | В RULES не описано. Код утверждает обратное: «неизвестный логин и неверный пароль неразличимы (RULES §7-1)» | api/auth/auth.service.ts:27-30 — для неизвестного логина bcrypt не вызывается | 30 + 30 входов: медиана ответа для неизвестного логина **5,0 мс**, для существующего логина с неверным паролем **112,2 мс** → по времени ответа перебором определяется, какие логины существуют. Тело ответа одинаковое (это и проверяет единственный тест `api/auth/login.int.spec.ts:85`, время он не меряет). Ожидаемо: сопоставимое время (сравнение с фиктивным хешем) | scripts/s04-security.mjs, раздел 5 | ПОДТВЕРЖДЕНО запуском |
| F-3 | **важно** | В RULES не описано (п. 6 задания аудита: «лимит попыток входа») | api/auth/auth.controller.ts:10-15; ни throttler, ни счётчика неудач нет | 60 неверных паролей подряд для `emily` (HR) → 60 × 401, ни одного 429 и никакой блокировки; затем верный пароль → 200. Ожидаемо: ограничение частоты или временная блокировка | scripts/s04-security.mjs, раздел 5 | ПОДТВЕРЖДЕНО запуском |
| F-4 | замечание | RULES §9-2/§9-3 диапазон демо-часов не описывают; §9-3 «доступны любому вошедшему» | api/clock/dto/set-clock.dto.ts:4-8 (только regex); api/clock/company-time.ts:42-50; api/domain/accrual.ts:51-55; api/domain/calendar-date.ts:21-26 | Любой вошедший: `PUT /clock {date:"9999-12-31"}` → 200. После этого `GET /me/balance` → **500** (`RangeError: Некорректная дата: 10000-01-01` в `accrualEvents`), `/hr/balances` → 500, `/calendar` у руководителя → 500 (остатки подчинённых). Вернуть часы формой можно. Годы 0001–0099 отклоняются с неверным текстом «такой даты или времени нет в поясе компании» (`Date.UTC` переводит 0–99 в 1900–1999). Ожидаемо: ограничение диапазона, как у дат API (2000–2100, api/common/api-date.ts) | scripts/s07-boundaries.mjs, scripts/s07b-clock-9999.mjs | ПОДТВЕРЖДЕНО запуском |
| F-5 | замечание | В RULES не описано; RULES §9-1: «Срок JWT… по системным часам» | api/auth/jwt-auth.guard.ts:47-50; api/auth/auth.module.ts:19 (наличие `exp` не требуется) | Токен HS256 с верной подписью без поля `exp` → `GET /hr/balances` 200 (бессрочный). Подделка требует секрета; в compose он демо (`demo-only-not-for-production`, с пометкой «ТОЛЬКО ДЛЯ ДЕМО»), поэтому при демо-секрете токен HR подделывается в любом случае. Ожидаемо: отклонять токен без `exp` | scripts/s04-security.mjs, раздел 4 | ПОДТВЕРЖДЕНО запуском |
| F-6 | замечание | В RULES не описано (п. 6: «усечение пароля bcrypt до 72 байт») | api/auth/dto/login.dto.ts:8-10 (нет `MaxLength`); api/auth/password.ts (bcryptjs `compare`) | `bcrypt.compare('a'×72 + 'другой хвост', hash('a'×72 + 'SECRET-TAIL-1'))` → **true**: байты после 72-го не проверяются. Пароль из 100 000 символов принимается к проверке (401 за 114 мс). Демо-пароли короткие (8 символов), поэтому на текущих данных не эксплуатируется. Ожидаемо: ограничение длины (≤72 байт) или предварительный хеш | scripts/s04-security.mjs, раздел 5 | ПОДТВЕРЖДЕНО (библиотека); эксплуатация — ВОЗМОЖНО |
| F-7 | замечание | В RULES не описано (§3-8: «Комментарий… поле для ввода есть») | api/vacations/dto/create-vacation.dto.ts:19-21; api/approvals/dto/decision.dto.ts:5-7 | `POST /vacations` с комментарием 90 000 символов → 201 и запись в БД, в письмо руководителю, в экран согласования. Ограничен только размер тела express (100 КБ → 413) | scripts/s04-security.mjs, раздел 3 | ПОДТВЕРЖДЕНО запуском |
| F-8 | замечание | RULES §9-6: «Автотесты (Playwright) используют тот же механизм подмены часов» | e2e/reset.mjs:38-50 (`INSERT … ON CONFLICT` в `ClockState`); e2e/live-calendar.spec.ts:114 (вызов в сценарии) | В сценарии e2e часы меняются прямым SQL, в обход `PUT /clock`: не выполняется проход планировщика (§9-4) и не публикуется `clock.changed` (§10-2). Остальные сценарии используют форму (`setDemoClock`) — по §9-6 так должно быть везде | чтение кода | ВОЗМОЖНО (по чтению) |
| F-9 | замечание | PDF-B-7 «Календарь команды обновляется у всех, кто его смотрит» (тест сценария) | e2e/live-calendar.spec.ts:50-89 | Тест сценария смотрит только руководителей (daniel, olivia) и HR; зрителя-сотрудника (коллега видит календарь команды по §7-2) и блок «Мои отпуска» автора не проверяет; действие выполняется через API, не из второго клиента. Поведение при этом корректно: мой s06 — 5 контекстов (james, sophie, daniel, olivia, emily) и вторая вкладка daniel, одобрение и отмена через UI, обновление ≈0,2 с без перезагрузки | scripts/s06-live-browser.mjs | ПОДТВЕРЖДЕНО чтением теста; поведение ПОДТВЕРЖДЕНО запуском |
| F-10 | замечание | В RULES не описано (п. 6: «CORS и защитные заголовки») | apps/web/nginx.conf:1-23; api/main.ts:5 | Ответ web без `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options`, `Referrer-Policy`; `Server: nginx/1.28.0` раскрывает версию; через прокси проходит `X-Powered-By: Express`. CORS: чужой Origin не разрешён (заголовка ACAO нет) — в порядке | scripts/s04-security.mjs, раздел 6 | ПОДТВЕРЖДЕНО запуском |
| F-11 | замечание | RULES §9-2: «Без флага демо-режима… служебного эндпоинта нет» | api/clock/clock.controller.ts:19 (`DemoOnlyGuard` срабатывает после глобального JwtAuthGuard); api/clock/demo-only.guard.ts | `DEMO_MODE=false`: `GET/PUT /clock` с токеном → 404, но **без токена → 401**, тогда как действительно несуществующий маршрут без токена → 404. Анонимный клиент отличает существующий маршрут. Поведение задокументировано в коде и тестах (`routes-closed.spec.ts:80`), но буквально «эндпоинта нет» не выполняется | scripts/s08-no-demo.mjs; s04 («несуществующий маршрут без токена → 404») | ПОДТВЕРЖДЕНО запуском |
| F-12 | замечание | Видимость покрытия метками `// RULES §N-k` (п. 2 задания аудита) | см. раздел 2 | Метка пункта не означает проверки каждого подпункта: §1-1 «Праздники не учитываются» — нет теста (метка §1-1 только на тестах пн–пт; поведение верно, s07); §1-5 «время только через Clock» — статический тест есть только для web; §5-3 «чужой перенос не отменяют руководитель и HR» — отдельного теста нет; §5-8 «прямого изменения дат у HR нет» — нет; §6-4 «единственный случай минуса» — ни одного теста на отсутствие минуса (отсюда F-1); §8-6 — полной матрицы писем HR в тестах нет (только частные случаи; полная — мой s02, 33/33) | раздел 2 | ПОДТВЕРЖДЕНО чтением тестов |
| F-13 | замечание | п. 6 задания аудита: «токен не попадает в URL и логи» | e2e/playwright.config.ts:11-15 (`outputDir` по умолчанию в `e2e/`, `trace: 'retain-on-failure'`) | При падении e2e в `e2e/test-results/**/trace.zip` остаются заголовки `Authorization: Bearer <JWT>` и введённый пароль. В логах контейнеров api, web, postgres и mailpit токенов и паролей нет (0 совпадений), токен в URL API не принимает (401) | наблюдение во время прогона 12 (раздел 0) | ПОДТВЕРЖДЕНО наблюдением |

### Проверено, находок нет

- **Письма (§8, §3-3, §8-6, §10-1)** — s02: подача, двойной клик «согласовать», допуск HR, заявка HR, позднее одобрение (напоминание сразу), отклонение, отмена одобренного, перенос (подача и утверждение), перенос директора (отклонён HR), заявка «в прошлом» + отзыв HR, заявка заместителя, смена даты выхода, плановые напоминания 08:59/09:00, откат и повтор часов. Ожидалось 33 письма, пришло 33, лишних 0, дублей 0, в Mailpit 33 = SENT в outbox. Backstopper (sophie, emily) писем по этой роли не получил. HR получила только NEW_REQUEST по заявке и переносу директора, а также DECISION и REMINDER по своему отпуску.
- **Гонки (§10-1)** — s03, 72/72: два approve сверх остатка → 200+422; параллельная подача пересекающихся → 201+422; approve‖reject → 200+409 и одно письмо; approve‖cancel — согласованное состояние журнала; два переноса → 201+409; approve переноса‖отмена переноса‖отмена старого — во всех 8 повторах допустимое состояние (одна из трёх законных последовательностей, возврат по корню); две отмены и два отзыва → 200+409, один возврат. Первоначальные 5 FAIL — ошибка моего инварианта (возврат пишется на звено-перенос); исправлено и перезапущено.
- **Видимость SSE `/events` (§7-2, §10-2)** — s05: 11 событий × 11 одновременно подключённых пользователей, все получатели совпали с ожидаемыми, в том числе одобрение у директора (только margaret и emily), у HR (emily и thomas), у руководителя daniel (+ его команда и thomas), отзыв, перенос, смена даты выхода (сам, руководитель, HR; коллеги — нет), `clock.changed` всем 11; подача и отклонение событий не дают. Поток закрывается в момент `exp` токена.
- **Утечки подписок** — s05b: 4 × 50 сырых подключений с `destroy()` → ESTABLISHED на :3000 в api вернулось к 0; событие после массовых разрывов без ошибок в логе.
- **Живое обновление и два клиента (PDF-B-7, PDF-R-11)** — s06: одобрение через UI во второй вкладке daniel и отмена через UI во второй вкладке james обновили календари james («Мои отпуска»), sophie (коллега), daniel, emily (HR) без перезагрузки; у olivia (чужая команда) не появилось; выход во второй вкладке не разлогинил первую (sessionStorage на вкладку).
- **Календари только с одобренными** — подача не даёт события и записи (s05, s06); `calendar.int.spec.ts:75`.
- **HR действует только в случаях RULES (§7-2)** — s04: HR не отменяет и не переносит чужой отпуск до начала (403), не одобряет заявку сотрудника (403 NOT_APPROVER), очередь HR — только заявки директора; отзыв, смена даты выхода и допуск директора работают. Отдельной «отмены начавшегося» у HR нет, только отзыв (см. В-2).
- **Маршрут × роль, 401, 404, IDOR** — s04: 18 закрытых маршрутов без токена → 401; открыты только `/auth/login`, `/config`, `/health`; неизвестный маршрут → 404; некорректные id (`0`, `-1`, `abc`, `1 OR 1=1`, `1.5`, `01`, `2147483648`, `99999`) → 404; карточка отпуска видна только владельцу, руководителю и HR (коллега, backstopper, вышестоящий, чужой руководитель → 404); решение, отмена, перенос, отзыв, смена даты выхода чужими ролями → 403/404.
- **DTO и SQL** — лишние поля (`status`, `employeeId`, `workDays`, `replacesId`, `isHr`) и лишние параметры query → 400; объект вместо строки → 400; битый JSON → 400 без деталей. Весь сырой SQL в api — tagged templates `$queryRaw`/`$executeRaw` (18 вызовов) и `Prisma.join`; `*Unsafe` нет.
- **JWT** — изменённая подпись, `alg: none`, HS512, чужой секрет, просроченный `exp`, несуществующий `sub` → 401; токен в `?access_token=` → 401; срок 8 ч (28 800 с); без `JWT_SECRET` приложение не стартует (`api/auth/jwt-config.ts`, `common/startup.spec.ts`); в compose и `.env.example` секрет только демо с пометкой «ТОЛЬКО ДЛЯ ДЕМО».
- **Секреты в файлах копии** — кроме демо-значений (`demo1234`, `demo-only-not-for-production`, `leave/leave`) ничего не найдено (regex по ключам, PEM, AKIA, ghp_, sk-, JWT вне `node_modules`); `.env` в копии нет.
- **Порты** — Postgres, Mailpit, api, web опубликованы только на `127.0.0.1` (`docker port`, `netstat`).
- **Без DEMO_MODE (§9-2)** — s08: `/config` demoMode=false; `GET/PUT /clock` с токеном → 404 (в том числе с неверным телом); «сегодня» = системная дата по Asia/Bishkek (2026-10-30), сохранённое 2026-01-15 игнорируется и не меняется. Исключение — F-11.
- **Время (§1-3, §1-5, §9-1)** — прямого чтения системного времени в обход Clock в api и web нет (`new Date()` без аргументов только в `SystemClock`; SQL `now()` — только outbox и `updatedAt`, что разрешено §9-1). s09: контейнер в UTC; 31.10 23:59 Бишкек → «сегодня» 31.10 и остаток Liam 0; 01.11 00:00 Бишкек (в UTC ещё 31.10) → «сегодня» 01.11, начисление 1,5, подача проходит. 09:00: s02 и s07 (08:59 — нет, 09:00 — есть). `test:tz` зелёный.
- **Граничные входы** — s07: 01.01.2027 (пт) считается рабочим днём (§1-1); комментарий из пробелов для даты в прошлом → PAST_COMMENT_REQUIRED; прошлый год → PAST_START_YEAR; дата выхода вне отпуска (до и после) → 422; выход в субботу у отпуска пн–вс → возврат 0; начало в субботу 14.11 → напоминание в среду 11.11 sophie и daniel; откат часов не снимает доступ и не пересчитывает журнал. Даты API вне 2000–2100 → 400.
- **Логи** — в логах api, web, postgres и mailpit токенов, `Bearer` и паролей нет; ошибки 500 отдают клиенту только «Внутренняя ошибка сервера» (стек — только в лог).

## 2. Утверждение → тест

Сокращения путей: `api/` = `apps/api/src/`, `web/` = `apps/web/src/`, `e2e/` = `e2e/`. Тип: unit (jest/vitest без БД), int (jest + Postgres), e2e (Playwright). «Аудит» — мой скрипт из `C:\audit\audit-3-work\scripts` (не тест проекта; указан, когда утверждение подтверждено только им).
Статусы: **есть тест** — тело теста проверяет именно это утверждение; **нет теста**; **тест проверяет не то** — тест есть и помечен, но проверяет другое или часть; **нет реализации**; **расхождение с RULES**.
Номера C-nnn — из `audit-3-claims.md` (280 утверждений); здесь все 280.

### PDF

| C | Утверждение | Тест (файл:имя) | Тип | Статус |
|---|---|---|---|---|
| C-001 | PDF-R-1 «отдельный backend и frontend, по сети» | e2e/smoke.spec.ts:4 «страница открывается и видит API»; e2e/sse-nginx.spec.ts:25 | e2e | есть тест |
| C-002 | PDF-R-2 «Backend: Python, Go или Node.js» | — (Node.js/NestJS, проверено чтением package.json) | — | нет теста (не требуется) |
| C-003 | PDF-R-3 «Frontend: Vue или React» | — (React 19, apps/web/package.json) | — | нет теста (не требуется) |
| C-004 | PDF-R-4 «реляционная СУБД» | api/db/migration.int.spec.ts:36 | int | есть тест |
| C-005 | PDF-R-5 «Учётные записи и вход — на усмотрение» | api/auth/login.int.spec.ts:77 | int | есть тест |
| C-006 | PDF-R-6 «Промпты или лог решений сдаются вместе с кодом» | — | — | в копии нет (DECISIONS.md, README отсутствуют по условию аудита) |
| C-007 | PDF-R-7 «AI-агенты ожидаются» | — | — | не проверяемо |
| C-008 | PDF-R-8 «Предварительные требования описаны» | — | — | в копии нет README (по условию) |
| C-009 | PDF-R-9 «быстро разворачивается локально» | scripts/smoke-compose.mjs; аудит: `compose up --build` 31,6 с | — | есть тест (smoke-compose, не запускался в CI здесь) |
| C-010 | PDF-R-10 «Почту… заглушками» | e2e/mail.spec.ts:11 (Mailpit) | e2e | есть тест |
| C-011 | PDF-R-11 «Работает при двух одновременно открытых клиентах» | e2e/approvals.spec.ts:104 «две вкладки решают одну заявку»; e2e/live-clock.spec.ts:16; e2e/live-calendar.spec.ts:50 | e2e | есть тест; аудит s06 подтвердил |
| C-012 | PDF-R-12 «Честное описание состояния» | — | — | в копии нет README (по условию) |
| C-013 | PDF-R-13 «Доказуемость» | весь набор: 541+789+116+44 тестов, .github/workflows/ci.yml | — | есть |
| C-014…C-020 | PDF-E-1…E-7 (ссылка GitHub, модель, промпты, ход работы, описание, следующий заход, чужое решение) | — | — | вне кода; E-6 покрыт RULES §11; остальное в копии отсутствует по условию |
| C-021 | PDF-I-1 «Профиль: дата выхода, команда, руководитель» | api/org/me.int.spec.ts:46; e2e/web-shell.spec.ts:41 | int, e2e | есть тест |
| C-022 | PDF-I-2 «Накопление по отработанному времени» | api/domain/accrual.spec.ts:15; api/balance/balance.int.spec.ts:75 | unit, int | есть тест |
| C-023 | PDF-I-3 «Заявка: целиком или частями, правила дробления» | api/domain/vacation-form.spec.ts:31,44; api/vacations/vacations-submit.int.spec.ts:263 | unit, int | есть тест |
| C-024 | PDF-I-4 «подтвердить или отклонить с комментарием» | api/approvals/approvals.int.spec.ts:143,277,307; api/approvals/decision-mail.int.spec.ts:165 | int | есть тест |
| C-025 | PDF-I-5 «Календарь отпусков команды» | api/calendar/calendar.int.spec.ts:97; e2e/calendar.spec.ts:64 | int, e2e | есть тест |
| C-026 | PDF-I-6 «Экран HR: календарь компании, остатки» | api/calendar/calendar.int.spec.ts:172; api/hr/hr.int.spec.ts:116; e2e/calendar.spec.ts:111 | int, e2e | есть тест |
| C-027 | PDF-I-7 «Отмена и перенос отпуска» | e2e/cancel-recall.spec.ts:25; e2e/transfer.spec.ts:37 | e2e | есть тест |
| C-028 | PDF-B-1 «Сотрудник видит остаток… на сегодня и… к выбранной дате» | e2e/vacation.spec.ts:20 (тот же текст; проверяет 37,5 и 42,5/15 на выбранные даты) | e2e | есть тест |
| C-029 | PDF-B-2a «больше дней, чем будет накоплено… не проходит» | e2e/vacation.spec.ts:105 (INSUFFICIENT_BALANCE «доступно 40, в заявке 44») | e2e | есть тест |
| C-030 | PDF-B-2b «нарушающая правила дробления… с понятным объяснением» | e2e/vacation.spec.ts:120 (через год, без рабочих дней, пересечение — тексты) | e2e | есть тест |
| C-031 | PDF-B-3 «Руководитель — о новой заявке, сотрудник — о решении. По одному.» | e2e/approvals.spec.ts:27 (1 письмо daniel; после двойного клика — ровно 1 DECISION james; итого 2) | e2e | есть тест |
| C-032 | PDF-B-4 «согласованный отпуск на пересекающиеся даты — руководитель видит при согласовании» | e2e/approvals.spec.ts:65 | e2e | есть тест |
| C-033 | PDF-B-5 «напоминание… сотрудник и руководитель. Одно.» | e2e/reminder.spec.ts:16 (08:00 — нет, 09:00 — 2, вперёд/назад/вперёд — по-прежнему 2) | e2e | есть тест |
| C-034 | PDF-B-6a «Отмена согласованного отпуска возвращает дни» | e2e/cancel-recall.spec.ts:25 (32,5 → 37,5) | e2e | есть тест |
| C-035 | PDF-B-6b «Отмена после начала возвращает только неиспользованные» | e2e/cancel-recall.spec.ts:25 (отзыв HR, 35 → 37) | e2e | есть тест (через отзыв HR; см. раздел 3, П-2) |
| C-036 | PDF-B-7 «Календарь команды обновляется у всех, кто его смотрит, без обновления страницы» | e2e/live-calendar.spec.ts:50 (зрители daniel, emily, olivia; действия через API) | e2e | тест проверяет не то полностью: нет зрителя-сотрудника (коллеги) и «Моих отпусков» автора; аудит s06 закрыл пробел (см. F-9) |
| C-037 | PDF-B-8 «Изменение даты выхода… пересчитывает накопление» | e2e/hire-date.spec.ts:27, :78 | e2e | есть тест |

### RULES §1

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-038 | §1-1 «рабочих днях (пн–пт)» | api/domain/work-days.spec.ts:11,25,30 | unit | есть тест |
| C-039 | §1-1 «Праздники не учитываются» | — (метка §1-1 стоит на тестах пн–пт); аудит s07: 01.01.2027 (пт) = 1 рабочий день | — | нет теста |
| C-040 | §1-2 «Год календарный» | api/domain/vacation-form.spec.ts:33; api/domain/accrual.spec.ts:135 | unit | есть тест |
| C-041 | §1-3 «один пояс Asia/Bishkek» | api/clock/clock.spec.ts:51 | unit | есть тест |
| C-042 | §1-3 «COMPANY_TZ, по умолчанию Asia/Bishkek» | api/clock/clock.spec.ts:51; api/config/config.spec.ts:34 | unit | есть тест |
| C-043 | §1-3 «сегодня» по поясу | api/clock/clock.spec.ts:32,38,44; api/balance/balance.int.spec.ts:98; `npm run test:tz` | unit, int | есть тест |
| C-044 | §1-3 «начисление 1-го числа» по поясу | api/domain/balance.spec.ts:149 (день события по поясу); api/domain/balance.spec.ts:74,83 | unit | есть тест |
| C-045 | §1-3 «09:00 для напоминаний» по поясу | api/scheduler/reminder-scheduler.int.spec.ts:122,129; api/clock/company-time.spec.ts:5 | int, unit | есть тест |
| C-046 | §1-4 «даты без времени» | api/db/dates.int.spec.ts:29 | int | есть тест |
| C-047 | §1-4 «моменты в UTC» | api/db/dates.int.spec.ts:54 | int | есть тест |
| C-048 | §1-5 «Время только через Clock» | web/no-browser-clock.spec.ts:12 (только web) | unit | тест проверяет не то: для API статического теста нет (аудит: grep — нарушений нет) |

### §2

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-049 | §2-1 «30 в год, 2,5 в месяц» | api/domain/accrual.spec.ts:127 | unit | есть тест |
| C-050 | §2-2 «1-го числа» | api/domain/accrual.spec.ts:127; api/domain/balance.spec.ts:197 | unit | есть тест |
| C-051 | §2-2 «у всех по 2,5» | api/domain/accrual.spec.ts:127 | unit | есть тест |
| C-052 | §2-3 «от даты выхода до конца месяца, включая» | api/domain/accrual.spec.ts:30,41 | unit | есть тест |
| C-053 | §2-3 «не больше 2,5» | api/domain/accrual.spec.ts:58,113 | unit | есть тест |
| C-054 | §2-3 «до 0,5, ничья вверх» | api/domain/accrual.spec.ts:15,96 | unit | есть тест |
| C-055 | §2-3 «1-го следующего месяца» | api/domain/accrual.spec.ts:106 | unit | есть тест |
| C-056 | §2-3 «делитель 30; февраль → 2,5» | api/domain/accrual.spec.ts:58,71,81 | unit | есть тест |
| C-057…C-061 | §2-4 таблица (1, 5, 12, 15, 31 октября) | api/domain/accrual.spec.ts:15 (it.each по строкам таблицы) | unit | есть тест |
| C-062 | §2-5 «максимум 15» | api/domain/balance.spec.ts:65-135 | unit | есть тест |
| C-063 | §2-5 «сначала начисление, потом обрезка» | api/domain/accrual.spec.ts:135; api/domain/balance.spec.ts:223 | unit | есть тест |
| C-064 | §2-5 «срока нет» | api/domain/balance.spec.ts:135 | unit | есть тест |
| C-065 | §2-5 пример 20−5+2,5 → 15 | api/domain/balance.spec.ts:67 | unit | есть тест |
| C-066 | §2-6 «нет доступа до даты выхода» | api/auth/login.int.spec.ts:95,110 | int | есть тест |
| C-067 | §2-6 «нет остатка» | api/domain/balance.spec.ts:60; api/hr/hr.int.spec.ts:151 | unit, int | есть тест |
| C-068 | §2-6 «доступ не отзывается» | api/auth/login.int.spec.ts:152; api/hr/hr.int.spec.ts:325 | int | есть тест |
| C-069 | §2-7 «шаг 0,5» | api/domain/balance.spec.ts:271; api/balance/balance.int.spec.ts:195 | unit, int | есть тест |

### §3

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-070 | §3-1 «устно согласует» | — | — | организационное, кодом не проверяется |
| C-071 | §3-2 «даты» | api/vacations/vacations-submit.int.spec.ts:118 | int | есть тест |
| C-072 | §3-2 «backstopper обязателен» | api/vacations/vacations-submit.int.spec.ts:263 (BACKSTOPPER_REQUIRED) | int | есть тест |
| C-073 | §3-3 «кроме самого заявителя» | api/vacations/vacations-submit.int.spec.ts:277; api/db/constraints.int.spec.ts:80 | int | есть тест |
| C-074 | §3-3 «руководитель и HR могут быть выбраны» | api/vacations/vacations-submit.int.spec.ts:173 | int | есть тест |
| C-075 | §3-3 «занятость не блокирует» | api/vacations/vacations-submit.int.spec.ts:161 | int | есть тест |
| C-076 | §3-3 «Писем backstopper не получает» | api/approvals/decision-mail.int.spec.ts:152; api/scheduler/reminder-scheduler.int.spec.ts:263; e2e/mail.spec.ts:22; аудит s02 (33 письма, 0 backstopper) | int, e2e | есть тест |
| C-077 | §3-3 «видят руководитель и HR» | api/vacations/vacations-read.int.spec.ts:255; e2e/approvals.spec.ts:65 (approval-backstopper) | int, e2e | есть тест |
| C-078 | §3-4.1 «один год» | api/domain/vacation-form.spec.ts:33; api/db/constraints.int.spec.ts:56 | unit, int | есть тест |
| C-079 | §3-4.1 текст | api/vacations/vacation-rules.spec.ts:49; e2e/vacation.spec.ts:120 | unit, e2e | есть тест |
| C-080 | §3-4.1 «две заявки отдельно» | api/db/constraints.int.spec.ts:65 | int | есть тест (на уровне БД) |
| C-081 | §3-4.2 «минимум 1 рабочий день» | api/domain/vacation-form.spec.ts:46; e2e/vacation.spec.ts:120 | unit, e2e | есть тест |
| C-082 | §3-4.3 «пересечение с PENDING/APPROVED» | api/vacations/vacations-submit.int.spec.ts:372 | int | есть тест |
| C-083 | §3-4.3 текст «с … по …» | api/vacations/vacation-rules.spec.ts:141 | unit | есть тест |
| C-084 | §3-4.3 неактивные не мешают | api/vacations/vacations-submit.int.spec.ts:415 | int | есть тест |
| C-085 | §3-5 «Один период — одна заявка» | — (одно поле start/end в DTO) | — | нет теста (реализовано формой DTO) |
| C-086 | §3-6 «нельзя до первого начисления» | api/vacations/vacations-submit.int.spec.ts:343; e2e/vacation.spec.ts:53 | int, e2e | есть тест |
| C-087 | §3-7 «начало сегодня — не прошлое» | api/vacations/vacations-submit.int.spec.ts:587 | int | есть тест |
| C-088 | §3-7 «текущий год» | api/vacations/vacations-submit.int.spec.ts:596; api/domain/vacation-form.spec.ts:116,126 | int, unit | есть тест |
| C-089 | §3-7 «комментарий обязателен» | api/vacations/vacations-submit.int.spec.ts:570 | int | есть тест (комментарий из пробелов — аудит s07) |
| C-090 | §3-7 «остальные проверки те же» | api/domain/vacation-form.spec.ts:159,209 | unit | есть тест |
| C-091 | §3-7 «одобрена после начала» | api/approvals/approvals.int.spec.ts:189 | int | есть тест |
| C-092 | §3-8 «комментарий необязателен, поле есть» | api/vacations/vacations-submit.int.spec.ts:118 (без комментария); web/vacation/submit-logic.spec.ts:6 | int, unit | есть тест |
| C-093 | §3-9 «не больше накопленного к началу» | api/vacations/vacation-rules.spec.ts:300,319; api/vacations/vacations-submit.int.spec.ts:441 | unit, int | есть тест |
| C-094 | §3-9 «PENDING не резервируются» | api/vacations/vacations-submit.int.spec.ts:671 | int | есть тест |
| C-095 | §3-9 «объясняет причину» | api/vacations/vacations-submit.int.spec.ts:441 | int | есть тест |
| C-096 | §3-10 формула | api/domain/balance.spec.ts:188-243 | unit | есть тест |
| C-097 | §3-10 «события сегодня не повторно» | api/domain/balance.spec.ts:204,214 | unit | есть тест |
| C-098 | §3-10 «D = 1 января: начисление, затем обрезка» | api/domain/balance.spec.ts:223 | unit | есть тест |
| C-099 | §3-10 «D в прошлом — баланс сегодня» | api/domain/balance.spec.ts:190; api/balance/balance.int.spec.ts:89 | unit, int | есть тест |
| C-100 | §3-10 «одна формула при подаче и согласовании» | api/vacations/vacations-submit.int.spec.ts:645; api/approvals/approvals.int.spec.ts:506 | int | есть тест |
| C-101 | §3-10 «что видит сотрудник» (UI) | e2e/vacation.spec.ts:20 | e2e | есть тест |
| C-102 | §3-11 «5 статусов» | web/vacation/status.spec.ts:6,15 | unit | есть тест |
| C-103 | §3-11 «перенос на рассмотрении» | api/vacations/vacations-read.int.spec.ts:295; api/vacations/vacations-transfer.int.spec.ts:509 | int | есть тест |
| C-104 | §3-11 «утверждён: Одобрена/Заменена, баланс не меняется» | api/approvals/approvals-transfer.int.spec.ts:145 | int | есть тест |
| C-105 | §3-11 «отклонён/отменён: «Старый отпуск остаётся»» | api/approvals/approvals-transfer.int.spec.ts:329; api/vacations/vacations-transfer.int.spec.ts:569; api/vacations/vacations-read.int.spec.ts:308 | int | есть тест |
| C-106 | §3-11 «календарь и напоминания только «Одобрена»» | api/calendar/calendar.int.spec.ts:75; api/scheduler/reminder-scheduler.int.spec.ts:195; api/mail/outbox-dispatcher.int.spec.ts:343 | int | есть тест |
| C-107 | §3-11 «остаток от статуса не зависит» | api/approvals/approvals-transfer.int.spec.ts:145; api/domain/balance.spec.ts:143 | int, unit | есть тест |
| C-108 | §3-12 «не раньше даты выхода» | api/vacations/vacations-submit.int.spec.ts:357,605; api/domain/vacation-form.spec.ts:143,159 | int, unit | есть тест |
| C-109 | §3-12 «в день выхода допустимо» | api/vacations/vacations-submit.int.spec.ts:605 | int | есть тест |
| C-110 | §3-12 «к переносу не применяется» | api/vacations/vacations-transfer.int.spec.ts:374; api/domain/vacation-form.spec.ts:271 | int, unit | есть тест |

### §4

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-111 | §4-1 «только непосредственный» | api/approvals/approvals.int.spec.ts:345,361; api/approvals/approval-rules.spec.ts:43,48; аудит s04 | int, unit | есть тест |
| C-112 | §4-1 «комментарий необязателен» | api/approvals/approvals.int.spec.ts:307 | int | есть тест |
| C-113 | §4-1 «руководителя — его руководитель» | api/approvals/approvals.int.spec.ts:391,481 | int | есть тест |
| C-114 | §4-1 «HR → заместитель → директор» | api/approvals/approvals.int.spec.ts:181; api/org/approver.int.spec.ts:41 | int | есть тест |
| C-115 | §4-2 «директор → HR» | api/approvals/approvals.int.spec.ts:172; e2e/approvals.spec.ts:135 | int, e2e | есть тест |
| C-116 | §4-2 «называется «допуск HR»» | api/mail/mail-templates.spec.ts:44; e2e/approvals.spec.ts:158 (region «Допуск HR») | unit, e2e | есть тест |
| C-117 | §4-2 «статус Одобрена, дни списываются» | api/approvals/approvals.int.spec.ts:172 | int | есть тест |
| C-118 | §4-2 «единственное исключение» | api/approvals/approvals.int.spec.ts:379 (HR по заявке сотрудника 403); аудит s04 | int | есть тест |
| C-119 | §4-3 «проверяется повторно» | api/approvals/approvals.int.spec.ts:218,251 | int | есть тест |
| C-120 | §4-3 «остаётся На согласовании» | api/approvals/approvals.int.spec.ts:218 | int | есть тест |
| C-121 | §4-3 «осталось X, в заявке Y» | api/approvals/approval-rules.spec.ts:112 | unit | есть тест |
| C-122 | §4-3 «может отклонить» | e2e/approvals.spec.ts:179 | e2e | есть тест |
| C-123 | §4-3 «автоотклонения нет» | api/approvals/approvals.int.spec.ts:218 (статус не меняется) | int | есть тест |
| C-124 | §4-4 «списываются сразу, целиком» | api/approvals/approvals.int.spec.ts:143 | int | есть тест |
| C-125 | §4-4 «январская одобрена в декабре» | api/approvals/approvals.int.spec.ts:201 | int | есть тест |
| C-126 | §4-5 «после даты начала остаётся, задним числом» | api/approvals/approvals.int.spec.ts:189,294; api/vacations/vacations-cancel.int.spec.ts:233 | int | есть тест |
| C-127 | §4-6 «предупреждение: подчинённые и он сам» | api/approvals/approvals.int.spec.ts:530 | int | есть тест |
| C-128 | §4-6 «не блокируется» | e2e/approvals.spec.ts:65 | e2e | есть тест |
| C-129 | §4-6 «PENDING не учитываются» | api/approvals/approvals.int.spec.ts:530 | int | есть тест |
| C-130 | §4-6 «директор: его подчинённые и он сам» | api/approvals/approvals.int.spec.ts:586 | int | есть тест |
| C-131 | §4-7 «список PENDING прямых подчинённых» | api/approvals/approvals.int.spec.ts:450 | int | есть тест |
| C-132 | §4-7 «поля карточки» | e2e/approvals.spec.ts:65 | e2e | есть тест |
| C-133 | §4-7 «остаток и предупреждение» | api/approvals/approvals.int.spec.ts:506; e2e/approvals.spec.ts:65 | int, e2e | есть тест |

### §5

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-134 | §5-1 «только до начала» | api/vacations/vacations-transfer.int.spec.ts:443 | int | есть тест |
| C-135 | §5-1 «HR отзывает» | api/vacations/vacations-cancel.int.spec.ts:284 | int | есть тест |
| C-136 | §5-2 «то же число рабочих дней» | api/vacations/vacations-transfer.int.spec.ts:254 | int | есть тест |
| C-137 | §5-2 «из одобренного» | api/vacations/vacations-transfer.int.spec.ts:428 | int | есть тест |
| C-138 | §5-2 «правила §3, один год» | api/vacations/vacation-rules.spec.ts:514; api/vacations/vacations-transfer.int.spec.ts:302 | unit, int | есть тест |
| C-139 | §5-2 «согласует руководитель / HR для директора» | api/approvals/approvals-transfer.int.spec.ts:200,214,221 | int | есть тест |
| C-140 | §5-2 «старый Одобрена → Заменена» | api/approvals/approvals-transfer.int.spec.ts:145 | int | есть тест |
| C-141 | §5-2 «недоступны Отменить и Перенести» | api/vacations/vacations-transfer.int.spec.ts:473,524,610 | int | есть тест |
| C-142 | §5-2 «число дней равно, объяснение» | api/vacations/vacation-rules.spec.ts:505 | unit | есть тест |
| C-143 | §5-2 «остаток не проверяется» | api/approvals/approvals-transfer.int.spec.ts:282; api/vacations/vacations-transfer.int.spec.ts:374 | int | есть тест |
| C-144 | §5-2 «баланс не меняется» | api/approvals/approvals-transfer.int.spec.ts:145 | int | есть тест |
| C-145 | §5-2 «backstopper подставлен» | web/vacation/transfer-logic.spec.ts:33 | unit | есть тест |
| C-146 | §5-2 «начало не раньше сегодня» | api/vacations/vacations-transfer.int.spec.ts:267,286 | int | есть тест |
| C-147 | §5-2 «прошлое не допускается» | api/vacations/vacation-rules.spec.ts:491 | unit | есть тест |
| C-148 | §5-2 «комментарий необязателен» | api/vacations/vacations-transfer.int.spec.ts:188 | int | есть тест |
| C-149 | §5-2 «старый не участвует в пересечениях» | api/vacations/vacations-transfer.int.spec.ts:335,345 | int | есть тест |
| C-150 | §5-2 «нельзя утвердить, если старый начался» | api/approvals/approvals-transfer.int.spec.ts:243 | int | есть тест |
| C-151 | §5-3 «отмена переноса» | api/vacations/vacations-transfer.int.spec.ts:569; e2e/transfer.spec.ts:100 | int, e2e | есть тест |
| C-152 | §5-3 «старый нельзя отменить, включая HR и отзыв» | api/vacations/vacations-transfer.int.spec.ts:524,539,548,561 | int | есть тест |
| C-153 | §5-3 «перенос отменяет только автор» | api/vacations/vacations-cancel.int.spec.ts:243 (для обычной заявки) | int | тест проверяет не то: отказ руководителю/HR проверен на обычной заявке, отдельного теста «чужой перенос» нет (аудит: та же функция cancelError, s04) |
| C-154 | §5-4 «сам, без одобрения» | api/vacations/vacations-cancel.int.spec.ts:151 | int | есть тест |
| C-155 | §5-4 «дни полностью» | api/vacations/vacations-cancel.int.spec.ts:151; e2e/cancel-recall.spec.ts:25 | int, e2e | есть тест |
| C-156 | §5-4 «На согласовании» | api/vacations/vacations-cancel.int.spec.ts:177 | int | есть тест |
| C-157 | §5-4 «до начала отменяет только сотрудник» | api/vacations/vacations-cancel.int.spec.ts:243 | int | есть тест |
| C-158 | §5-5 «окно отзыва» | api/vacations/vacations-cancel.int.spec.ts:375,383,336 | int | есть тест |
| C-159 | §5-5 «из завершённого нет» | api/vacations/vacations-cancel.int.spec.ts:383 | int | есть тест |
| C-160 | §5-5 «свой отпуск HR» | api/vacations/vacations-cancel.int.spec.ts:343 | int | есть тест |
| C-161 | §5-5 «Отменена, в календаре нет» | api/calendar/calendar.int.spec.ts:277 | int | есть тест |
| C-162 | §5-5 «использованные остаются списанными» | api/vacations/vacations-cancel.int.spec.ts:284 | int | есть тест |
| C-163 | §5-6 «день выхода рабочий; пример 4 дня» | api/vacations/vacations-cancel.int.spec.ts:284 | int | есть тест |
| C-164 | §5-6 «выход в субботу → 0» | api/vacations/vacations-cancel.int.spec.ts:328 | int | есть тест |
| C-165 | §5-7 «сотрудник после начала не может» | api/vacations/vacations-cancel.int.spec.ts:218 | int | есть тест |
| C-166 | §5-8 «Прямого изменения дат у HR нет» | api/common/routes-closed.spec.ts:38 (перечень маршрутов) | unit | тест проверяет не то: проверяет закрытость маршрутов, не отсутствие правки дат; аудит: маршрута правки дат нет |
| C-167 | §5-9 «начался: сегодня ≥ начала» | api/vacations/cancel-rules.spec.ts:42; api/vacations/vacations-cancel.int.spec.ts:200 | unit, int | есть тест |
| C-168 | §5-10 «PENDING после начала не отменяет никто» | api/vacations/vacations-cancel.int.spec.ts:233,396,566 | int | есть тест |
| C-169 | §5-10 «HR до начала не отменяет чужие» | api/vacations/vacations-cancel.int.spec.ts:243 | int | есть тест |
| C-170 | §5-10 «HR свой — как сотрудник» | api/vacations/vacations-cancel.int.spec.ts:191 | int | есть тест |
| C-171 | §5-11 «от начала до окончания включительно» | api/vacations/vacations-cancel.int.spec.ts:284,361 | int | есть тест |
| C-172 | §5-11 «выход в дату начала — все дни» | api/vacations/vacations-cancel.int.spec.ts:284 (it.each) | int | есть тест |
| C-173 | §5-11 «после окончания — отказ» | api/vacations/vacations-cancel.int.spec.ts:361 | int | есть тест |
| C-174 | §5-11 «раньше начала — отказ» | api/vacations/vacations-cancel.int.spec.ts:361 ('2026-11-06') | int | есть тест |
| C-175 | §5-11 «прошлое и будущее» | api/vacations/vacations-cancel.int.spec.ts:318 | int | есть тест |
| C-176 | §5-12 «ссылка на исходную» | api/vacations/vacations-transfer.int.spec.ts:164 | int | есть тест |
| C-177 | §5-12 «цепочка A→B→C» | api/approvals/approvals-transfer.int.spec.ts:409; api/vacations/vacations-transfer.int.spec.ts:727 | int | есть тест |
| C-178 | §5-12 «звенья не оживают» | api/vacations/vacations-transfer.int.spec.ts:677,716 | int | есть тест |

### §6

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-179 | §6-1 «только HR» | api/hr/hr.int.spec.ts:408,418 | int | есть тест |
| C-180 | §6-1 «в любую сторону» | api/hr/hr.int.spec.ts:177,197; e2e/hire-date.spec.ts:78 | int, e2e | есть тест |
| C-181 | §6-1 «пересчитывается всегда» | api/hr/hr.int.spec.ts:245 | int | есть тест |
| C-182 | §6-2 «предупреждение» | web/hr/hire-date-logic.spec.ts:13,20; e2e/hire-date.spec.ts:27 | unit, e2e | есть тест |
| C-183 | §6-3 «сообщение, один раз» | web/hr/hire-date-logic.spec.ts:8; e2e/hire-date.spec.ts:27 (после reload нет) | unit, e2e | есть тест |
| C-184 | §6-3 «Письма нет» | api/hr/hr.int.spec.ts:285; e2e/hire-date.spec.ts:27 | int, e2e | есть тест |
| C-185 | §6-3 «нет блокировок и отмен» | api/hr/hr.int.spec.ts:285 | int | есть тест |
| C-186 | §6-4 «минус и цвет» | web/vacation/format.spec.ts:14; e2e/hire-date.spec.ts:27 | unit, e2e | есть тест |
| C-187 | §6-4 «единственный случай минуса на экране» | — (все тесты проверяют минус после сдвига; обратного нет) | — | **расхождение с RULES** (F-1, аудит s01, s06) |
| C-188 | §6-5 «доступ не отзывается» | api/hr/hr.int.spec.ts:325,334 | int | есть тест |
| C-189 | §6-6 «по журналу, не хранится» | api/domain/balance.spec.ts:141-179 | unit | есть тест |
| C-190 | §6-6 «баланс сегодня» | api/domain/balance.spec.ts:143 | unit | есть тест |
| C-191 | §6-6 «до обрезки, если строго раньше 1 января по поясу» | api/domain/balance.spec.ts:74,83,92,101 | unit | есть тест |
| C-192 | §6-6 «порядок дня» | api/domain/balance.spec.ts:159 | unit | есть тест |
| C-193 | §6-6 «approvedAt по Clock, не пересчитываются» | api/approvals/decision-mail.int.spec.ts:132; api/seed-demo.int.spec.ts:250 | int | есть тест |
| C-194 | §6-6 «смена даты выхода: только начисления» | api/domain/balance.spec.ts:166; api/hr/hr.int.spec.ts:245 | unit, int | есть тест |
| C-195 | §6-6 «списание за заявкой» | api/db/constraints.int.spec.ts:227 | int | есть тест |
| C-196 | §6-6 «у переноса своего списания нет» | api/approvals/approvals-transfer.int.spec.ts:145 | int | есть тест |
| C-197 | §6-6 «возврат только отменой или отзывом» | api/vacations/vacations-cancel.int.spec.ts:151,284; api/approvals/approvals.int.spec.ts:277 (отклонение без возврата) | int | есть тест |
| C-198 | §6-7 «при первом входе, не снимается» | api/auth/login.int.spec.ts:143,152 | int | есть тест |
| C-199 | §6-7 «вход до даты выхода запрещён без признака» | api/auth/login.int.spec.ts:95,152 | int | есть тест |
| C-200 | §6-7 «seed ставит признак» | api/seed.int.spec.ts:122,128,136 | int | есть тест |
| C-201 | §6-8 «к корню цепочки» | api/db/constraints.int.spec.ts:350,378; api/vacations/vacations-transfer.int.spec.ts:677 | int | есть тест |
| C-202 | §6-8 «не превышает списанного» | api/db/constraints.int.spec.ts:272,426 | int | есть тест |
| C-203 | §6-8 «повторная отмена — уже обработана» | api/vacations/vacations-cancel.int.spec.ts:429; аудит s03 | int | есть тест |

### §7

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-204 | §7-1 «логин, пароль, JWT» | api/auth/jwt.int.spec.ts:56,65 | int | есть тест |
| C-205 | §7-1 «пароли хешем» | api/auth/password.spec.ts:5,19 | unit | есть тест |
| C-206 | §7-1 «три роли» | web/routes/access.spec.ts:12-25; api/org/policy.spec.ts:32 | unit | есть тест |
| C-207 | §7-1 «у HR свои дни» | api/vacations/vacations-cancel.int.spec.ts:191; api/scheduler/reminder-scheduler.int.spec.ts:256 | int | есть тест |
| C-208 | §7-2 «только одобренные» | api/calendar/calendar.int.spec.ts:75 | int | есть тест |
| C-209 | §7-2 «два блока; своих в команде нет» | web/calendar/calendar-logic.spec.ts:107; e2e/calendar.spec.ts:64,92 | unit, e2e | есть тест |
| C-210 | §7-2 «В этом месяце отпусков нет» | e2e/calendar.spec.ts:82 | e2e | есть тест |
| C-211 | §7-2 «руководитель — прямых; коллег-руководителей нет» | api/calendar/calendar.int.spec.ts:149,162; api/org/policy.spec.ts:125 | int, unit | есть тест |
| C-212 | §7-2 «сотрудник — коллег и руководителя» | api/calendar/calendar.int.spec.ts:97 | int | есть тест |
| C-213 | §7-2 «заявки, карточки, остатки коллег не видны» | api/calendar/calendar.int.spec.ts:113,125,206 | int | есть тест |
| C-214 | §7-2 «HR — вся компания» | api/calendar/calendar.int.spec.ts:172 | int | есть тест |
| C-215 | §7-2 «Остаток: свой / подчинённых / всех» | api/calendar/calendar.int.spec.ts:187,206; api/hr/hr.int.spec.ts:116,158 | int | есть тест |
| C-216 | §7-2 «Заявки по ролям; HR — все статусы» | api/vacations/vacations-read.int.spec.ts:76,121,153,171 | int | есть тест |
| C-217 | §7-2 «HR действует только в случаях…» | api/common/access-matrix.int.spec.ts:364; api/vacations/vacations-cancel.int.spec.ts:243; api/vacations/vacations-transfer.int.spec.ts:390; аудит s04 | int | есть тест |
| C-218 | §7-2 «Backstopper заявку не видит» | api/vacations/vacations-read.int.spec.ts:275 | int | есть тест |
| C-219 | §7-2 «Профиль: поля; у директора пусто» | api/org/me.int.spec.ts:46,61,68 | int | есть тест |
| C-220 | §7-2 «Профиль только чтение» | e2e/web-shell.spec.ts:41; api/common/routes-closed.spec.ts:38 | e2e | есть тест |
| C-221 | §7-3 «только прямые подчинённые» | api/org/policy.spec.ts:69; api/calendar/calendar.int.spec.ts:162 | unit, int | есть тест |
| C-222 | §7-3 «состав только seed» | — | — | нет теста (аудит: маршрута смены руководителя нет) |
| C-223 | §7-4 «без перезагрузки» | e2e/live-calendar.spec.ts:50 | e2e | тест проверяет не то полностью (см. C-036) |
| C-224 | §7-5 «11 пользователей, иерархия» | api/seed-data.spec.ts:19,25,31; api/seed.int.spec.ts:71 | unit, int | есть тест |
| C-225 | §7-5 «даты выхода» | api/seed-data.spec.ts:48 | unit | есть тест |
| C-226 | §7-5 «Сотрудник 3: 1,5, до 1 ноября нельзя» | e2e/vacation.spec.ts:53; api/balance/balance.int.spec.ts:172 | e2e, int | есть тест |
| C-227 | §7-6 «логины и пароли — в README» | api/seed-data.spec.ts:102 | unit | тест падает: README в копии нет (по условию аудита) |
| C-228 | §7-7 «Фронт-отдел / Бэк-отдел» | api/seed-data.spec.ts:68; api/seed.int.spec.ts:71 | unit, int | есть тест |
| C-229 | §7-7 «у руководства пусто» | api/seed-data.spec.ts:68; api/org/me.int.spec.ts:68 | unit, int | есть тест |

### §8

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-230 | §8-1 «только письма» | — | — | нет теста (аудит: других каналов нет; SSE несёт только id и не показывается как уведомление) |
| C-231 | §8-1 «Уведомлений в интерфейсе нет» | — | — | нет теста (чтение кода: нет) |
| C-232 | §8-2 «новая → руководителю» | api/vacations/vacations-submit.int.spec.ts:685 | int | есть тест |
| C-233 | §8-2 «решение → сотруднику» | api/approvals/decision-mail.int.spec.ts:132,165 | int | есть тест |
| C-234 | §8-2 «по одному» | api/vacations/vacations-submit.int.spec.ts:780; api/approvals/decision-mail.int.spec.ts:274,288 | int | есть тест |
| C-235 | §8-2 «перенос — новая заявка, письма» | api/vacations/vacations-transfer.int.spec.ts:206; api/approvals/approvals-transfer.int.spec.ts:170 | int | есть тест |
| C-236 | §8-2 «директор: HR, решение — директору» | api/vacations/vacations-transfer.int.spec.ts:223; api/approvals/approvals-transfer.int.spec.ts:200; e2e/mail.spec.ts:22 | int, e2e | есть тест |
| C-237 | §8-2 «HR — заместитель, решение HR» | api/approvals/decision-mail.int.spec.ts:205 | int | есть тест |
| C-238 | §8-3 «N раб. дней, 09:00, REMINDER_DAYS» | api/scheduler/reminder-scheduler.int.spec.ts:129,381; api/config/reminder-days.spec.ts:5 | int, unit | есть тест |
| C-239 | §8-3 «одно на каждого» | api/scheduler/reminder-scheduler.int.spec.ts:282,291 | int | есть тест |
| C-240 | §8-3 пример 10.11 → 05.11 | api/domain/reminder.spec.ts:12 | unit | есть тест |
| C-241 | §8-3 «начало в субботу 14.11 → 11.11» | api/domain/reminder.spec.ts:26; аудит s07 | unit | есть тест |
| C-242 | §8-3 «проверка при отправке» | api/mail/outbox-dispatcher.int.spec.ts:343; api/scheduler/reminder-scheduler.int.spec.ts:205 | int | есть тест |
| C-243 | §8-3 «перенос: напоминания» | api/scheduler/reminder-scheduler.int.spec.ts:218; api/approvals/late-reminder.int.spec.ts:262,275,284 | int | есть тест |
| C-244 | §8-3 «писем о старом нет» | api/approvals/approvals-transfer.int.spec.ts:170 | int | есть тест |
| C-245 | §8-3 «уникальность» | api/db/constraints.int.spec.ts:481 | int | есть тест |
| C-246 | §8-3 «позднее одобрение (3 подслучая)» | api/approvals/late-reminder.int.spec.ts:118,137,147 | int | есть тест |
| C-247 | §8-4 «начало наступило — нет» | api/approvals/late-reminder.int.spec.ts:157; api/mail/outbox-dispatcher.int.spec.ts:381 | int | есть тест |
| C-248 | §8-5 «получатели; директор — сам» | api/scheduler/reminder-scheduler.int.spec.ts:249,273 | int | есть тест |
| C-249 | §8-6 «HR напоминание не получает» | api/scheduler/reminder-scheduler.int.spec.ts:263 | int | есть тест |
| C-250 | §8-6 «HR только письмо о заявке директора» | api/seed-demo.int.spec.ts:223; api/approvals/decision-mail.int.spec.ts:152; аудит s02 (полная матрица) | int | есть тест (частично; полная матрица — аудит s02) |
| C-251 | §8-6 «HR по своей — решение и напоминание; и заместитель» | api/scheduler/reminder-scheduler.int.spec.ts:256; api/approvals/decision-mail.int.spec.ts:205 | int | есть тест |
| C-252 | §8-7 «HR писем об отменах и переносах не получает» | api/vacations/vacations-cancel.int.spec.ts:475; api/vacations/vacations-transfer.int.spec.ts:206 | int | есть тест |
| C-253 | §8-8 «отмена и отзыв без писем» | api/vacations/vacations-cancel.int.spec.ts:475 | int | есть тест |
| C-254 | §8-8 «напоминание по отменённому не уходит» | api/scheduler/reminder-scheduler.int.spec.ts:205 | int | есть тест |

### §9

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-255 | §9-1 «сегодня только через Clock» | web/no-browser-clock.spec.ts:12; e2e/vacation.spec.ts:39 | unit, e2e | есть тест (web); API — см. C-048 |
| C-256 | §9-1 «Clock хранит момент» | api/clock/clock.int.spec.ts:73 | int | есть тест |
| C-257 | §9-1 «JWT и outbox по системным часам» | api/auth/jwt.int.spec.ts:130; api/mail/outbox-dispatcher.int.spec.ts:466 | int | есть тест |
| C-258 | §9-1 «Clock — момент создания письма» | api/vacations/vacations-submit.int.spec.ts:733; api/approvals/decision-mail.int.spec.ts:132 | int | есть тест |
| C-259 | §9-2 «флаг в compose» | api/clock/db-clock.int.spec.ts:112,124 | int | есть тест |
| C-260 | §9-2 «заморожены с первого старта» | api/clock/db-clock.int.spec.ts:47,56,82 | int | есть тест |
| C-261 | §9-2 «вперёд и назад» | api/clock/clock.int.spec.ts:92 | int | есть тест |
| C-262 | §9-2 «сохраняется при перезапуске» | api/clock/db-clock.int.spec.ts:56 | int | есть тест |
| C-263 | §9-2 «без флага: системные, эндпоинта нет» | api/clock/clock.int.spec.ts:196,213; api/clock/db-clock.int.spec.ts:112; аудит s08 (в конце) | int | есть тест |
| C-264 | §9-3 «полоса, форма, 09:00, «остановлены»» | e2e/web-clock.spec.ts:6,26; web/clock/clock-logic.spec.ts:67 | e2e, unit | есть тест |
| C-265 | §9-3 «любому вошедшему» | api/clock/clock.int.spec.ts:173; e2e/web-clock.spec.ts:6 | int, e2e | есть тест |
| C-266 | §9-4 «планировщик при старте и после установки» | api/clock/clock.int.spec.ts:132; api/scheduler/reminder-scheduler.int.spec.ts:351 | int | есть тест |
| C-267 | §9-5 «откат не пересчитывает журнал» | api/scheduler/reminder-scheduler.int.spec.ts:291; api/seed.int.spec.ts:175 | int | есть тест |
| C-268 | §9-6 «Playwright тем же механизмом» | e2e/reset.mjs:38-50 и e2e/live-calendar.spec.ts:114 ставят часы прямым SQL | — | тест проверяет не то (F-8) |

### §10

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-269 | §10-1 «уже обработана» | api/approvals/approvals-transfer.int.spec.ts:230; api/vacations/vacations-cancel.int.spec.ts:429,439 | int | есть тест |
| C-270 | §10-1 «атомарно, проходит один» | api/approvals/approvals.int.spec.ts:681,695,714; api/vacations/vacations-submit.int.spec.ts:754; api/approvals/approvals-transfer.int.spec.ts:365,389; аудит s03 (72/72) | int | есть тест |
| C-271 | §10-1 «письмо ровно одно» | api/approvals/decision-mail.int.spec.ts:274; e2e/vacation.spec.ts:80; e2e/approvals.spec.ts:104 | int, e2e | есть тест |
| C-272 | §10-1 «напоминание не дублируется при перезапуске/откате» | api/scheduler/reminder-scheduler.int.spec.ts:291,371 | int | есть тест |
| C-273 | §10-2 «одобрена» | api/events/sse.int.spec.ts:159 | int | есть тест |
| C-274 | §10-2 «отменён (сотрудник, HR, отзыв)» | api/events/sse.int.spec.ts:346,367 | int | есть тест |
| C-275 | §10-2 «перенос утверждён» | api/events/sse.int.spec.ts:396 | int | есть тест |
| C-276 | §10-2 «дата выхода: он, руководитель, HR; коллеги нет» | api/events/sse.int.spec.ts:436; api/events/event-filter.spec.ts:91 | int, unit | есть тест |
| C-277 | §10-2 «только кому виден» | api/events/event-filter.spec.ts:56,68,81; аудит s05 (11 пользователей × 11 событий) | unit | есть тест |
| C-278 | §10-2 «демо-часы — перезагрузка всех вкладок» | api/events/sse.int.spec.ts:457; web/live/useLiveRefresh.spec.ts:101; e2e/live-clock.spec.ts:16 | int, unit, e2e | есть тест |
| C-279 | §10-2 «экран HR без перезагрузки» | e2e/live-calendar.spec.ts:91 | e2e | есть тест |

### §11

| C | Утверждение | Тест | Тип | Статус |
|---|---|---|---|---|
| C-280 | §11 «не в объёме» (письмо backstopper, HR об отменах и т. д.) | косвенно: C-076, C-252 | — | реализация соответствует (не сделано) |

## 3. Противоречия PDF ↔ RULES (вопросы к автору)

- **П-1.** PDF-B-5: «За заданное число **дней** до начала отпуска…». RULES §8-3: «за N **рабочих** дней». Что задано в задании: календарные или рабочие дни? Если рабочие, это осознанное толкование PDF, и стоит ли его оговорить?
- **П-2.** PDF-B-6: «Отмена после начала возвращает только неиспользованные» — по формулировке это действие «отмена». RULES §5-7: «Сотрудник после начала отпуска отменить его сам не может»; единственный путь — отзыв HR с датой выхода (§5-5). Предполагает ли задание, что отмену после начала может сделать сам сотрудник (например, вернувшись раньше)? Если нет, считается ли отзыв HR полной реализацией сценария?
- **П-3.** PDF-I-4: «подтвердить или отклонить **с комментарием**». RULES §4-1 и §4-2: «комментарий необязателен». Достаточно ли возможности комментария, или PDF требует обязательный комментарий хотя бы при отклонении?
- **П-4.** Задание: «сотрудник видит, сколько дней ему полагается» и PDF-B-1 «остаток дней на сегодня». По RULES §3-10 и §4-4 одобренный отпуск в счёт будущих начислений делает «остаток на сегодня» отрицательным (F-1), а §6-4 такой минус запрещает. Что должен видеть сотрудник «на сегодня» после одобрения будущего отпуска сверх текущего остатка?
- **П-5.** PDF-R-6, R-8, R-12 и «Что мы ожидаем» п. 2–5: RULES ссылается на README (§7-4 «описать в README», §7-6 «таблицей в README», §9-6) и DECISIONS.md (шапка), а тест `seed-data.spec.ts:102` требует README. В копии их нет по условию аудита. Входят ли эти документы в сдачу, и считается ли тест, зависящий от README, частью доказуемости (PDF-R-13)?
- **П-6.** PDF-R-11: «Работает при двух одновременно открытых клиентах». RULES §10-2 и §11 ограничивают живое обновление «Календарём» и «Экраном HR»; «Мои заявки», «Заявки на согласование» и «Все заявки» во втором клиенте без перезагрузки не обновляются. Достаточно ли этого для PDF-R-11, или второй клиент должен видеть и изменения статусов заявок?

## 4. Неоднозначности RULES (вопросы к автору)

- **В-1.** §6-4 «единственный случай минуса на экране» против §3-10 (доступно на дату D = баланс сегодня + будущие начисления) и §4-4 (списание сразу, целиком). Вместе они дают отрицательный «баланс сегодня» без сдвига даты выхода (F-1, штатный пример — `e2e/vacation.spec.ts:105`: 40 дней при остатке 37,5). Что верно: (а) «доступно сегодня» не должно уходить в минус, и проверку при подаче нужно вести от баланса сегодня; (б) минус после такого одобрения допустим и §6-4 надо уточнить; (в) показывать на экране что-то иное (например, без вычета будущих отпусков)?
- **В-2.** §7-2: «HR действует только в случаях: …, **отмена и отзыв** начавшегося отпуска (§5)». В §5 у HR есть только отзыв (§5-5); отмены начавшегося отпуска HR как отдельного действия нет (код: только `recall`). Это два названия одного действия или должно быть отдельное «Отменить» для HR (например, отзыв с датой выхода = дата начала)?
- **В-3.** §8-3 «напоминание уходит, только если в момент отправки отпуск „Одобрена“» и §8-4 «если дата начала уже наступила… не отправляется» в демо-режиме: если часы перевели на дату напоминания 09:00, а затем, раньше прохода диспетчера (2 с), на дату начала или позже, напоминание получает SKIPPED и не уходит никогда (воспроизведено при первом прогоне s02). Это ожидаемое поведение демо-режима или напоминание должно уйти, раз оно было «поставлено» до начала?
- **В-4.** §9-2 и §9-3: допустимый диапазон демо-часов не задан. Нужно ли ограничение (сейчас 9999-12-31 принимается и ломает расчёт остатков, F-4; годы до 0100 отклоняются с неверным текстом)?
- **В-5.** §9-2 «служебного эндпоинта нет» без флага: требуется ли неотличимость от несуществующего маршрута и для анонимного клиента (сейчас 401 против 404, F-11), или достаточно 404 для вошедших?
- **В-6.** §9-6 «Автотесты (Playwright) используют тот же механизм подмены часов»: это то же хранилище (`ClockState`) или тот же путь через `PUT /clock` с проходом планировщика и событием `clock.changed`? От ответа зависит, является ли прямой SQL в `e2e/reset.mjs` и `live-calendar.spec.ts:114` нарушением (F-8).
- **В-7.** §7-1 «Вход: логин и пароль, JWT, пароли хешем» не говорит о защите входа: лимите попыток, неразличимости по времени, максимальной длине пароля, обязательности `exp`. Входят ли эти требования в объём (F-2, F-3, F-5, F-6)?
- **В-8.** §3-8 «Комментарий к заявке необязателен, поле для ввода есть»: есть ли ограничение длины комментария заявки и решения (сейчас до ~100 КБ, F-7)?
- **В-9.** §8-3 и §8-5 «получатели: сотрудник и его руководитель»: имеется в виду руководитель на момент постановки напоминания или на момент отправки? Код ставит текущего `managerId` при проходе и даёт новому руководителю ещё одно письмо (`reminder-scheduler.int.spec.ts:333`); уникальность §8-3 при этом «тип + отпуск + получатель» соблюдена, но «одно на каждого» для роли «руководитель» становится два.
- **В-10.** §2-6 «До даты выхода… нет остатка» и §6-5 «остаток считается по общему правилу журнала (при необходимости отрицательный)»: при сдвиге даты выхода в будущее у вошедшего сотрудника показывается −5 (`e2e/hire-date.spec.ts:27`). Верно ли, что §6-5 имеет приоритет над «нет остатка» из §2-6?
- **В-11.** §10-2 «Обновление получают только те, кому отпуск виден по §7»: кадр `vacation.cancelled` у коллег содержит `by: "HR_RECALL"`, то есть коллеги узнают, что сотрудника отозвали из отпуска (s05). Допустимо ли раскрывать коллегам способ отмены, или событие должно нести только идентификаторы без причины?
- **В-12.** §7-2 даёт правила видимости для «сотрудника (нет подчинённых)» и для «HR». У HR подчинённых нет, поэтому формально подходят оба правила: по правилу сотрудника HR видела бы коллег с тем же руководителем (daniel, olivia) и заместителя, по правилу HR — всю компанию. Код применяет правило HR. Подтвердите, что правило HR имеет приоритет.
