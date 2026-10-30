# architecture.md — архитектура сервиса «Отпуска»

> **Статус:** S1-b, версия от 2026-10-23. Документ согласован со схемой S1-a ([schema.prisma](apps/api/prisma/schema.prisma), миграция [s1_data_model](apps/api/prisma/migrations/20261023163539_s1_data_model/migration.sql)) и с [RULES.md](docs/RULES.md).
> **Источник правды по бизнес-логике:** [docs/RULES.md](docs/RULES.md). Ссылки `§N-k` читаются так же, как в тестах: `k` — порядковый номер пункта верхнего уровня в разделе `N` (вложенные пункты относятся к родителю). Всё, чего в RULES нет, помечено «проектное решение» и перечислено в [разделе 13](#13-проектные-решения-и-известные-ограничения).
> Кода в S1-b нет: документ задаёт контракт для этапов S2–S8.

## Содержание

1. [Обзор и время](#1-обзор-и-время)
2. [Модель данных](#2-модель-данных)
3. [Ограничения БД и что остаётся приложению](#3-ограничения-бд-и-что-остаётся-приложению)
4. [Модули](#4-модули)
5. [Согласующий и видимость](#5-согласующий-и-видимость)
6. [Политика блокировок](#6-политика-блокировок)
7. [Контракт API](#7-контракт-api)
8. [Каталог ошибок](#8-каталог-ошибок)
9. [События и SSE](#9-события-и-sse)
10. [Планировщик и outbox](#10-планировщик-и-outbox)
11. [Сценарии и строки БД](#11-сценарии-и-строки-бд)
12. [Стек и обоснование](#12-стек-и-обоснование)
13. [Проектные решения и известные ограничения](#13-проектные-решения-и-известные-ограничения)

---

## 1. Обзор и время

```mermaid
flowchart LR
  B[Браузер] -->|8080| W[web: nginx + React]
  W -->|"/api/* (префикс срезается)"| A[api: NestJS :3000]
  A --> P[(PostgreSQL)]
  A -->|SMTP 1025| M[Mailpit]
```

- Клиент и сервер раздельные сервисы Docker Compose (postgres, mailpit, api, web). Все порты опубликованы только на `127.0.0.1`.
- Пути API ниже даны **от корня api**. Браузер обращается к ним с префиксом `/api` (nginx срезает его). `GET /health` остаётся в корне api и вне контракта.
- `proxy_buffering off` и увеличенный `proxy_read_timeout` в nginx заданы заранее под SSE.

### Источники времени (RULES §1, §9)

| Что | Источник | Где |
|---|---|---|
| «Сегодня», начисление 1-го числа, 09:00, «в прошлом», «начался» | `Clock` + `COMPANY_TZ` | вся бизнес-логика |
| `createdAt` заявки, `decidedAt`, `cancelledAt`, `LedgerEntry.occurredAt`, `OutboxMessage.createdAt` | `Clock` (БД без DEFAULT) | сервисы |
| `OutboxMessage.nextAttemptAt`, `sentAt`, паузы повторов, опрос диспетчера | системное время БД: `now()` для выбора строк, `clock_timestamp()` для `sentAt` и `nextAttemptAt`; `new Date()` в коде нет | диспетчер outbox |
| «Сегодня» в проверке напоминания перед отправкой (§8-4) | `Clock` + `COMPANY_TZ` | диспетчер outbox |
| Срок JWT (8 ч) | системные часы | auth |
| `User.createdAt` | `now()` БД (технический) | БД |
| Календарные даты (`startDate`, `endDate`, `hireDate`, `returnDate`) | тип `DATE`, в API строка `YYYY-MM-DD` | везде |
| Моменты | `timestamptz`, в API ISO-8601 UTC | везде |

- **Clock** ([clock.ts](apps/api/src/clock/clock.ts)): `now(): Promise<Date>` (асинхронный, потому что в демо-режиме значение читается из БД); `SystemClock`, `FakeClock` (тесты), `DbClock` ([db-clock.ts](apps/api/src/clock/db-clock.ts)): читает строку `ClockState` при каждом вызове (без кэша) и при отсутствии создаёт её значением реального момента (`INSERT ... ON CONFLICT DO NOTHING`, параллельные первые вызовы дают одну строку, RULES §9-2). `DbClock` не зависит от Nest, его используют seed и `seed:demo`. Выбор реализации — в `ClockModule`: `DEMO_MODE` строго `"true"` даёт `DbClock`, иначе `SystemClock`, сохранённое значение игнорируется. «Сегодня» — `companyToday(now, tz)` от момента, который дал Clock (проектное решение S3-a, DECISIONS).
- «День» момента определяется по `COMPANY_TZ`: `2026-12-31T18:00Z` — это 1 января в Бишкеке (тест [dates.int.spec.ts](apps/api/src/db/dates.int.spec.ts)).
- Prisma возвращает `DATE` как `Date` в полночь UTC; в домене даты — строки `YYYY-MM-DD`.
- Дни в домене и журнале — целое число **половинок дня** (`halfDays`). `Vacation.workDays` — целые рабочие дни заявки, `halfDays = workDays × 2`. В API дни — число, кратное 0,5 (точно представимо в JSON).

Переменные окружения (compose): `COMPANY_TZ` (по умолчанию `Asia/Bishkek`), `REMINDER_DAYS` (3), `DEMO_MODE` (демо только при строгом `"true"`), `JWT_SECRET` (демо-значение), `DATABASE_URL`. Почта и диспетчер outbox ([раздел 10](#10-планировщик-и-outbox)): `SMTP_HOST` (`mailpit`, вне Docker `127.0.0.1`), `SMTP_PORT` (1025), `MAIL_FROM` (`Отпуска <noreply@vacation.local>`), `OUTBOX_POLL_MS` (2000), `OUTBOX_RETRY_BASE_MS` (5000), `OUTBOX_RETRY_MAX_MS` (300000).

---

## 2. Модель данных

### ER-диаграмма

```mermaid
erDiagram
    User |o--o{ User : "managerId, начальник"
    User ||--o{ Vacation : "employeeId"
    User ||--o{ Vacation : "backstopperId"
    User |o--o{ Vacation : "decidedById"
    User |o--o{ Vacation : "cancelledById"
    Vacation |o--o{ Vacation : "replacesId, перенос"
    Vacation ||--o{ LedgerEntry : "vacationId"
    LedgerEntry |o--o{ LedgerEntry : "refundOfId, возврат ссылается на списание"
    Vacation ||--o{ OutboxMessage : "vacationId"
    User ||--o{ OutboxMessage : "recipientId"

    User {
        Int id PK
        String login UK
        String email UK
        String passwordHash
        String fullName
        Date hireDate
        Int managerId FK "NULL у директора"
        String teamName "nullable"
        Boolean isHr
        Boolean accessGranted
        Timestamptz createdAt "now() БД"
    }

    Vacation {
        Int id PK
        Int employeeId FK
        Int backstopperId FK
        Date startDate
        Date endDate
        Int workDays "рабочие дни"
        VacationStatus status "PENDING по умолчанию"
        String comment "nullable"
        Int replacesId FK "nullable, исходная заявка"
        Timestamptz createdAt "Clock"
        Int decidedById FK "nullable"
        Timestamptz decidedAt "nullable, Clock"
        String decisionComment "nullable"
        Int cancelledById FK "nullable"
        Timestamptz cancelledAt "nullable, Clock"
        Date returnDate "nullable, дата выхода при отзыве"
    }

    LedgerEntry {
        Int id PK
        LedgerKind kind "DEBIT или REFUND"
        Int vacationId FK
        Int refundOfId FK "nullable, только REFUND"
        Int halfDays "половинки дня"
        Timestamptz occurredAt "Clock"
    }

    OutboxMessage {
        Int id PK
        MailType type "NEW_REQUEST, DECISION, REMINDER"
        Int vacationId FK
        Int recipientId FK
        MailStatus status "PENDING, SENT, SKIPPED"
        String subject
        String body
        Int attempts
        Timestamptz nextAttemptAt "системные часы"
        Timestamptz sentAt "nullable"
        String lastError "nullable"
        Timestamptz createdAt "Clock"
    }

    ClockState {
        Int id PK "всегда 1"
        Timestamptz instant "демо-часы"
        Timestamptz updatedAt
    }
```

Перечисления: `VacationStatus` = `PENDING` («На согласовании»), `APPROVED` («Одобрена»), `REJECTED` («Отклонена»), `CANCELLED` («Отменена»), `REPLACED` («Заменена переносом»); `LedgerKind` = `DEBIT`, `REFUND`; `MailType` = `NEW_REQUEST`, `DECISION`, `REMINDER`; `MailStatus` = `PENDING`, `SENT`, `SKIPPED` (напоминание, ставшее неактуальным к моменту отправки, §8-3).

### Таблицы

**User** — сотрудник и учётная запись.

| Поле | Смысл | RULES |
|---|---|---|
| `login`, `email` (UNIQUE) | вход и адрес письма; seed: `<login>@vacation.local` | §7-1, §8 |
| `passwordHash` | хеш пароля | §7-1 |
| `hireDate` | дата выхода; от неё считаются начисления; меняет только HR | §2, §6-1 |
| `managerId` | непосредственный руководитель; `NULL` только у директора | §4-1, §4-2 |
| `teamName` | «Фронт-отдел» / «Бэк-отдел»; у остальных `NULL`; задаёт seed | §7-6 |
| `isHr` | флаг HR; роли «руководитель» и «сотрудник» вычисляются из структуры | §7-1 |
| `accessGranted` | «доступ получен»: ставится при первом успешном входе, никогда не снимается | §6-7 |

**Выбор `teamName` вместо таблицы `Team`:** профиль показывает только название команды без списка членов, состав команд задаёт только seed (§7-3, §7-6), справочник команд не нужен.

**Vacation** — заявка и отпуск (одна сущность).

| Поле | Смысл | RULES |
|---|---|---|
| `employeeId`, `backstopperId` | сотрудник и заменяющий; заменяющий не равен сотруднику | §3-3 |
| `startDate`, `endDate`, `workDays` | период и число рабочих дней (≥ 1, один календарный год) | §3-4 |
| `status` | см. перечисление | §3-11 |
| `comment` | необязателен; обязателен для начала «в прошлом» | §3-7, §3-8 |
| `replacesId` | заявка-перенос ссылается на исходную; цепочка A→B→C | §5-2, §5-12 |
| `decidedById/At`, `decisionComment` | кто и когда решил (для директора — HR) | §4 |
| `cancelledById/At`, `returnDate` | отмена; дата выхода при отзыве | §5-4, §5-5, §5-11 |

**LedgerEntry** — журнал: только списания и возвраты. Начисления и обрезки 15 дней на 1 января **вычисляются** из `hireDate` (§6-6).

| Поле | Смысл |
|---|---|
| `kind = DEBIT` | списание при окончательном согласовании; `halfDays > 0`; без `refundOfId`; одно на заявку |
| `kind = REFUND` | возврат при отмене или отзыве; `halfDays ≥ 0` (0 допустим при выходе в выходной); `refundOfId` — **списание корня цепочки**; один на заявку |
| `vacationId` | заявка, чьё действие породило запись (для возврата — отменённое звено цепочки) |
| `occurredAt` | момент по Clock; определяет порядок относительно обрезки 1 января (§6-6) |

**OutboxMessage** — очередь писем. Ключ уникальности `(type, vacationId, recipientId)` (§8-3). `nextAttemptAt` и `sentAt` по системным часам, `createdAt` по Clock.

**ClockState** — одна строка (`id = 1`): демо-часы, общие для api, планировщика и `seed:demo` (§9-2).

### Производные величины (в БД не хранятся)

| Что | Как получается |
|---|---|
| Баланс сегодня | свёртка: начисления до сегодня включительно (из `hireDate`), обрезки 1 января, все `DEBIT` и `REFUND`; порядок дня: начисление, обрезка, действия (§6-6) |
| «Доступно на D» | баланс сегодня + начисления и обрезки строго после сегодня и до D включительно (§3-10) |
| Роль «руководитель» | у пользователя есть подчинённые (`managerId = его id`) |
| Директор | `managerId IS NULL` |
| «Перенос на рассмотрении» у отпуска | отпуск `APPROVED` и существует заявка с `replacesId = его id` в статусе `PENDING` (§3-11) |
| «Старый отпуск остаётся» у заявки-переноса | `replacesId IS NOT NULL` и статус `REJECTED` или `CANCELLED` (§3-11) |
| Корень цепочки | заявка без `replacesId`, достижимая по `replacesId` (§5-12) |
| Дата напоминания | N-й рабочий день назад от `startDate` (§8-3) |

---

## 3. Ограничения БД и что остаётся приложению

### Что гарантирует БД

Имена ограничений используются в [constraints.int.spec.ts](apps/api/src/db/constraints.int.spec.ts); их наличие проверяет [migration.int.spec.ts](apps/api/src/db/migration.int.spec.ts); дрейф миграции от схемы ловит `db:drift` в CI.

| Ограничение | Правило | RULES | Тест |
|---|---|---|---|
| `User_single_root_idx` (partial UNIQUE) | не больше одного пользователя без начальника | §4-2 | второй пользователь без начальника не проходит |
| `User_not_own_manager_chk` | не собственный начальник | §4-1 | пользователь не может быть собственным начальником |
| `Vacation_dates_order_chk` | начало ≤ конца | §3-4 | начало позже конца не проходит |
| `Vacation_one_year_chk` | один календарный год | §3-4 | заявка через Новый год не проходит |
| `Vacation_work_days_chk` | `workDays ≥ 1` | §3-4 | заявка без рабочих дней не проходит |
| `Vacation_backstopper_not_self_chk` | заменяющий не заявитель | §3-3 | сам себе backstopper не проходит |
| `Vacation_not_replaces_self_chk` | заявка не заменяет саму себя | §5-12 | — (прямого теста нет) |
| `Vacation_no_approved_overlap_excl` (EXCLUDE gist) | нет пересечения `APPROVED` одного сотрудника | §3-4, §5-2 | пересекающиеся одобренные отпуска не проходят |
| `Vacation_single_live_successor_idx` (partial UNIQUE) | у отпуска один действующий преемник (`PENDING` или `APPROVED`) | §5-2 | второй ожидающий перенос не проходит |
| `LedgerEntry_kind_shape_chk` | форма записи: списание без ссылки и `> 0`, возврат со ссылкой и `≥ 0` | §6-6, §6-8 | списание с нулём; возврат без ссылки |
| `LedgerEntry_one_debit_per_vacation_idx` | одно списание на заявку | §10-1 | второе списание по той же заявке не проходит |
| `LedgerEntry_one_refund_per_vacation_idx` | один возврат на заявку | §6-8, §10-1 | повторный возврат по той же заявке не создаётся |
| триггер `LedgerEntry_refund_guard` (функция `ledger_refund_guard`) | возврат ссылается на списание **корня** цепочки своей заявки; сумма возвратов ≤ списанного; `FOR UPDATE` на списание сериализует параллельные возвраты | §5-12, §6-8 | возврат сверх списанного отклоняется; возврат к списанию промежуточного звена или чужой цепочки отклоняется; два параллельных возврата по одному списанию: проходит один |
| `OutboxMessage_type_vacationId_recipientId_key` | одно письмо на «тип + отпуск + получатель» | §8-3 | дубль письма «тип + отпуск + получатель» не проходит |
| `OutboxMessage_attempts_chk` | `attempts ≥ 0` | §8 | — |
| `ClockState_single_row_chk` | `id = 1` | §9-2 | состояние демо-часов — одна строка |
| внешние ключи `ON DELETE RESTRICT` | записи не удаляются каскадом | — | — |

Порядок утверждения переноса важен для `EXCLUDE`: в одной транзакции сначала старый отпуск `APPROVED → REPLACED`, затем новый `PENDING → APPROVED` (обратный порядок БД отклоняет, тест «обратный порядок утверждения»).

### Что БД не гарантирует и делает приложение

| Правило | RULES | Где проверяется |
|---|---|---|
| «Хотя бы один» пользователь без начальника | §4-2 | seed и тест (S3) |
| Пересечение заявок в статусе `PENDING` (с любой активной, кроме переносимого отпуска) | §3-4, §5-2 | `vacations`, под блокировкой сотрудника |
| Достаточность остатка при подаче и при согласовании | §3-9, §4-3 | `balance` + `vacations`/`approvals`, под блокировкой |
| `workDays` и `endDate` соответствуют датам (рабочие дни пн–пт) | §1 | `vacations`, чистая функция S2 |
| «В прошлом»: начало в текущем году, комментарий обязателен | §3-7 | `vacations` |
| Подача до первого начисления | §3-6 | `vacations` |
| Перенос: то же число рабочих дней, начало не раньше сегодня, только до начала, исходная `APPROVED` | §5-1, §5-2 | `vacations` |
| Статус и журнал согласованы (`APPROVED` ⇔ есть списание, отмена ⇒ возврат) | §6-6 | сервисные транзакции |
| Отзыв: `returnDate` между началом и окончанием включительно, `halfDays` возврата | §5-5, §5-6, §5-11 | `vacations` |
| Старый отпуск нельзя отменить/отозвать/перенести, пока перенос `PENDING` | §5-2, §5-3 | `vacations` |
| `replacesId` пишется один раз при создании и не меняется | §5-12 | приложение (в БД нет запрета; от этого зависит чтение цепочки до блокировки, [раздел 6](#6-политика-блокировок)) |
| Кто может действовать (согласующий, HR, владелец) | §4, §5, §7 | guards, `approverOf`, `visibleTo` |
| Состав получателей писем и отсутствие писем при отмене | §8 | `mail` |
| Проверка статуса `APPROVED` в момент отправки напоминания | §8-3 | диспетчер outbox |

---

## 4. Модули

```mermaid
flowchart TD
  auth --> org
  auth --> clock
  org --> clock
  balance --> clock
  vacations --> balance
  vacations --> org
  vacations --> mail
  vacations --> events
  approvals --> vacations
  approvals --> balance
  approvals --> org
  calendar --> org
  calendar --> balance
  hr --> org
  hr --> balance
  hr --> events
  events --> org
  scheduler --> mail
  scheduler --> balance
  scheduler --> org
  scheduler --> clock
  mail --> clock
```

Слой **домена** (S2) — чистые функции без БД и Nest: рабочие дни, начисление, обрезка, свёртка журнала, «доступно на D», дни возврата, дата напоминания, проверки формы заявки. Модули ниже вызывают домен и работают с БД.

| Модуль | Ответственность | Владеет таблицами | Публичный интерфейс | Этап |
|---|---|---|---|---|
| **clock** | единственный источник «сейчас»; демо-часы в БД; установка часов | `ClockState` | `await Clock.now()`, `DbClock.set(instant)`, `companyToday(now, tz): YYYY-MM-DD` по `COMPANY_TZ` | S0, S3 |
| **auth** | вход по логину и паролю, JWT (8 ч, системные часы), guard, признак `accessGranted` | — (читает/пишет `User`) | `login()`, `JwtGuard`, `@Roles()` | S3 |
| **org** | структура: руководитель, подчинённые, роли, `approverOf`, `visibleTo`, справочник, дата выхода | `User` | `rolesOf(user)`, `approverOf(employee)`, `visibleTo(viewer)`, `calendarScope(viewer)`, `canSee(viewer, employeeId)`, `directory()`, `roster()`, `setHireDate(id, date)` | S3, S6c |
| **balance** | журнал и баланс: чтение свёртки, запись списания и возврата | `LedgerEntry` | `balanceToday(employee)`, `availableOn(employee, D)`, `debit(tx, vacation)`, `refund(tx, vacation, halfDays)` | S2, S4–S6 |
| **vacations** | подача, статусы, отмена, отзыв, перенос, списки по видимости | `Vacation` | `submit()`, `cancel()`, `recall()`, `submitTransfer()`, `list(viewer)`, `get(viewer, id)` | S4, S6 |
| **approvals** | экран и решение согласующего, повторная проверка остатка, предупреждения о пересечениях | — | `pending(approver)`, `approve()`, `reject()`, `overlapWarnings()` | S5 |
| **mail/outbox** | постановка писем в очередь в транзакции, диспетчер отправки и повторов | `OutboxMessage` | `enqueue(tx, message)`, `Dispatcher` (по системным часам) | S4 |
| **scheduler** | напоминания: идемпотентный проход по Clock, создаёт только строки outbox | — | `ReminderScheduler.pass()`, `ReminderWorker` (старт, раз в минуту), `AFTER_CLOCK_SET` | S7 |
| **calendar** | read-model календаря: только `APPROVED`, по `calendarScope` | — | `calendar(viewer, from, to)` | S5 |
| **hr** | экран HR «Остатки по сотрудникам» и смена даты выхода; таблицу `User` пишет через `org` | — | `balances(viewer)`, `changeHireDate(viewer, id, date)` | S6c |
| **events** | шина доменных событий и SSE-эндпоинт | — | `publish(event)`, `GET /events` | контракт S1; шина S5; SSE S8 |

Правила взаимодействия:

- Сервисная операция выполняется в **одной транзакции**: смена статуса, запись журнала, строки outbox. `TxHook` `onVacationApproved(tx, vacation)` вызывается внутри транзакции одобрения и утверждения переноса: он создаёт письмо о решении (S5) и при позднем одобрении немедленное напоминание (S7).
- События шины публикуются **после коммита** (`publish` вне транзакции). Потеря события при падении процесса допустима (известное ограничение).
- Модули не обращаются к таблицам друг друга напрямую, только через интерфейсы. Исключение: чтение через общий `PrismaService` внутри одной транзакции.
- **`seed:demo`** ([seed-demo.ts](apps/api/src/seed-demo.ts), S5-c) — отдельный процесс, как seed. Сервисы `VacationsService` и `ApprovalsService` собираются вручную, без Nest. `OutboxWorker` в этом процессе не поднимается: письма только ставятся в outbox, доставляет их воркер api. Заявки подаются и решаются от имени автора и согласующего без входа, поэтому команда работает только при `DEMO_MODE=true`. Даты считаются от `DbClock`. Сценарий узнаётся по автору и метке «Демо-заявка (seed:demo)» в комментарии заявки, поэтому повторный и параллельный запуски ничего не дублируют. Сценарий, который отклонила проверка, пропускается, код выхода 1. Сценарии описаны в [seed-demo-data.ts](apps/api/src/seed-demo-data.ts).

---

## 5. Согласующий и видимость

### Роли

| Роль | Признак |
|---|---|
| HR | `isHr` |
| Руководитель | есть прямые подчинённые |
| Сотрудник | остальные |
| Директор | `managerId IS NULL` (обычный руководитель; его заявки согласует HR) |

Каждый пользователь, включая руководителя и HR, подаёт заявки **как сотрудник**. HR в системе один (инвариант проверяет seed, как для директора).

### Согласующий (RULES §4-1, §4-2)

```text
approverOf(employee) = employee.managerId != null ? manager(employee) : HR
```

- Заявка сотрудника, руководителя, заместителя и HR: непосредственный руководитель (заявки HR согласует заместитель директора).
- Заявка директора: HR («допуск HR»). То же для заявки-переноса.
- Действие согласующего выполняет только `approverOf(vacation.employee)` и никогда сам автор заявки (`canDecide`, [policy.ts](apps/api/src/org/policy.ts)). Автор, вызвавший решение по своей заявке, получает `403 APPROVE_OWN_REQUEST` при любой роли (руководитель, заместитель, HR); любой другой пользователь, которому заявка видна, — `403 NOT_APPROVER`; кому не видна — `404` (DECISIONS [S5]).
- Письмо о новой заявке уходит `approverOf(employee)`; письмо о решении — `employee` (§8-2).

### Предупреждение о пересечениях (RULES §4-6; DECISIONS 2026-10-22)

Набор сотрудников: `owner = employee.managerId ?? employee.id`, `team = {owner} ∪ прямые подчинённые owner`. Берутся только отпуска `APPROVED` на пересекающиеся даты (кроме самой заявки и заменяемого переносом отпуска). Согласование не блокируется.

### `visibleTo(viewer)` — единая функция для REST и SSE (RULES §7-2)

```text
scope(viewer) =
  viewer.isHr                 ->  ALL                      (все сотрудники)
  viewer имеет подчинённых    ->  { viewer } ∪ direct(viewer)
  иначе                       ->  { viewer }

canSee(viewer, employeeId) = employeeId ∈ scope(viewer)

calendarScope(viewer) =       (только календарь и его SSE-события; S6-audit, DECISIONS 2026-10-29 09:01)
  viewer.isHr                 ->  ALL
  viewer имеет подчинённых    ->  scope(viewer)
  иначе                       ->  { viewer } ∪ direct(viewer.managerId) ∪ { viewer.managerId }
```

`calendarScope` шире `scope` только у сотрудника без подчинённых: коллеги с тем же руководителем и сам руководитель. Заявки, карточки и остатки коллег по-прежнему решает `scope`.

Команда руководителя — только прямые подчинённые, вложенные не входят (§7-3). Заместитель директора видит себя и своих подчинённых; директор — себя и заместителя.

| Ресурс | Кто видит | Фильтр |
|---|---|---|
| Заявки (список, карточка) | сотрудник свои; руководитель свои и прямых подчинённых; HR все (чтение, все статусы) | `canSee(viewer, vacation.employeeId)`; иначе `404` |
| Заявки на согласование | `approverOf(employee) = viewer`, статус `PENDING` | HR видит здесь только заявки директора |
| Календарь | сотрудник себя, коллег с тем же руководителем и руководителя; руководитель подчинённых и себя; HR всех; **только `APPROVED`**; на странице два блока: свои сверху, остальные снизу | `calendarScope` + `status = APPROVED` |
| Остаток | свой; руководитель — подчинённых; HR — всех | `canSee` |
| Профиль | только свой | `/me` |
| Справочник | любой вошедший: `id` + имя, без самого себя | — |
| Заявка, где я backstopper | **не видна**: роль заменяющего прав на просмотр не даёт | только `canSee` по сотруднику заявки |
| SSE-событие | `vacation.*` — зрителю, для которого `event.employeeId ∈ calendarScope(viewer)`; `employee.hire-date-changed` — по `canSee` (сам, руководитель, HR; коллеги нет); `clock.changed` (демо-режим) — всем вошедшим (S8, DECISIONS 2026-10-29 15:09, 21:18) | `deliver(event, viewerId, org)` ([event-filter.ts](apps/api/src/events/event-filter.ts)) на сервере |

`scope(viewer)` вычисляется на каждый запрос и каждое событие по актуальной структуре; в JWT только `sub` (проектное решение).

---

## 6. Политика блокировок

Цель: RULES §10-1 — проверка пересечений и остатка и смена статуса атомарны, из двух параллельных запросов проходит один, письмо и списание ровно одни.

**Единый порядок захвата:** `User` (сотрудник, чья заявка) → `Vacation` по **возрастанию id** → строка списания `LedgerEntry`. Ни одна транзакция не берёт более одной строки `User`, поэтому порядок между сотрудниками не нужен.

**Режим блокировки `User` и `Vacation` — `FOR NO KEY UPDATE`, не `FOR UPDATE`.** Вставка заявки проверяет внешние ключи и берёт `FOR KEY SHARE` на строки `employee`, `backstopper`, `decidedBy`. `FOR UPDATE` конфликтует с ним: если Иван указал Марию заменяющей, а Мария Ивана, их одновременные подачи блокируют друг друга (проверено на Postgres: `40P01 deadlock detected`). `FOR NO KEY UPDATE` с `KEY SHARE` не конфликтует, а два запроса на одного сотрудника по-прежнему выстраиваются в очередь.

Все записи журнала по сотруднику идут под его строкой `User`, поэтому остаток читается внутри блокировки без гонок.

| Операция | Блокировки (по порядку) | Записи в той же транзакции |
|---|---|---|
| Подача заявки | `User(employee)` | проверка пересечений `PENDING`/`APPROVED` и остатка; `Vacation`; `OutboxMessage(NEW_REQUEST)` |
| Подача переноса | `User(employee)` → `Vacation(исходная)` | проверки §5-2; `Vacation(replacesId)`; `OutboxMessage(NEW_REQUEST)` |
| Согласование/отклонение | `User(employee)` → `Vacation` по id: для переноса `{replacesId, id}` | повторная проверка статуса («уже обработана»); для обычной — остаток, `status`, `DEBIT`; для переноса — порядок: старый `REPLACED`, затем новый `APPROVED`; `OutboxMessage(DECISION)`; хук |
| Отмена сотрудником `APPROVED` | `User(employee)` → вся цепочка по возрастанию id → списание (триггер) | `status = CANCELLED`, `REFUND(refundOfId = списание корня)` |
| Отмена `PENDING`, отмена переноса | `User(employee)` → `Vacation` | `status = CANCELLED`; возврата нет |
| Отзыв HR | `User(employee)` → вся цепочка по id → списание (триггер) | `status = CANCELLED`, `returnDate`, `REFUND` |
| Смена даты выхода | `User(employee)` | `hireDate`; журнал не трогается |
| Диспетчер outbox | `OutboxMessage ... FOR UPDATE OF o SKIP LOCKED` (строки `User` и `Vacation` из join не блокируются) | `status`, `attempts`, `lastError`, `nextAttemptAt`, `sentAt` |
| Планировщик | нет блокировок сущностей | `INSERT ... ON CONFLICT DO NOTHING` |

Правила:

1. **Цепочка читается до блокировки.** `replacesId` пишется один раз при создании ([раздел 3](#что-бд-не-гарантирует-и-делает-приложение)), поэтому набор звеньев можно прочитать без блокировки, затем захватить звенья по возрастанию id (звено-преемник всегда создаётся позже предшественника, его id больше) и перечитать статусы.
2. **После захвата всё перечитывается**: статус заявки, наличие преемника в `PENDING`, баланс. Если статус уже не допускает действия, ответ `409 ALREADY_PROCESSED`.
3. **Триггер возврата** берёт `FOR UPDATE` на списание корня последним — это продолжение того же порядка, взаимных блокировок нет (на списание ссылаются только записи той же цепочки, то есть того же сотрудника).
4. **Все вставки в outbox** идут с `ON CONFLICT DO NOTHING`, а несколько строк одной операции вставляются одним запросом по возрастанию `recipientId`. Это исключает и дубль письма, и взаимную блокировку по уникальному ключу между транзакцией одобрения и проходом планировщика (оба могут вставить `REMINDER` по одному отпуску).
5. **Нарушение ограничений БД** как последняя линия: `23P01` (EXCLUDE) → `VACATION_OVERLAP`; `23505` на `Vacation_single_live_successor_idx` → `TRANSFER_ALREADY_PENDING`; `23505` на списании/возврате → `ALREADY_PROCESSED`; `23514` триггера → внутренняя ошибка (баг приложения).
6. Остаточная гонка: диспетчер проверяет статус `APPROVED` перед отправкой без блокировки отпуска; отмена, пришедшая между проверкой и отправкой, не остановит уже отправляемое письмо (описано в [разделе 13](#13-проектные-решения-и-известные-ограничения)).

---

## 7. Контракт API

Базовые соглашения:

- Авторизация: заголовок `Authorization: Bearer <JWT>`. Токен нигде, кроме заголовка, не передаётся (в URL нет).
- Даты — `YYYY-MM-DD`, моменты — ISO-8601 UTC, дни — число, кратное 0,5 (остаток может быть отрицательным: после одобрения отпуска в счёт будущих начислений, сдвига даты выхода на более позднюю, отката демо-часов, §6-4).
- «Сегодня» и все расчёты даёт сервер (по Clock); браузер своё время не используется.
- Ошибки — единый формат `Problem` ([раздел 8](#8-каталог-ошибок)).
- Списки без постраничной разбивки (объём демо).
- Календарная дата во входе (тело, query `on`, с S9 и `date` в `PUT /clock`) принимается только в формате `YYYY-MM-DD`, существующая, с годом от 2000 до 2100; иначе `400 VALIDATION_FAILED` с `details.fields` (проектное решение S4, остаток F-4 аудита S2; для часов — аудит 3, F-4).

### Доступ по маршрутам

«Любой» — любой вошедший пользователь. «Согласующий» — `approverOf(employee)`. «Владелец» — сотрудник заявки.

| Маршрут | Доступ | RULES | Этап |
|---|---|---|---|
| `POST /auth/login` | публичный | §7-1, §6-7 | S3 |
| `GET /config` | публичный | §9-2 | S3 |
| `GET /me` | любой | §7-2 | S3 |
| `GET /clock`, `PUT /clock` | любой вошедший, **только при `DEMO_MODE`**, иначе `404` (в том числе без токена) | §9-2, §9-3 | S3, S9 |
| `GET /employees` | любой | §3-3 | S4 |
| `GET /me/balance` | любой | §3-10, §7-2 | S4 |
| `POST /vacations` | любой, у кого уже есть начисление | §3, §10-1 | S4 |
| `GET /vacations` | любой (`mine`); руководитель (`team`); HR (`all`) | §7-2 | S4 |
| `GET /vacations/{id}` | видимость `canSee` | §7-2 | S4 |
| `GET /approvals` | руководитель, HR | §4-7 | S5 |
| `POST /vacations/{id}/approve`, `.../reject` | согласующий | §4-1, §4-2 | S5 |
| `POST /vacations/{id}/cancel` | владелец (в том числе HR над своим), до начала | §5-4, §5-7, §5-10 | S6a |
| `POST /vacations/{id}/recall` | HR (в том числе над своим), пока отпуск идёт | §5-5, §5-11 | S6a |
| `POST /vacations/{id}/transfer` | владелец, до начала | §5-1, §5-2 | S6 |
| `GET /hr/balances` | HR | §7-2 | S6c |
| `PATCH /employees/{id}/hire-date` | HR (в том числе себе) | §6-1 | S6c |
| `GET /calendar` | любой (по `calendarScope`) | §7-2 | S5, S6-audit |
| `GET /events` | любой (SSE; события по `calendarScope`/`canSee`, [раздел 9](#9-события-и-sse)) | §7-1, §7-2, §10-2 | S8 |

### OpenAPI

```yaml
openapi: 3.0.3
info:
  title: Отпуска
  version: "1.0"
  description: Контракт API сервиса. Пути даны от корня api (браузер добавляет префикс /api).
servers:
  - url: /
security:
  - bearerAuth: []
tags:
  - { name: auth }
  - { name: balance }
  - { name: vacations }
  - { name: approvals }
  - { name: hr }
  - { name: calendar }
  - { name: events }
  - { name: demo-clock }
paths:
  /auth/login:
    post:
      tags: [auth]
      security: []
      summary: Вход по логину и паролю
      description: >
        Сначала проверяются логин и пароль, затем дата выхода по Clock:
        без признака accessGranted и при hireDate позже сегодняшней даты вход запрещён.
        При успехе ставится accessGranted = true.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [login, password]
              properties:
                login: { type: string }
                password: { type: string }
      responses:
        "200":
          description: Токен на 8 часов (системные часы)
          content:
            application/json:
              schema:
                type: object
                required: [accessToken, expiresAt]
                properties:
                  accessToken: { type: string }
                  expiresAt: { type: string, format: date-time }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED (пустой логин или пароль)
        "401": { $ref: "#/components/responses/Problem" }   # AUTH_INVALID_CREDENTIALS
        "403": { $ref: "#/components/responses/Problem" }   # AUTH_NOT_HIRED_YET
  /config:
    get:
      tags: [demo-clock]
      security: []
      summary: Публичная конфигурация
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [demoMode, companyTz]
                properties:
                  demoMode: { type: boolean }
                  companyTz: { type: string, example: Asia/Bishkek }
  /clock:
    get:
      tags: [demo-clock]
      summary: Текущее значение часов (только DEMO_MODE=true, иначе 404)
      responses:
        "200": { $ref: "#/components/responses/Clock" }
        "401": { $ref: "#/components/responses/Problem" }   # AUTH_REQUIRED, AUTH_TOKEN_EXPIRED (только при DEMO_MODE; без флага 404 раньше проверки токена)
        "404": { $ref: "#/components/responses/Problem" }
    put:
      tags: [demo-clock]
      summary: Установить демо-часы (только DEMO_MODE=true, иначе 404)
      description: >
        Дата и время передаются в часовом поясе компании (COMPANY_TZ), сервер сам переводит их в момент UTC
        (браузер часовыми поясами не занимается; форма подставляет время 09:00 по умолчанию, RULES §9-3).
        После установки часов синхронно, до ответа, выполняется проход планировщика (RULES §9-4): `AFTER_CLOCK_SET` из `SchedulerModule`.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [date, time]
              properties:
                date: { type: string, format: date, example: "2026-10-21" }
                time: { type: string, pattern: '^([01]\d|2[0-3]):[0-5]\d$', example: "09:00" }
      responses:
        "200": { $ref: "#/components/responses/Clock" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED (формат даты или времени, несуществующая дата, год вне 2000–2100, несуществующее время в поясе компании)
        "401": { $ref: "#/components/responses/Problem" }   # AUTH_REQUIRED, AUTH_TOKEN_EXPIRED (только при DEMO_MODE; без флага 404 раньше проверки токена)
        "404": { $ref: "#/components/responses/Problem" }
  /me:
    get:
      tags: [auth]
      summary: Профиль (только чтение)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Profile" }
        "401": { $ref: "#/components/responses/Problem" }
  /employees:
    get:
      tags: [vacations]
      summary: Справочник «id + имя» для выбора backstopper (без самого вошедшего)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/EmployeeRef" }
  /me/balance:
    get:
      tags: [balance]
      summary: Остаток на сегодня и, если задан on, «доступно на дату»
      parameters:
        - { name: on, in: query, required: false, schema: { type: string, format: date } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Balance" }
  /vacations:
    post:
      tags: [vacations]
      summary: Подать заявку
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/VacationInput" }
      responses:
        "201":
          description: Заявка создана (PENDING), согласующему поставлено письмо
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED (в том числе comment длиннее 400)
        "422": { $ref: "#/components/responses/Problem" }   # правила §3 (раздел 8)
    get:
      tags: [vacations]
      summary: Список заявок по видимости
      parameters:
        - name: scope
          in: query
          schema: { type: string, enum: [mine, team, all], default: mine }
          description: mine - свои; team - прямые подчинённые (руководитель); all - вся компания (HR, чтение)
        - name: status
          in: query
          schema: { type: array, items: { $ref: "#/components/schemas/VacationStatus" } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/Vacation" }
        "403": { $ref: "#/components/responses/Problem" }
  /vacations/{id}:
    get:
      tags: [vacations]
      summary: Карточка заявки (невидимая - 404)
      parameters:
        - { $ref: "#/components/parameters/Id" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "404": { $ref: "#/components/responses/Problem" }
  /vacations/{id}/cancel:
    post:
      tags: [vacations]
      summary: Отмена владельцем до начала (APPROVED или PENDING; заявка-перенос в PENDING)
      description: Письма нет. Для APPROVED дни возвращаются полностью. Отмена переноса оставляет старый отпуск APPROVED.
      parameters:
        - { $ref: "#/components/parameters/Id" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: тело пустое, любое поле - ошибка
        "403": { $ref: "#/components/responses/Problem" }   # FORBIDDEN, CANCEL_STARTED_BY_EMPLOYEE
        "404": { $ref: "#/components/responses/Problem" }
        "409": { $ref: "#/components/responses/Problem" }   # ALREADY_PROCESSED, PENDING_TRANSFER_BLOCKS
        "422": { $ref: "#/components/responses/Problem" }   # CANCEL_PENDING_AFTER_START
  /vacations/{id}/recall:
    post:
      tags: [hr]
      summary: Отзыв из идущего отпуска (HR, в том числе из своего)
      description: Единственное действие HR над отпуском; только пока начало ≤ сегодня ≤ окончание; письма нет; возвращаются рабочие дни с даты выхода по конец отпуска.
      parameters:
        - { $ref: "#/components/parameters/Id" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [returnDate]
              properties:
                returnDate: { type: string, format: date }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: нет returnDate, неверная дата, лишнее поле
        "403": { $ref: "#/components/responses/Problem" }   # FORBIDDEN (не HR)
        "404": { $ref: "#/components/responses/Problem" }
        "409": { $ref: "#/components/responses/Problem" }   # ALREADY_PROCESSED, PENDING_TRANSFER_BLOCKS
        "422": { $ref: "#/components/responses/Problem" }   # RECALL_NOT_APPROVED, RECALL_NOT_STARTED, RECALL_FINISHED, RECALL_DATE_OUT_OF_RANGE
  /vacations/{id}/transfer:
    post:
      tags: [vacations]
      summary: Перенести одобренный отпуск (новая заявка с replacesId)
      parameters:
        - { $ref: "#/components/parameters/Id" }
      description: >
        Остаток не проверяется; рабочие дни те же, что у исходного отпуска; начало не раньше сегодня.
        Письмо NEW_REQUEST согласующему как о новой заявке (для директора HR). Порядок проверок - раздел 8.
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/VacationInput" }
      responses:
        "201":
          description: Создана заявка-перенос (PENDING)
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: неверная дата, лишнее поле (в том числе workDays), comment длиннее 400
        "403": { $ref: "#/components/responses/Problem" }   # FORBIDDEN (не владелец)
        "404": { $ref: "#/components/responses/Problem" }
        "409": { $ref: "#/components/responses/Problem" }   # ALREADY_PROCESSED (исходный CANCELLED/REPLACED), TRANSFER_ALREADY_PENDING
        "422": { $ref: "#/components/responses/Problem" }   # TRANSFER_SOURCE_NOT_APPROVED, TRANSFER_STARTED, BACKSTOPPER_*, VACATION_DATES_ORDER, VACATION_CROSSES_YEAR, VACATION_NO_WORK_DAYS, TRANSFER_START_IN_PAST, TRANSFER_WORKDAYS_MISMATCH, VACATION_OVERLAP
  /approvals:
    get:
      tags: [approvals]
      summary: Заявки и переносы на согласование (approverOf = я, статус PENDING)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/ApprovalItem" }
        "403": { $ref: "#/components/responses/Problem" }
  /vacations/{id}/approve:
    post:
      tags: [approvals]
      summary: Согласовать
      description: >
        Обычная заявка: повторная проверка остатка, статус APPROVED, списание, письмо о решении.
        Заявка после даты начала согласуется задним числом (RULES §4-5); отклонить можно в любом случае.
        Перенос: остаток не проверяется, старый отпуск REPLACED, новый APPROVED, баланс не меняется;
        после начала старого отпуска перенос согласовать нельзя.
      parameters:
        - { $ref: "#/components/parameters/Id" }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Decision" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: лишнее поле, comment не строка или длиннее 400
        "403": { $ref: "#/components/responses/Problem" }   # NOT_APPROVER, APPROVE_OWN_REQUEST
        "404": { $ref: "#/components/responses/Problem" }
        "409": { $ref: "#/components/responses/Problem" }   # ALREADY_PROCESSED
        "422": { $ref: "#/components/responses/Problem" }   # APPROVE_INSUFFICIENT_BALANCE, TRANSFER_APPROVE_AFTER_START
  /vacations/{id}/reject:
    post:
      tags: [approvals]
      summary: Отклонить (разрешено всегда, пока заявка PENDING)
      parameters:
        - { $ref: "#/components/parameters/Id" }
      requestBody:
        required: false
        content:
          application/json:
            schema: { $ref: "#/components/schemas/Decision" }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Vacation" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: лишнее поле, comment не строка или длиннее 400
        "403": { $ref: "#/components/responses/Problem" }
        "404": { $ref: "#/components/responses/Problem" }
        "409": { $ref: "#/components/responses/Problem" }
  /hr/balances:
    get:
      tags: [hr]
      summary: Остатки по сотрудникам (экран HR)
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/HrBalanceRow" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: лишний параметр query
        "403": { $ref: "#/components/responses/Problem" }   # FORBIDDEN (не HR)
  /employees/{id}/hire-date:
    patch:
      tags: [hr]
      summary: Сменить дату выхода (HR; в любую сторону; журнал не меняется; письма нет)
      parameters:
        - { $ref: "#/components/parameters/Id" }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [hireDate]
              properties:
                hireDate: { type: string, format: date }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/HrBalanceRow" }
        "400": { $ref: "#/components/responses/Problem" }   # VALIDATION_FAILED: нет hireDate, неверная дата, год вне 2000–2100, лишнее поле
        "403": { $ref: "#/components/responses/Problem" }   # FORBIDDEN (сотрудник виден, но не HR)
        "404": { $ref: "#/components/responses/Problem" }   # NOT_FOUND (некорректный, несуществующий или невидимый id)
  /calendar:
    get:
      tags: [calendar]
      summary: Календарь (только APPROVED, по scope зрителя)
      parameters:
        - { name: from, in: query, required: true, schema: { type: string, format: date } }
        - { name: to, in: query, required: true, schema: { type: string, format: date } }
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Calendar" }
  /events:
    get:
      tags: [events]
      summary: Поток событий (SSE, fetch-stream с заголовком Authorization)
      description: >-
        Формат событий и фильтр по видимости - раздел 9 architecture.md. Токен только в заголовке:
        без него, с недействительным или в URL - 401 AUTH_REQUIRED, истёкший - 401 AUTH_TOKEN_EXPIRED;
        поток не открывается. Сервер закрывает поток в момент exp токена.
      responses:
        "200":
          description: >-
            text/event-stream; заголовки Cache-Control: no-cache и X-Accel-Buffering: no.
            Кадр event + data (JSON события), без id; комментарий ": keep-alive" каждые 25 с.
          content:
            text/event-stream:
              schema: { type: string }
        "401": { $ref: "#/components/responses/Problem" }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
  parameters:
    Id:
      name: id
      in: path
      required: true
      schema: { type: integer }
  responses:
    Problem:
      description: Ошибка в едином формате
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Problem" }
    Clock:
      description: Текущие часы
      content:
        application/json:
          schema:
            type: object
            required: [now, frozen]
            properties:
              now: { type: string, format: date-time }
              frozen: { type: boolean, description: "true - часы остановлены (демо)" }
  schemas:
    Problem:
      type: object
      required: [statusCode, code, message]
      properties:
        statusCode: { type: integer }
        code: { type: string, description: "Код из каталога (раздел 8)" }
        message: { type: string, description: "Русское сообщение для пользователя" }
        details: { type: object, additionalProperties: true }
    VacationStatus:
      type: string
      enum: [PENDING, APPROVED, REJECTED, CANCELLED, REPLACED]
    EmployeeRef:
      type: object
      required: [id, fullName]
      properties:
        id: { type: integer }
        fullName: { type: string }
    Profile:
      type: object
      required: [id, fullName, hireDate, teamName, manager, isHr, isManager]
      properties:
        id: { type: integer }
        fullName: { type: string }
        hireDate: { type: string, format: date }
        teamName: { type: string, nullable: true }
        manager: { allOf: [{ $ref: "#/components/schemas/EmployeeRef" }], nullable: true }
        isHr: { type: boolean }
        isManager: { type: boolean }
    Balance:
      type: object
      required: [today, balance]
      properties:
        employeeId: { type: integer }
        today: { type: string, format: date, description: "по Clock и COMPANY_TZ" }
        balance: { type: number, description: "кратно 0.5; может быть отрицательным (§6-4: одобрение в счёт будущих начислений, сдвиг даты выхода, откат демо-часов)" }
        on: { type: string, format: date, nullable: true }
        availableOn: { type: number, nullable: true, description: "доступно на дату on" }
    VacationInput:
      type: object
      required: [startDate, endDate]
      properties:
        startDate: { type: string, format: date }
        endDate: { type: string, format: date }
        backstopperId:
          type: integer
          nullable: true
          description: >
            Обязателен по RULES §3-2 (и для переноса), но не required в схеме: отсутствие или null
            дают 422 BACKSTOPPER_REQUIRED, а не 400; целое вне 1…2147483647 - 422 BACKSTOPPER_NOT_FOUND
            (DECISIONS [S4])
        comment:
          type: string
          nullable: true
          maxLength: 400
          description: >
            Обязателен, если начало раньше сегодня. Не длиннее 400 единиц UTF-16 (эмодзи - 2), длина
            проверяется до обрезки, иначе 400 VALIDATION_FAILED с details.fields.comment. Хранится
            обрезанным по краям, пустой - null (DECISIONS 2026-10-30 14:24, 21:41)
    Decision:
      type: object
      properties:
        comment: { type: string, nullable: true, maxLength: 400, description: "как VacationInput.comment: не длиннее 400 единиц UTF-16 до обрезки" }
    Vacation:
      type: object
      required: [id, employee, backstopper, startDate, endDate, workDays, status, createdAt, transferPending, oldVacationKept, actions]
      properties:
        id: { type: integer }
        employee: { $ref: "#/components/schemas/EmployeeRef" }
        backstopper: { $ref: "#/components/schemas/EmployeeRef" }
        startDate: { type: string, format: date }
        endDate: { type: string, format: date }
        workDays: { type: integer }
        status: { $ref: "#/components/schemas/VacationStatus" }
        comment: { type: string, nullable: true }
        replacesId: { type: integer, nullable: true }
        createdAt: { type: string, format: date-time }
        decidedBy: { allOf: [{ $ref: "#/components/schemas/EmployeeRef" }], nullable: true }
        decidedAt: { type: string, format: date-time, nullable: true }
        decisionComment: { type: string, nullable: true }
        cancelledAt: { type: string, format: date-time, nullable: true }
        returnDate: { type: string, format: date, nullable: true }
        transferPending:
          type: boolean
          description: "Производная пометка «перенос на рассмотрении»"
        oldVacationKept:
          type: boolean
          description: "Производная пометка «Старый отпуск остаётся»"
        actions:
          type: array
          description: "Подсказка для интерфейса: что разрешено зрителю сейчас; сервер всё равно проверяет"
          items:
            type: string
            enum: [cancel, transfer, recall, approve, reject]
    ApprovalItem:
      type: object
      required: [vacation, overlaps, canApprove]
      properties:
        vacation: { $ref: "#/components/schemas/Vacation" }
        availableOnStart:
          type: number
          nullable: true
          description: "Остаток «доступно на дату начала заявки»; null для переноса (остаток не проверяется)"
        overlaps:
          type: array
          description: "Одобренные отпуска команды на пересекающиеся даты (предупреждение, не блокировка)"
          items:
            type: object
            required: [vacationId, employee, startDate, endDate]
            properties:
              vacationId: { type: integer }
              employee: { $ref: "#/components/schemas/EmployeeRef" }
              startDate: { type: string, format: date }
              endDate: { type: string, format: date }
        canApprove: { type: boolean }
        blockReason:
          allOf: [{ $ref: "#/components/schemas/Problem" }]
          nullable: true
          description: "Почему согласовать нельзя (нехватка дней, перенос после начала); отклонить можно всегда"
    HrBalanceRow:
      type: object
      required: [employeeId, fullName, hireDate, balance]
      properties:
        employeeId: { type: integer }
        fullName: { type: string }
        teamName: { type: string, nullable: true }
        manager: { allOf: [{ $ref: "#/components/schemas/EmployeeRef" }], nullable: true }
        hireDate: { type: string, format: date }
        balance: { type: number }
    Calendar:
      type: object
      required: [entries]
      properties:
        entries:
          type: array
          items:
            type: object
            required: [vacationId, employee, startDate, endDate]
            properties:
              vacationId: { type: integer }
              employee: { $ref: "#/components/schemas/EmployeeRef" }
              teamName: { type: string, nullable: true }
              startDate: { type: string, format: date }
              endDate: { type: string, format: date }
        balances:
          type: array
          description: "Только для руководителя: остатки всех прямых подчинённых на сегодня, по имени"
          items:
            type: object
            required: [employee, balance]
            properties:
              employee: { $ref: "#/components/schemas/EmployeeRef" }
              balance: { type: number }
```

Пометки поведения, не выражаемые схемой:

- `GET /vacations/{id}` и все операции над заявкой возвращают `404`, если заявка зрителю не видна. Так же отвечает несуществующий и некорректный `id` (не положительное целое).
- `GET /vacations?scope=team` без прямых подчинённых и `scope=all` не для HR дают `403 FORBIDDEN`; неизвестные `scope`, `status` и лишние параметры query дают `400 VALIDATION_FAILED`. Список отсортирован по `id` по убыванию.
- `GET /me/balance`: `balance` в днях кратно 0,5; без `on` поля `on` и `availableOn` равны `null`.
- `GET /employees` не включает вошедшего: сервер сам исключает его, а `POST /vacations` дополнительно отклоняет `backstopperId` заявителя.
- `POST /vacations` (S4): поля тела только `startDate`, `endDate`, `backstopperId`, `comment`; любое другое (в том числе `workDays`, `employeeId`, `status`) даёт `400 VALIDATION_FAILED`. Неверные обе даты попадают в `details.fields` вместе. `workDays` считает сервер. Комментарий не длиннее 400 единиц UTF-16 до обрезки, иначе `400 VALIDATION_FAILED`. Комментарий хранится обрезанным по краям, пустой - `null`. `createdAt` заявки и письма - один момент Clock на запрос. Проверки, заявка и письмо `NEW_REQUEST` - в одной транзакции под `User ... FOR NO KEY UPDATE` ([раздел 6](#6-политика-блокировок)); проверки в одном месте, `evaluateSubmission` ([vacation-rules.ts](apps/api/src/vacations/vacation-rules.ts)).
- `POST /vacations/{id}/transfer` принимает те же поля, что подача; `backstopperId` обязателен (форма подставляет прежнего). `workDays` рассчитывается сервером, не принимается от клиента.
- Одноразовое сообщение HR «Дата изменена. Проверьте одобренные отпуска этого сотрудника» формирует интерфейс; сервер его не хранит (RULES §6-3).
- `actions` — подсказка для показа кнопок, не источник прав. С S5: `approve`, `reject` у согласующего, пока заявка `PENDING` (автору не показываются). С S6a: `cancel` у владельца, пока заявка `PENDING` или `APPROVED` и сегодня < даты начала; `recall` у HR, пока отпуск `APPROVED` и начало ≤ сегодня ≤ окончание (в том числе над своим). Подсказку дают те же функции, что проверки сервера ([cancel-rules.ts](apps/api/src/vacations/cancel-rules.ts), [vacation-rules.ts](apps/api/src/vacations/vacation-rules.ts)). С S6b: `transfer` у владельца, пока отпуск `APPROVED`, сегодня < даты начала и переноса «На согласовании» нет; пока перенос ждёт решения, у старого отпуска нет `cancel`, `transfer` и `recall`.
- `POST /vacations/{id}/cancel` и `.../recall` (S6a): ответ `200` и заявка `CANCELLED` с `cancelledAt` (Clock) и, у отзыва, `returnDate`. Тело отмены пустое; тело отзыва — только `returnDate` (формат даты как у подачи). Заявка читается без блокировки (для `employeeId`), цепочка до корня по `replacesId` тоже; затем `User` → звенья по возрастанию id `FOR NO KEY UPDATE`, статус перечитывается ([раздел 6](#6-политика-блокировок)). У `APPROVED` — `REFUND` к списанию корня (`occurredAt` = Clock): при отмене `workDays·2`, при отзыве рабочие дни от `returnDate` до `endDate` (может быть 0); у `PENDING` возврата нет. Нарушение `LedgerEntry_one_refund_per_vacation_idx` даёт `409 ALREADY_PROCESSED`. Писем нет (§8-8). Событие `vacation.cancelled` (`by: EMPLOYEE` или `HR_RECALL`) — после коммита и только при отмене `APPROVED`.
- `POST /vacations/{id}/transfer` (S6b): ответ `201`, заявка `PENDING` с `replacesId`, `workDays` старого отпуска, `createdAt` по Clock. Заявка читается без блокировки (для `employeeId`), затем `User` → исходный `Vacation` `FOR NO KEY UPDATE`; статус исходного и наличие преемника `PENDING` перечитываются под блокировкой ([раздел 6](#6-политика-блокировок)). Пересечения ищутся среди `PENDING` и `APPROVED` сотрудника без исходного отпуска. Проверки в одном месте: `transferSourceError` и `evaluateTransfer` ([vacation-rules.ts](apps/api/src/vacations/vacation-rules.ts)). `TRANSFER_WORKDAYS_MISMATCH`: `details = {old, requested}`. Письмо `NEW_REQUEST` тем же шаблоном, что подача (DECISIONS 2026-10-21 14:52). Нарушение `Vacation_single_live_successor_idx` даёт `409 TRANSFER_ALREADY_PENDING`. Событий нет.
- Перенос в `approve`/`reject` (S6b): `replacesId` читается до блокировки, затем `User` → `Vacation {replacesId, id}` по возрастанию id. Утверждение: остаток не проверяется, `DEBIT` нет; сначала старый `APPROVED → REPLACED`, затем перенос `APPROVED`; хук `onVacationApproved` ставит одно письмо `DECISION`; после коммита `vacation.transfer-approved` (вместо `vacation.approved`). Старый уже начался — `422 TRANSFER_APPROVE_AFTER_START`, статусы не меняются. Отклонение — как у обычной заявки, событий нет. В `GET /approvals` у переноса `availableOnStart = null`, `canApprove`/`blockReason` по `TRANSFER_APPROVE_AFTER_START`, в `overlaps` нет переносимого отпуска.
- `GET /approvals` (S5): руководитель видит `PENDING` своих прямых подчинённых, HR — заявки директора; без подчинённых и не HR — `403 FORBIDDEN`. Порядок по `id`, старые сверху. `availableOnStart` считает тот же `BalanceService`, что `/me/balance?on=` и проверка при согласовании; `blockReason` совпадает с телом ответа `approve` при нехватке дней.
- `POST /vacations/{id}/approve|reject` (S5): ответ `200`. Тело необязательно, в нём только `comment`; любое другое поле даёт `400 VALIDATION_FAILED`. Комментарий не длиннее 400 единиц UTF-16 до обрезки, иначе `400 VALIDATION_FAILED`. Комментарий хранится обрезанным по краям, пустой - `null` (`decisionComment`). `decidedAt` и момент списания - один момент Clock на запрос. Заявка читается без блокировки (для `employeeId`), затем `User` → `Vacation` `FOR NO KEY UPDATE`, статус и остаток перечитываются ([раздел 6](#6-политика-блокировок)). Нарушение `LedgerEntry_one_debit_per_vacation_idx` даёт `409 ALREADY_PROCESSED`. Событие `vacation.approved` публикуется после коммита; сбой подписчика пишется в лог и не меняет ответ.
- `GET /hr/balances` (S6c): только HR, иначе `403 FORBIDDEN`; лишний параметр query - `400`. Все пользователи, в том числе HR и директор (`manager = null`), порядок по `fullName`, затем `id`. `balance` - баланс сегодня тем же `BalanceService`, что `/me/balance`, один момент «сегодня» на запрос; может быть отрицательным (§6-4).
- `PATCH /employees/{id}/hire-date` (S6c; DECISIONS 2026-10-28 19:19): тело только `hireDate` (формат и годы как у всех дат API). Порядок проверок - раздел 8. Транзакция: `User` `FOR NO KEY UPDATE`, та же дата не пишется, иначе `UPDATE hireDate`; журнал, заявки и outbox не меняются (§6-3, §6-6). Ответ `200` - `HrBalanceRow` после коммита. Событие `employee.hire-date-changed` после коммита и только при реальном изменении; та же дата - `200` без события. `accessGranted` не меняется (§6-5, §6-7). Дата в будущем и раньше одобренных отпусков принимается; новые заявки проверяются по новой дате (`NO_ACCRUAL_YET`, `VACATION_BEFORE_HIRE`), согласование повторно проверяет только остаток (DECISIONS 2026-10-28 19:19).
- `GET /calendar` (S5-e; S6-audit — `calendarScope`): только `APPROVED` в пределах `calendarScope` зрителя; отпуск попадает, если пересекается с `[from, to]`, даты отдаются полностью; порядок `startDate`, имя, `id`. `from` и `to` обязательны; неверная дата, `from > to` и лишние параметры (в том числе `employeeId`) дают `400 VALIDATION_FAILED`; длина диапазона не ограничена. `balances` есть только у зрителя с прямыми подчинёнными (тот же `BalanceService`, что `/me/balance`), у остальных поля нет. Об изменениях сервер сообщает событиями `GET /events` ([раздел 9](#9-события-и-sse)), данные клиент перечитывает этим же запросом.

---

## 8. Каталог ошибок

### Формат

```json
{ "statusCode": 422, "code": "VACATION_OVERLAP", "message": "У вас уже есть заявка на эти даты: с 2026-11-02 по 2026-11-06", "details": { "vacationId": 17, "from": "2026-11-02", "to": "2026-11-06" } }
```

- `code` — стабильный идентификатор для интерфейса и тестов; `message` — русский текст для пользователя; `details` — необязательные поля для подстановки.
- Классы: `400` — форма запроса; `401` — не вошёл; `403` — вошёл, но действие запрещено; `404` — не найдено или не видно; `409` — состояние уже изменилось; `422` — нарушено правило предметной области.
- Необработанные ошибки сервера (`500`) возвращают `{statusCode: 500, message: "Внутренняя ошибка сервера"}` без кода и стека (стек только в серверный лог). Так же, без `code`, отвечают статусы вне каталога (`405`, `413` и т. п.): `{statusCode, message}`.
- Без `DEMO_MODE` маршрута `/clock` нет: `GET`/`PUT /clock` отвечают `404 NOT_FOUND` всем, в том числе без токена (`DemoOnlyMiddleware` срабатывает раньше guard'ов; S9, DECISIONS 2026-10-30 14:24). Неизвестный маршрут без токена отвечает `404` (до guard), существующий `401`: пересмотрено в S9 и оставлено, см. §13.
- Лишнее поле в теле запроса отклоняется: `400 VALIDATION_FAILED`, `details.fields` (поле -> сообщения). Битый JSON даёт тот же код.
- Текст из RULES приведён дословно (отмечено «RULES»), остальные формулировки — проектные; пункт RULES, из которого следует правило, указан всегда.

### Вход и доступ

| Код | HTTP | Сообщение | RULES |
|---|---|---|---|
| `AUTH_INVALID_CREDENTIALS` | 401 | Неверный логин или пароль | §7-1 |
| `AUTH_REQUIRED` | 401 | Требуется вход | §7-1 (нет токена, токен недействителен или подделан, пользователь по `sub` не найден; токен только из заголовка `Authorization: Bearer`) |
| `AUTH_TOKEN_EXPIRED` | 401 | Сессия истекла, войдите снова | §7-1 (текст: DECISIONS 2026-10-22 12:15) |
| `AUTH_NOT_HIRED_YET` | 403 | Доступ откроется в дату выхода на работу | §6-7, §2 |
| `FORBIDDEN` | 403 | Недостаточно прав для этого действия | §7-2 |
| `NOT_FOUND` | 404 | Не найдено | §7-2 (невидимый объект; также `/clock` без `DEMO_MODE`, §9-2) |
| `VALIDATION_FAILED` | 400 | Некорректные данные запроса | §3-2 (`details.fields`) |

### Подача заявки (вся группа — 422)

| Код | Сообщение | RULES |
|---|---|---|
| `VACATION_DATES_ORDER` | Дата начала позже даты окончания | §3-4 |
| `VACATION_CROSSES_YEAR` | Заявка не может охватывать два года, подайте две заявки | §3-4 (RULES) |
| `VACATION_NO_WORK_DAYS` | В заявке нет ни одного рабочего дня | §3-4 |
| `VACATION_OVERLAP` | У вас уже есть заявка на эти даты: с {from} по {to} | §3-4 (RULES) |
| `BACKSTOPPER_REQUIRED` | Укажите заменяющего сотрудника | §3-2 |
| `BACKSTOPPER_IS_SELF` | Нельзя указать себя заменяющим | §3-3 |
| `BACKSTOPPER_NOT_FOUND` | Заменяющий сотрудник не найден | §3-3 |
| `NO_ACCRUAL_YET` | У вас ещё нет накопленных дней | §3-6 (RULES) |
| `VACATION_BEFORE_HIRE` | Дата начала отпуска раньше даты вашего выхода на работу | §3-12 |
| `PAST_START_YEAR` | Начало отпуска в прошлом году: такая заявка не принимается | §3-7 |
| `PAST_COMMENT_REQUIRED` | Для отпуска с датой в прошлом укажите причину в комментарии | §3-7 |
| `INSUFFICIENT_BALANCE` | Не хватает дней: доступно {available}, в заявке {requested} | §3-9 |

Подстановки группы подачи (S4):

- `VACATION_OVERLAP`: `details = {vacationId, from, to}`, даты ISO `YYYY-MM-DD`; при нескольких пересечениях берётся заявка с самой ранней датой начала. Пересечение ищется только среди `PENDING` и `APPROVED` того же сотрудника; отпуск backstopper не мешает (§3-3).
- `INSUFFICIENT_BALANCE`: `details = {available, requested}` числами (дни, кратно 0,5); в тексте дни через запятую («2,5»), отрицательное значение с типографским минусом («−1», §6-4). `available` - «доступно на дату начала» тем же кодом, что `GET /me/balance?on=` (§3-10).
- `BACKSTOPPER_NOT_FOUND`: также для целого `backstopperId` вне 1…2147483647 (без запроса в БД).
- `BACKSTOPPER_*` и коды группы - без `details`.

### Согласование

| Код | HTTP | Сообщение | RULES |
|---|---|---|---|
| `ALREADY_PROCESSED` | 409 | Заявка уже обработана | §10-1 (RULES) |
| `NOT_APPROVER` | 403 | Эту заявку согласует другой сотрудник | §4-1, §4-2 |
| `APPROVE_OWN_REQUEST` | 403 | Свою заявку согласовать нельзя | §4-1, §4-2 (DECISIONS 2026-10-22 12:15) |
| `APPROVE_INSUFFICIENT_BALANCE` | 422 | Согласовать нельзя: осталось {available} дней, в заявке {requested} | §4-3 (RULES) |
| `TRANSFER_APPROVE_AFTER_START` | 422 | Старый отпуск уже начался: перенос можно только отклонить | §5-2 |

### Перенос, отмена, отзыв

| Код | HTTP | Сообщение | RULES |
|---|---|---|---|
| `TRANSFER_SOURCE_NOT_APPROVED` | 422 | Перенести можно только одобренный отпуск | §5-2 |
| `TRANSFER_STARTED` | 422 | Отпуск уже начался, перенести его нельзя | §5-1 |
| `TRANSFER_ALREADY_PENDING` | 409 | Перенос этого отпуска уже ждёт решения; повторно перенести отпуск нельзя | §5-2 |
| `TRANSFER_WORKDAYS_MISMATCH` | 422 | Число рабочих дней должно совпадать: было {old}, в заявке {requested} | §5-2 |
| `TRANSFER_START_IN_PAST` | 422 | Начало переноса не может быть раньше сегодняшней даты; для прошлых дат подайте обычную заявку | §5-2 |
| `PENDING_TRANSFER_BLOCKS` | 409 | Пока перенос ждёт решения, отпуск нельзя отменить или отозвать: сначала отмените перенос | §5-2, §5-3 |
| `CANCEL_STARTED_BY_EMPLOYEE` | 403 | Отпуск уже начался: отменить его сами вы не можете | §5-7 (текст: DECISIONS 2026-10-28 15:46) |
| `CANCEL_PENDING_AFTER_START` | 422 | Заявка ждёт решения, а отпуск уже должен был начаться: её нельзя отменить, согласующий одобрит или отклонит её | §5-10 |
| `RECALL_NOT_STARTED` | 422 | Отпуск ещё не начался: до начала его отменяет только сотрудник | §5-4, §5-5 |
| `RECALL_NOT_APPROVED` | 422 | Отозвать можно только одобренный отпуск | §5-5 |
| `RECALL_FINISHED` | 422 | Отпуск уже закончился: отозвать из него нельзя | §5-5 (DECISIONS 2026-10-28 15:41) |
| `RECALL_DATE_OUT_OF_RANGE` | 422 | Дата выхода должна быть между датой начала и датой окончания отпуска включительно | §5-11 |

Повторное действие над заявкой, статус которой уже не допускает его (например, второй раз «Отменить», решение по `CANCELLED`/`REPLACED`), даёт `409 ALREADY_PROCESSED`. Двойной клик по «Подать» не создаёт вторую заявку: вторая получает `VACATION_OVERLAP` с первой, письмо одно (§10-1).

Заявка, которая зрителю **видна**, но действие над ней ему не принадлежит (руководитель вызывает отмену заявки подчинённого): `403 FORBIDDEN`. Заявка, которая **не видна**: `404 NOT_FOUND`.

### Порядок проверок

Возвращается **одна, первая по порядку** ошибка (RULES: «система объясняет причину»). Порядок — проектное решение: сначала форма и справочные поля, затем правила дробления, затем зависящие от данных.

- **Подача:** `VALIDATION_FAILED` → `BACKSTOPPER_REQUIRED` → `BACKSTOPPER_IS_SELF` → `BACKSTOPPER_NOT_FOUND` → `VACATION_DATES_ORDER` → `VACATION_CROSSES_YEAR` → `VACATION_NO_WORK_DAYS` → `NO_ACCRUAL_YET` → `VACATION_BEFORE_HIRE` → `PAST_START_YEAR` → `PAST_COMMENT_REQUIRED` → `VACATION_OVERLAP` → `INSUFFICIENT_BALANCE`.
- **Перенос** (DECISIONS 2026-10-28 17:06): `VALIDATION_FAILED` → `NOT_FOUND` → `FORBIDDEN` (не владелец) → `ALREADY_PROCESSED` (исходный `CANCELLED` или `REPLACED`) → `TRANSFER_SOURCE_NOT_APPROVED` (`PENDING`, `REJECTED`) → `TRANSFER_ALREADY_PENDING` → `TRANSFER_STARTED` → `BACKSTOPPER_REQUIRED` → `BACKSTOPPER_IS_SELF` → `BACKSTOPPER_NOT_FOUND` → `VACATION_DATES_ORDER` → `VACATION_CROSSES_YEAR` → `VACATION_NO_WORK_DAYS` → `TRANSFER_START_IN_PAST` → `TRANSFER_WORKDAYS_MISMATCH` → `VACATION_OVERLAP`. Повторный перенос, пока перенос ждёт решения, — `TRANSFER_ALREADY_PENDING`; отмена и отзыв старого — `PENDING_TRANSFER_BLOCKS`. Проверки `NO_ACCRUAL_YET`, `VACATION_BEFORE_HIRE` (§3-12), `PAST_*` и `INSUFFICIENT_BALANCE` к переносу не применяются (остаток не проверяется, перенос в прошлое запрещён отдельным правилом, §5-2).
- **Отмена** (DECISIONS 2026-10-28 15:41): `VALIDATION_FAILED` → `NOT_FOUND` → `FORBIDDEN` (не владелец) → `ALREADY_PROCESSED` (статус не `PENDING` и не `APPROVED`) → `PENDING_TRANSFER_BLOCKS` → `CANCEL_STARTED_BY_EMPLOYEE` (`APPROVED`, сегодня ≥ начала) или `CANCEL_PENDING_AFTER_START` (`PENDING`, сегодня ≥ начала).
- **Отзыв** (DECISIONS 2026-10-28 15:41): `VALIDATION_FAILED` → `NOT_FOUND` → `FORBIDDEN` (не HR) → `ALREADY_PROCESSED` (`CANCELLED`, `REPLACED`) → `RECALL_NOT_APPROVED` (`PENDING`, `REJECTED`) → `RECALL_NOT_STARTED` → `RECALL_FINISHED` → `PENDING_TRANSFER_BLOCKS` → `RECALL_DATE_OUT_OF_RANGE`.
- **Смена даты выхода** (DECISIONS 2026-10-28 19:19): `VALIDATION_FAILED` (тело, затем формат и годы даты) → `NOT_FOUND` (некорректный, несуществующий или невидимый зрителю id) → `FORBIDDEN` (виден, но не HR). HR меняет дату и себе.
- **Согласование:** `VALIDATION_FAILED` (тело) → `NOT_FOUND` (невидимая, несуществующая, некорректный id) → `APPROVE_OWN_REQUEST` (автор) → `NOT_APPROVER` → `ALREADY_PROCESSED` → `TRANSFER_APPROVE_AFTER_START` (перенос) или `APPROVE_INSUFFICIENT_BALANCE` (обычная заявка). Текст `APPROVE_INSUFFICIENT_BALANCE` оформлен как `INSUFFICIENT_BALANCE`: дни через запятую, минус типографский, в `details.available` и `details.requested` числа (DECISIONS 2026-10-26 10:47).

### Соответствие ограничениям БД

| Ограничение БД | Код |
|---|---|
| `Vacation_no_approved_overlap_excl` | `VACATION_OVERLAP` |
| `Vacation_single_live_successor_idx` | `TRANSFER_ALREADY_PENDING` |
| `LedgerEntry_one_debit_per_vacation_idx`, `LedgerEntry_one_refund_per_vacation_idx` | `ALREADY_PROCESSED` |
| `Vacation_dates_order_chk`, `Vacation_one_year_chk`, `Vacation_work_days_chk`, `Vacation_backstopper_not_self_chk` | как правила подачи выше (приложение проверяет раньше БД) |

---

## 9. События и SSE

### Шина (контракт S1, код S5)

```ts
type DomainEvent =
  | { type: 'vacation.approved';          employeeId: number; vacationId: number }
  | { type: 'vacation.cancelled';         employeeId: number; vacationId: number; by: 'EMPLOYEE' | 'HR_RECALL' }
  | { type: 'vacation.transfer-approved'; employeeId: number; vacationId: number; replacedId: number }
  | { type: 'employee.hire-date-changed'; employeeId: number }
  | { type: 'clock.changed' };                                  // S8, только демо-режим

interface EventBus { publish(event: DomainEvent): void }   // вызывается после коммита
```

Набор событий — ровно перечень RULES §10-2, включая смену демо-часов. Отдельных событий об остатке, о подаче, об отклонении, об отмене заявки `PENDING` и переноса нет: они не меняют календарь.

| Событие | Когда | Получатели |
|---|---|---|
| `vacation.approved` | одобрена обычная заявка (§10-2) | `calendarScope`: сам сотрудник, коллеги с тем же руководителем, его руководитель, HR |
| `vacation.cancelled` | отменён `APPROVED`-отпуск сотрудником, отменён или отозван HR | то же |
| `vacation.transfer-approved` | перенос утверждён, старый стал `REPLACED` | то же |
| `employee.hire-date-changed` | HR сменил дату выхода (остатки меняются, отпуска остаются на местах, §6) | `canSee`: сам сотрудник, его руководитель, HR; коллеги нет (DECISIONS 2026-10-29 15:09) |
| `clock.changed` | установлены демо-часы, после прохода планировщика (§9-4) | все вошедшие (DECISIONS 2026-10-29 21:18); без `DEMO_MODE` события нет |

Получатели считает чистая функция `deliver(event, viewerId, org)` ([event-filter.ts](apps/api/src/events/event-filter.ts)) поверх `calendarScope`/`canSee` ([раздел 5](#5-согласующий-и-видимость)). Например, отпуск сотрудника команды 1 видят он, коллеги, руководитель 1 и HR; отпуск руководителя — его подчинённые, его руководитель и HR; отпуск директора — только он и HR. Событие несёт только идентификаторы; данные клиент перечитывает сам, поэтому утечки содержимого нет.

### SSE `GET /events`

- Транспорт: **fetch-stream** с заголовком `Authorization` (токен в URL не передаётся; `?token=` не читается, `401`). Ответ `text/event-stream`, заголовки `Cache-Control: no-cache` и `X-Accel-Buffering: no` (nginx не буферизует), затем `flushHeaders()`.
- Кадр: `event: <type>` и `data: <JSON события>`; без `id` и `Last-Event-ID`, буфера нет.
- Сервер раз в 25 с шлёт комментарий `: keep-alive`, чтобы nginx не закрыл простаивающее соединение.
- `SseHub` ([sse-hub.ts](apps/api/src/events/sse-hub.ts)) — единственный подписчик шины. Адресаты фиксируются в момент публикации: открывший поток позже события его не получает. События обрабатываются в **одной очереди строго по одному**, порядок сохраняется. На событие структура (`id, isHr, managerId` всех) читается один раз, зритель берётся из неё, а не из токена. Сбой обработки (например, чтения структуры) пишется в лог; ответ API уже отдан, поток и следующие события не страдают.
- Токен проверяет глобальный `JwtAuthGuard` при подключении: без токена, с недействительным — `401 AUTH_REQUIRED`, истёкший — `401 AUTH_TOKEN_EXPIRED`, поток не открывается. В момент `exp` токена (по системным часам, как проверка JWT) сервер закрывает поток; при `401` клиент **не переподключается** и показывает экран входа.
- Отключение клиента удаляет поток и его таймеры. При остановке api (`enableShutdownHooks`, `SIGTERM`) `SseHub.onModuleDestroy` закрывает все потоки, остановка не ждёт клиентов.
- Клиент (S8-b): одно соединение на вкладку на всех экранах вошедшего; переподключение 1→2→4→8→16→30 с, сброс паузы после успеха; первое подключение с первой попытки данные не перечитывает, первое успешное после неудачной попытки — перечитывает; после повторного соединения — полная перезагрузка данных календаря и экрана HR; на событие §10-2 — перечитывание в фоне, включая остатки, события одного чанка — одно перечитывание; на `clock.changed` — полная перезагрузка страницы, вкладка, где установили часы, перезагружается один раз ([events-stream.ts](apps/web/src/api/events-stream.ts), [live-logic.ts](apps/web/src/live/live-logic.ts); DECISIONS 2026-10-29 21:18, 22:26, 2026-10-30 02:12).

- Известные ограничения: события, пришедшие при обрыве, теряются (после переподключения данные перечитываются полностью); свой остаток сотрудника на странице «Отпуск» после смены даты выхода виден после перехода или перезагрузки (DECISIONS 2026-10-29 21:41).

### Хуки внутри транзакции (не SSE)

| Хук | Где вызывается | Что делает |
|---|---|---|
| `onVacationApproved(tx, vacation)` ([vacation-approved.hook.ts](apps/api/src/approvals/vacation-approved.hook.ts)) | согласование обычной заявки (S5); утверждение переноса (S6b) | вызывается после смены статуса, сбой откатывает решение целиком; S5: `OutboxMessage(DECISION)` через `enqueueDecisionMail` ([decision-mail.ts](apps/api/src/mail/decision-mail.ts)), `createdAt = decidedAt`; S7: плюс немедленное `REMINDER` через `enqueueReminderMails` ([reminder-mail.ts](apps/api/src/mail/reminder-mail.ts)), если дата напоминания ≤ сегодня < даты начала (`lateReminderDue`); «сегодня» и `createdAt` из `decidedAt` |

---

## 10. Планировщик и outbox

### Правила писем (RULES §8)

| Тип | Получатель | Когда создаётся |
|---|---|---|
| `NEW_REQUEST` | `approverOf(employee)`; для директора — HR (в том числе для переноса) | при подаче заявки и заявки-переноса |
| `DECISION` | автор заявки (сотрудник; директор; HR по своей заявке, §8-2, §8-6) | при согласовании или отклонении (в том числе переноса) |
| `REMINDER` | сотрудник и его руководитель; у директора только он сам; по своему отпуску HR и заместитель директора (§8-6); backstopper и HR по чужим отпускам не получают | планировщик, либо сразу при позднем одобрении |

Тему и текст письма формирует модуль `mail` при постановке в очередь и сохраняет в `subject` и `body` (формулировки в RULES не заданы, определены в S4, S5 и S7, [mail-templates.ts](apps/api/src/mail/mail-templates.ts)). Ссылок в письмах нет.

| Письмо | Тема | Текст (строки) |
|---|---|---|
| `NEW_REQUEST` | `Новая заявка на отпуск: {ФИО}, {start}–{end}` | `{ФИО} подал(а) заявку на отпуск с {start} по {end}.` / `Рабочих дней: {N}. Заменяющий: {ФИО backstopper}.` / `Комментарий: {comment}` (только если есть) |
| `NEW_REQUEST` директора (получатель HR) | `Допуск HR: новая заявка на отпуск, {ФИО}, {start}–{end}` | те же строки и последней `Заявку директора подтверждает HR.` |
| `DECISION` | `Заявка на отпуск одобрена: {start}–{end}` / `Заявка на отпуск отклонена: {start}–{end}` | `Ваша заявка на отпуск с {start} по {end} одобрена.` (`отклонена.`) / `Рабочих дней: {N}. Решение принял(а): {ФИО согласующего}.` / `Комментарий: {decisionComment}` (только если есть) |
| `DECISION` директора (решает HR) | `Допуск HR: заявка на отпуск одобрена, {start}–{end}` (`отклонена`) | те же строки и последней `Решение по заявке директора принимает HR (допуск HR).` |
| `REMINDER` сотруднику | `Напоминание: отпуск {start}–{end}` | `Ваш отпуск с {start} по {end} скоро начнётся.` / `Рабочих дней: {N}. Заменяющий: {ФИО backstopper}.` |
| `REMINDER` руководителю | `Напоминание: отпуск {ФИО}, {start}–{end}` | `{ФИО} уходит в отпуск с {start} по {end}.` / `Рабочих дней: {N}. Заменяющий: {ФИО backstopper}.` |

Даты в письмах ISO `YYYY-MM-DD`. Тексты `DECISION` определены в S5 (DECISIONS 2026-10-28 01:59); `createdAt` письма о решении равен `decidedAt` заявки (один момент Clock). Тексты `REMINDER` определены в S7; `createdAt` — момент прохода планировщика по Clock или `decidedAt` при позднем одобрении. Отмена, отзыв, смена даты выхода, письма backstopper и HR об отменах и переносах — **писем не порождают** (§8-7, §8-8). Ключ `(type, vacationId, recipientId)` даёт одно письмо на сочетание (§8-3).

### Проход планировщика (идемпотентный, по Clock)

```text
pass():
  now    = Clock.now()
  today  = date(now, COMPANY_TZ)
  after9 = now >= 09:00 по COMPANY_TZ в день today

  для каждого отпуска v: status = APPROVED и v.startDate > today   // начавшиеся не напоминаем (§8-4)
    remDate = N-й рабочий день, предшествующий v.startDate           // N = REMINDER_DAYS, начало не считается (§8-3)
    due = remDate < today  или  (remDate = today и after9)
    если не due: пропустить
    получатели = [v.employee] + [manager(v.employee)], если он есть   // у директора только он сам; HR только по своему отпуску (§8-6)
    INSERT OutboxMessage(REMINDER, v.id, recipient, createdAt = now, nextAttemptAt = системное now)
      ON CONFLICT DO NOTHING                                          // по возрастанию recipientId, одним запросом
```

- **Код:** [reminder-scheduler.ts](apps/api/src/scheduler/reminder-scheduler.ts) (проход), [reminder-worker.ts](apps/api/src/scheduler/reminder-worker.ts) (старт и интервал), [scheduler.module.ts](apps/api/src/scheduler/scheduler.module.ts) (`AFTER_CLOCK_SET`), правила «пора» и «позднее одобрение» — [domain/reminder.ts](apps/api/src/domain/reminder.ts), получатели и текст — [reminder-mail.ts](apps/api/src/mail/reminder-mail.ts). `REMINDER_DAYS` не целое ≥ 1 — ошибка при старте.
- **Запуск:** при старте; после каждой установки демо-часов, синхронно до ответа (§9-4); в обычном режиме раз в минуту (цепочка setTimeout, проходы не накладываются), в демо-режиме периодического прохода нет. Планировщик **только создаёт строки outbox**, отправляет диспетчер. В integration-тестах `ReminderWorker` подменён, тесты вызывают `ReminderScheduler.pass()`.
- **Идемпотентность:** повторный проход, перезапуск, откат часов и перемотка вперёд дублей не создают, потому что строка с тем же ключом уже есть (уникальность §8-3). Откат демо-часов журнал и уже отправленные письма не меняет (§9-5).
- **Строка создаётся, когда напоминание «пора»**, а не заранее на 09:00: `nextAttemptAt` идёт по системным часам, а «09:00» — по Clock (проектное решение).
- **Дата напоминания сегодня, но до 09:00** — ждём 09:00 (в проходе до 09:00 `due = false`). **Дата напоминания раньше сегодня** и отпуск не начался — строка создаётся при старте или на очередном проходе (просроченные, DECISIONS 2026-10-22 15:35).
- **Позднее одобрение:** если при одобрении дата напоминания ≤ сегодня < даты начала, хук `onVacationApproved` создаёт `REMINDER` сразу, в любое время суток; плановое напоминание не дублируется (тот же ключ). То же при утверждении переноса по новым датам (§8-3 «Перенос», DECISIONS 2026-10-29 07:08).
- **Перенос:** старый отпуск до утверждения остаётся `APPROVED` и его напоминание может уйти; после утверждения он `REPLACED` и не попадает в выборку; новый отпуск получает своё одно напоминание.
- **Получатель-руководитель** — текущий `managerId` в момент постановки; поставленная строка при смене руководителя не перенаправляется, новому руководителю очередной проход ставит свою (DECISIONS 2026-10-29 07:08, 10:49).

### Диспетчер outbox (S4, системное время БД)

Код: [outbox-dispatcher.ts](apps/api/src/mail/outbox-dispatcher.ts) (проход), [outbox-worker.ts](apps/api/src/mail/outbox-worker.ts) (опрос), [outbox-config.ts](apps/api/src/mail/outbox-config.ts) (параметры и пауза), [mail-transport.ts](apps/api/src/mail/mail-transport.ts) (SMTP через nodemailer).

```text
каждые OUTBOX_POLL_MS мс (цепочка setTimeout, проходы одного воркера не накладываются):
  транзакция:
    выбрать до 10 строк: PENDING и nextAttemptAt <= now()
      ORDER BY nextAttemptAt, id  FOR UPDATE OF OutboxMessage SKIP LOCKED     // User и Vacation не блокируются (раздел 6)
    для каждой строки по очереди:
      REMINDER: если vacation.status != APPROVED или сегодня (Clock, COMPANY_TZ) >= startDate
                -> status = SKIPPED, без отправки                            // §8-3, §8-4: проверка в момент отправки
      отправить через SMTP (Mailpit)
        успех: status = SENT, sentAt = clock_timestamp()
        сбой:  attempts += 1, lastError, nextAttemptAt = clock_timestamp() + пауза(attempts); проход закончен
```

- **Пауза:** `min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_BASE_MS · 2^(attempts−1))`, по умолчанию 5 с, 10 с, 20 с … 5 мин. Лимита попыток нет, статуса `FAILED` нет (DECISIONS 2026-10-26 00:43).
- **Время:** выбор по `now()` (начало транзакции), `sentAt` и `nextAttemptAt` по `clock_timestamp()` (факт отправки или сбоя): транзакция открыта на время SMTP. Clock не участвует в расписании попыток, поэтому при замороженных демо-часах повтор наступает (RULES §9-1). Clock нужен только для «сегодня» в проверке напоминания (§8-4).
- **Сбой** останавливает проход: остальные строки пачки не получают `attempts + 1` и берутся следующим проходом.
- **Таймауты SMTP** короткие (соединение 5 с, приветствие 5 с, обмен 10 с), таймаут транзакции прохода `10 × 20 с + 10 с`: зависший сервер не держит блокировку минутами.
- Два воркера и перезапуск между попытками дублей не дают (`SKIP LOCKED`, уникальный ключ §8-3). Ошибка прохода (например, БД недоступна) пишется в лог, опрос продолжается.
- В integration-тестах воркер подменён, тесты вызывают `OutboxDispatcher.runOnce()`; доставка через настоящий Mailpit проверяется в e2e ([mail.spec.ts](e2e/mail.spec.ts)).
- Остаточные риски: [раздел 13](#13-проектные-решения-и-известные-ограничения).

---

## 11. Сценарии и строки БД

«Бумажный прогон» RULES по модели: каждый сценарий выражается строками без правок схемы. `HD` = `halfDays`.

| Сценарий | RULES | Что пишется |
|---|---|---|
| Сотрудник из seed, выход ≤ сегодня | §6-7 | `User(accessGranted = true)` |
| Первый вход | §6-7 | `User.accessGranted = true` |
| Подача заявки | §3, §8-2 | `Vacation(PENDING, createdAt = Clock)`; `OutboxMessage(NEW_REQUEST → approverOf)` |
| Согласование обычной заявки | §4-4, §8-2 | `Vacation(APPROVED, decidedBy/At)`; `LedgerEntry(DEBIT, HD = workDays·2, occurredAt = Clock)`; `OutboxMessage(DECISION → сотрудник)`; при позднем одобрении `REMINDER` сразу; событие `vacation.approved` |
| Отклонение | §4 | `Vacation(REJECTED, decidedBy/At)`; `OutboxMessage(DECISION)`; журнала нет |
| Нехватка дней при согласовании | §4-3 | ничего не пишется; `422 APPROVE_INSUFFICIENT_BALANCE`; отклонить можно |
| Отмена сотрудником `APPROVED` до начала | §5-4 | `Vacation(CANCELLED, cancelledBy/At)`; `LedgerEntry(REFUND, refundOfId = DEBIT, HD = полное)`; писем нет; `vacation.cancelled` |
| Отмена `PENDING` | §5-4 | `Vacation(CANCELLED)`; ни возврата, ни писем, ни события |
| Отзыв HR после начала | §5-5, §5-6, §5-11 | `Vacation(CANCELLED, returnDate)`; `REFUND` с HD за рабочие дни от `returnDate` до `endDate` (может быть 0); писем нет; `vacation.cancelled` |
| Заявка-перенос | §5-2, §8-2 | `Vacation(PENDING, replacesId = A)`; `NEW_REQUEST → approverOf` |
| Перенос ждёт решения | §3-11 | у A нет изменений; пометка выводится по `PENDING`-преемнику |
| Утверждение переноса | §5-2 | в одной транзакции `A: REPLACED`, затем `B: APPROVED`; журнал не меняется; `DECISION`; `vacation.transfer-approved` |
| Отклонение или отмена переноса | §3-11, §5-3 | `B: REJECTED` или `CANCELLED`; `A` остаётся `APPROVED`; письмо о решении только при отклонении |
| Цепочка A→B→C, отмена C | §5-12, §6-8 | `C: CANCELLED`; `REFUND(vacationId = C, refundOfId = DEBIT(A))`; A и B остаются `REPLACED` |
| Смена даты выхода | §6-1…§6-5 | `User.hireDate`; журнал и отпуска не меняются; остаток пересчитывается при чтении; `employee.hire-date-changed` (только если дата изменилась) |
| Отрицательный остаток | §6-4 | строк нет: свёртка даёт минус; доступ не отзывается (`accessGranted` не меняется) |
| Напоминание | §8-3 | `OutboxMessage(REMINDER)` ×(сотрудник, руководитель) |
| Демо-часы | §9-2 | `ClockState(id = 1, instant)` |
| Откат часов | §9-5 | строки не пересчитываются; дубли напоминаний блокирует ключ §8-3 |
| Заявка директора | §4-2, §8-6 | `NEW_REQUEST → HR`, решает HR (`decidedBy = HR`), `DECISION → директор` |
| `seed:demo` при часах 2026-10-21 | §4-1, §4-2, §4-6, §8-2, §9-1 | 7 `Vacation` с `comment` = метка (margaret, emily, sophie, grace `PENDING`; james, henry `APPROVED`; chloe `REJECTED`); 2 `DEBIT` по 10 полудней; 7 `NEW_REQUEST`, 3 `DECISION`; моменты по Clock |

---

## 12. Стек и обоснование

Для требования PDF (стек и причины, ROADMAP §6, п. 2–4, 10). Решения — это то, что реально используется в репозитории.

| Технология | Зачем | Причина выбора |
|---|---|---|
| **NestJS** (Node.js 24) | api | требование PDF; модули и DI соответствуют модульной структуре раздела 4; guards для ролей и `visibleTo`; единый фильтр ошибок под формат `Problem` |
| **Prisma 7** | доступ к данным, миграции | типизированная схема и генерируемый клиент; что Prisma не выражает (EXCLUDE, частичные UNIQUE, CHECK, триггер) лежит в сыром SQL миграции; дрейф ловит `db:drift` в CI |
| **PostgreSQL** | хранилище | `EXCLUDE USING gist` по диапазону дат, частичные уникальные индексы, `SELECT ... FOR UPDATE [SKIP LOCKED]`, `DATE` и `timestamptz` — ограничения RULES §10 держит сама БД |
| **React** (Vite) + nginx | web | требование PDF; SPA, вход токеном, фоновое обновление по SSE; nginx проксирует `/api` без CORS |
| **Jest** | unit и integration | рядом с NestJS; integration на настоящем Postgres (`*.int.spec.ts`) |
| **Playwright** | e2e | несколько браузерных контекстов для сценария «две вкладки, разные пользователи» (RULES §7-4) |
| **Mailpit** | заглушка почты | эмуляция внешнего сервиса (SMTP + HTTP API для проверки писем), без облака |
| **Docker Compose** | запуск | `docker compose up` поднимает всё локально |

---

## 13. Проектные решения и известные ограничения

### Проектные решения, не следующие из RULES дословно

Каждое должно попасть в DECISIONS с пометкой [S1].

1. Пути, методы, HTTP-коды API и имена кодов ошибок; формулировки ошибок, не заданные в RULES (раздел 8).
2. Невидимый объект даёт `404`, а не `403`; `403` только для «видишь, но нельзя».
3. Дни в API — число кратное 0,5; в домене и журнале — половинки дня.
4. В JWT только `sub`; роли и `scope` вычисляются по структуре на каждый запрос.
5. Строка `REMINDER` создаётся, когда напоминание «пора», а не заранее.
6. Вставки в outbox всегда `ON CONFLICT DO NOTHING`, по возрастанию `recipientId`, одним запросом.
7. Шина событий внутри процесса, публикация после коммита; отдельный хук `onVacationApproved` внутри транзакции.
8. `actions` в `Vacation` — серверная подсказка кнопок.
9. Предупреждение о пересечениях не учитывает заменяемый переносом отпуск (как §5-2 для пересечений).
10. `backstopperId` в переносе передаётся явно (форма подставляет прежнего).
11. `GET /employees` не включает вошедшего.
12. Политика блокировок (в том числе режим `FOR NO KEY UPDATE`) и формат ошибок (разделы 6 и 8); обоснование стека (раздел 12).
13. События SSE о смене даты выхода получают сотрудник, его руководитель и HR (`canSee`); события `vacation.*` — по `calendarScope` (S8, раздел 9; DECISIONS 2026-10-29 15:09).
14. Порядок проверок и «одна первая ошибка» при подаче, переносе и согласовании (раздел 8).
15. Проход планировщика после `PUT /clock` выполняется синхронно, до ответа (детерминизм e2e).
16. Тексты и темы писем определяет S4 (`NEW_REQUEST` - [раздел 10](#10-планировщик-и-outbox)).
17. Диспетчер outbox: пачка 10 писем, пауза с удвоением до `OUTBOX_RETRY_MAX_MS`, остановка прохода на первом сбое, `clock_timestamp()` для `sentAt` и `nextAttemptAt`, проверка «сегодня ≥ даты начала» для напоминания по Clock ([раздел 10](#10-планировщик-и-outbox)).
18. Свою заявку не согласует никто: `APPROVE_OWN_REQUEST` для автора при любой роли, раньше `NOT_APPROVER` (S5, раздел 5).
19. `GET /approvals` только руководителю и HR, порядок по `id`; тело решения - только `comment` (S5, раздел 7).
20. Второе списание по заявке, пойманное уникальным индексом, отвечает `409 ALREADY_PROCESSED`, а не `500` (S5, разделы 6 и 8).
21. Шина событий: исключение подписчика пишется в лог и не меняет ответ API (S5, раздел 4).
22. `seed:demo`: обычные сервисы без Nest, только при `DEMO_MODE`, сценарий узнаётся по метке в комментарии, пропуск сценария даёт код выхода 1 (S5, раздел 4).
23. `GET /calendar`: отпуск по пересечению с `[from, to]` без обрезки дат, диапазон не ограничен, `balances` только руководителю, с именами подчинённых; календарь — отдельная страница для всех ролей, экран HR остаётся под S6 (S5-e, раздел 7).
24. Порядок проверок отмены и отзыва; отзыв по `REJECTED` — `RECALL_NOT_APPROVED`, по `CANCELLED`/`REPLACED` — `ALREADY_PROCESSED`; код `RECALL_FINISHED` (S6a, раздел 8; DECISIONS 2026-10-28 15:41).
25. Отмена и отзыв — одна транзакция: цепочка читается до блокировки, возврат к списанию корня даже без переносов, `occurredAt` и `cancelledAt` — один момент Clock (S6a, разделы 6 и 7).
26. Экран HR `/hr` в S6a — «Все заявки» с отзывом в строке; «Отменить» в «Моих заявках» только на странице «Отпуск», раздел HR на «Согласовании» остаётся на чтение (S6a; DECISIONS 2026-10-28 15:41).
27. Порядок проверок переноса: тело запроса, видимость и владелец раньше состояния исходного отпуска; исходный `CANCELLED`/`REPLACED` — `409 ALREADY_PROCESSED`, `PENDING`/`REJECTED` — `422 TRANSFER_SOURCE_NOT_APPROVED`; `TRANSFER_WORKDAYS_MISMATCH` с `details {old, requested}` (S6b, раздел 8; DECISIONS 2026-10-28 17:06).
28. Перенос не блокирует преемника при отмене и отзыве: наличие переноса «На согласовании» читается под блокировкой `User`, которая сериализует все операции сотрудника (S6b, раздел 6).
29. Интерфейс переноса: «Перенести» только в «Моих заявках» на странице «Отпуск», форма в строке (даты пустые, backstopper прежний), пометки в ячейке статуса через «·», на карточке согласования плашка «Перенос одобренного отпуска» без старых дат и «не проверяется (перенос)» вместо остатка (S6b; DECISIONS 2026-10-28 17:06).
30. Смена даты выхода: порядок `VALIDATION_FAILED → NOT_FOUND → FORBIDDEN` как у отзыва, та же дата - без записи и события, HR меняет дату и себе; маршруты в модуле `hr`, `User` пишет `org` (S6c, разделы 4, 7, 8; DECISIONS 2026-10-28 19:19).
31. При согласовании `VACATION_BEFORE_HIRE` повторно не проверяется, только остаток (S6c; DECISIONS 2026-10-28 19:19).
32. Экран HR в S6c: раздел «Остатки по сотрудникам» после «Все заявки», форма смены даты в строке, предупреждение при вводе, разовое сообщение только в состоянии страницы (DECISIONS 2026-10-28 19:19).
33. SSE: событие `clock.changed` после установки демо-часов и прохода планировщика, всем вошедшим; одна очередь событий на сервере; keep-alive 25 с; закрытие потока в момент `exp` токена; закрытие потоков при остановке и `enableShutdownHooks()` (S8, раздел 9; DECISIONS 2026-10-29 21:18, 22:26).
34. Демо-часы: без `DEMO_MODE` маршрут `/clock` закрывает `DemoOnlyMiddleware` раньше guard'ов, флаг читается из `APP_ENV`; `PUT /clock` проверяет дату через `parseApiDate` (годы 2000–2100, как все даты API) до перевода в момент UTC (S9-c, разделы 7, 8; DECISIONS 2026-10-30 14:24; аудит 3, F-4, F-11).
35. Комментарий заявки, переноса и решения не длиннее 400 единиц UTF-16, как `maxLength` браузера. `@MaxLength` не используется: он считает суррогатную пару за один символ. Длина проверяется до обрезки пробелов. Проверка в DTO (`MaxCommentLength`), поэтому `VALIDATION_FAILED` идёт первым (S9-d, разделы 7, 8; DECISIONS 2026-10-30 14:24, 21:41; аудит 3, F-7).

### Известные ограничения

- «Хотя бы один» пользователь без начальника БД не проверяет (seed и тест S3).
- `replacesId` неизменяем только по соглашению приложения.
- Дубль письма при сбое между ответом SMTP и пометкой `SENT` (транзакция прохода откатывается, строка остаётся `PENDING`).
- Отмена, пришедшая между проверкой статуса и отправкой напоминания, не остановит это письмо: статус отпуска читается без блокировки.
- Транзакция прохода диспетчера открыта на время отправки: при медленном SMTP `e2e:reset` (`TRUNCATE`) ждёт её окончания, до таймаутов SMTP.
- Напоминание, пропущенное (`SKIPPED`) из-за даты начала, не возвращается после отката демо-часов назад (§9-5).
- События при обрыве SSE не доставляются; после переподключения данные перечитываются полностью. Свой остаток на странице «Отпуск» после смены даты выхода виден после перехода или перезагрузки (DECISIONS 2026-10-29 21:41).
- Браузер держит не больше 6 соединений HTTP/1.1 к одному адресу на все вкладки профиля: седьмая вкладка приложения в одном браузере будет ждать (DECISIONS 2026-10-29 22:26).
- Неотправленное напоминание при смене руководителя не перенаправляется (смены руководителя в системе нет, только seed; DECISIONS 2026-10-29 10:49).
- События `seed:demo` публикуются в шину процесса seed, api их не получает. С S8 календари, открытые во время `seed:demo`, обновятся только после перезагрузки.
- Отмена заявки-переноса, когда старый отпуск уже начался, не проработана: действует буквальный текст §5 (ROADMAP, N4).
- Свой отпуск HR отзывает сам; передача этого права руководителю HR — «следующим заходом» (RULES §5-5, §11).
- Откат демо-часов не пересчитывает журнал (§9-5).
- HR меняет свою дату выхода без отдельного контроля (DECISIONS 2026-10-28 19:19).
- После сдвига даты выхода согласование не проверяет «начало не раньше даты выхода» (§3-12): отпуск, начавшийся раньше новой даты, может быть одобрен, если хватает остатка (DECISIONS 2026-10-28 19:19).
- Неизвестный маршрут без токена отвечает `404`, существующий `401`: по этому видны существующие маршруты. Контракт API открыт (этот документ), данных это не раскрывает; принято в S3, пересмотрено в S9 и оставлено (DECISIONS 2026-10-30 14:24, issue #2). Исключение — `/clock` без `DEMO_MODE`: `404` и без токена.
- Длина комментария ограничена только в API: в БД ограничения нет, seed и SQL в обход API его не соблюдают (S9-d).
