-- CreateEnum
CREATE TYPE "VacationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REPLACED');

-- CreateEnum
CREATE TYPE "LedgerKind" AS ENUM ('DEBIT', 'REFUND');

-- CreateEnum
CREATE TYPE "MailType" AS ENUM ('NEW_REQUEST', 'DECISION', 'REMINDER');

-- CreateEnum
CREATE TYPE "MailStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED');

-- DropTable
DROP TABLE "AppMeta";

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "login" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "hireDate" DATE NOT NULL,
    "managerId" INTEGER,
    "teamName" TEXT,
    "isHr" BOOLEAN NOT NULL DEFAULT false,
    "accessGranted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vacation" (
    "id" SERIAL NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "backstopperId" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "workDays" INTEGER NOT NULL,
    "status" "VacationStatus" NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "replacesId" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedById" INTEGER,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionComment" TEXT,
    "cancelledById" INTEGER,
    "cancelledAt" TIMESTAMPTZ(3),
    "returnDate" DATE,

    CONSTRAINT "Vacation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" SERIAL NOT NULL,
    "kind" "LedgerKind" NOT NULL,
    "vacationId" INTEGER NOT NULL,
    "refundOfId" INTEGER,
    "halfDays" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" SERIAL NOT NULL,
    "type" "MailType" NOT NULL,
    "vacationId" INTEGER NOT NULL,
    "recipientId" INTEGER NOT NULL,
    "status" "MailStatus" NOT NULL DEFAULT 'PENDING',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClockState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "instant" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClockState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- CreateIndex
CREATE INDEX "Vacation_employeeId_status_startDate_endDate_idx" ON "Vacation"("employeeId", "status", "startDate", "endDate");

-- CreateIndex
CREATE INDEX "Vacation_status_startDate_idx" ON "Vacation"("status", "startDate");

-- CreateIndex
CREATE INDEX "Vacation_replacesId_idx" ON "Vacation"("replacesId");

-- CreateIndex
CREATE INDEX "LedgerEntry_vacationId_idx" ON "LedgerEntry"("vacationId");

-- CreateIndex
CREATE INDEX "LedgerEntry_refundOfId_idx" ON "LedgerEntry"("refundOfId");

-- CreateIndex
CREATE INDEX "OutboxMessage_status_nextAttemptAt_idx" ON "OutboxMessage"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxMessage_type_vacationId_recipientId_key" ON "OutboxMessage"("type", "vacationId", "recipientId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_backstopperId_fkey" FOREIGN KEY ("backstopperId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "Vacation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_vacationId_fkey" FOREIGN KEY ("vacationId") REFERENCES "Vacation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_refundOfId_fkey" FOREIGN KEY ("refundOfId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_vacationId_fkey" FOREIGN KEY ("vacationId") REFERENCES "Vacation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Ограничения, которые Prisma не выражает (S1, architecture.md). Имена ограничений
-- используются в integration-тестах.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---- User -------------------------------------------------------------------
-- RULES §7: ровно один пользователь без начальника. БД гарантирует «не больше одного»;
-- «хотя бы один» проверяют seed и тест (S3).
CREATE UNIQUE INDEX "User_single_root_idx" ON "User" ((true)) WHERE "managerId" IS NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_not_own_manager_chk" CHECK ("managerId" IS NULL OR "managerId" <> "id");

-- ---- Vacation ---------------------------------------------------------------
-- RULES §3-4 (дробление): начало не позже конца; одна заявка — один календарный год;
-- минимум 1 рабочий день; backstopper — не сам заявитель.
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_dates_order_chk" CHECK ("startDate" <= "endDate");
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_one_year_chk"
  CHECK (EXTRACT(YEAR FROM "startDate") = EXTRACT(YEAR FROM "endDate"));
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_work_days_chk" CHECK ("workDays" >= 1);
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_backstopper_not_self_chk" CHECK ("backstopperId" <> "employeeId");
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_not_replaces_self_chk" CHECK ("replacesId" IS NULL OR "replacesId" <> "id");

-- RULES §3-4: нет пересечения одобренных отпусков одного сотрудника. «На согласовании»
-- проверяет приложение под блокировкой: перенос (§5-2) пересекается со старым отпуском.
-- Утверждение переноса: сначала старый -> REPLACED, потом новый -> APPROVED (одна транзакция).
ALTER TABLE "Vacation" ADD CONSTRAINT "Vacation_no_approved_overlap_excl"
  EXCLUDE USING gist ("employeeId" WITH =, daterange("startDate", "endDate", '[]') WITH &&)
  WHERE (status = 'APPROVED');

-- RULES §5-2: у отпуска один действующий преемник (ожидающий или утверждённый перенос).
CREATE UNIQUE INDEX "Vacation_single_live_successor_idx" ON "Vacation" ("replacesId")
  WHERE "replacesId" IS NOT NULL AND status IN ('PENDING', 'APPROVED');

-- ---- LedgerEntry ------------------------------------------------------------
-- RULES §6-6, §6-8: списание — без ссылки, > 0; возврат — всегда со ссылкой на списание, >= 0.
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_kind_shape_chk" CHECK (
  (kind = 'DEBIT'  AND "refundOfId" IS NULL     AND "halfDays" > 0) OR
  (kind = 'REFUND' AND "refundOfId" IS NOT NULL AND "halfDays" >= 0)
);
-- Одно списание и один возврат на заявку («уже обработана», RULES §10-1).
CREATE UNIQUE INDEX "LedgerEntry_one_debit_per_vacation_idx" ON "LedgerEntry" ("vacationId") WHERE kind = 'DEBIT';
CREATE UNIQUE INDEX "LedgerEntry_one_refund_per_vacation_idx" ON "LedgerEntry" ("vacationId") WHERE kind = 'REFUND';

-- RULES §5-12, §6-8: возврат ссылается на списание корня цепочки своей заявки,
-- сумма возвратов по списанию не больше списанного. FOR UPDATE на списание
-- сериализует параллельные возвраты.
CREATE FUNCTION "ledger_refund_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debit RECORD;
  root_id INTEGER;
  refunded INTEGER;
BEGIN
  IF NEW.kind <> 'REFUND' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO debit FROM "LedgerEntry" WHERE id = NEW."refundOfId" FOR UPDATE;
  IF NOT FOUND OR debit.kind <> 'DEBIT' THEN
    RAISE EXCEPTION 'refund must reference a debit entry' USING ERRCODE = 'check_violation';
  END IF;

  -- UNION (не ALL): цикл replacesId не зациклит запрос
  WITH RECURSIVE chain AS (
    SELECT id, "replacesId" FROM "Vacation" WHERE id = NEW."vacationId"
    UNION
    SELECT v.id, v."replacesId" FROM "Vacation" v JOIN chain c ON v.id = c."replacesId"
  )
  SELECT id INTO root_id FROM chain WHERE "replacesId" IS NULL;

  IF root_id IS DISTINCT FROM debit."vacationId" THEN
    RAISE EXCEPTION 'refund must reference the debit of the chain root (vacation %, root %, debit of %)',
      NEW."vacationId", root_id, debit."vacationId" USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(SUM("halfDays"), 0) INTO refunded
    FROM "LedgerEntry" WHERE "refundOfId" = NEW."refundOfId" AND id IS DISTINCT FROM NEW.id;
  IF refunded + NEW."halfDays" > debit."halfDays" THEN
    RAISE EXCEPTION 'refunds (% + %) exceed the debit (%)', refunded, NEW."halfDays", debit."halfDays"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "LedgerEntry_refund_guard"
  BEFORE INSERT OR UPDATE OF kind, "refundOfId", "vacationId", "halfDays" ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "ledger_refund_guard"();

-- ---- OutboxMessage ----------------------------------------------------------
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_attempts_chk" CHECK (attempts >= 0);

-- ---- ClockState -------------------------------------------------------------
-- RULES §9-2: состояние демо-часов — одна строка.
ALTER TABLE "ClockState" ADD CONSTRAINT "ClockState_single_row_chk" CHECK (id = 1);
