import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Public } from '../auth/public.decorator';
import {
  label,
  listRoutes,
  probeWithoutToken,
  type ProbedRoute,
} from '../testing/route-crawler';
import { createTestApp } from '../testing/test-app';
import { CommonModule } from './common.module';

const EXPECTED_PUBLIC = ['GET /config', 'GET /health', 'POST /auth/login'];

/**
 * Все маршруты api (аудит 3, F-12). Точный список: новый маршрут - осознанная правка этого
 * списка. /clock зарегистрирован и без DEMO_MODE, закрывает его DemoOnlyMiddleware.
 */
const EXPECTED_ROUTES = [
  'GET /approvals',
  'GET /calendar',
  'GET /clock',
  'GET /config',
  'GET /employees',
  'GET /events',
  'GET /health',
  'GET /hr/balances',
  'GET /me',
  'GET /me/balance',
  'GET /vacations',
  'GET /vacations/:id',
  'PATCH /employees/:id/hire-date',
  'POST /auth/login',
  'POST /vacations',
  'POST /vacations/:id/approve',
  'POST /vacations/:id/cancel',
  'POST /vacations/:id/recall',
  'POST /vacations/:id/reject',
  'POST /vacations/:id/transfer',
  'PUT /clock',
].sort();

const routeLabels = (app: INestApplication) =>
  listRoutes(app).map(label).sort();

/** Закрытые маршруты, которые без токена ответили не 401 AUTH_REQUIRED. */
const openRoutes = (probes: ProbedRoute[]) =>
  probes.filter(
    (p) => !p.isPublic && !(p.status === 401 && p.code === 'AUTH_REQUIRED'),
  );

const publicRoutes = (probes: ProbedRoute[]) =>
  probes
    .filter((p) => p.isPublic)
    .map(label)
    .sort();

describe('все маршруты закрыты (RULES §7-1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  afterAll(() => app.close());

  // RULES §7-1, §5-8, §7-3: краулер находит ровно эти маршруты, других нет
  it('краулер находит ровно маршруты api', () => {
    expect(routeLabels(app)).toEqual(EXPECTED_ROUTES);
  });

  // RULES §5-8 «Прямого изменения дат у HR нет»: отпуск меняют только подача, решение,
  // отмена, отзыв и перенос (новая заявка)
  it('маршрута правки дат отпуска нет', () => {
    expect(
      routeLabels(app).filter((r) =>
        /^(POST|PUT|PATCH|DELETE) \/vacations/.test(r),
      ),
    ).toEqual([
      'POST /vacations',
      'POST /vacations/:id/approve',
      'POST /vacations/:id/cancel',
      'POST /vacations/:id/recall',
      'POST /vacations/:id/reject',
      'POST /vacations/:id/transfer',
    ]);
  });

  // RULES §7-3 «управления составом из интерфейса нет»: у сотрудника меняется только дата выхода
  it('маршрута смены руководителя и состава команды нет', () => {
    expect(
      routeLabels(app).filter((r) => / \/(employees|me)(\/|$)/.test(r)),
    ).toEqual([
      'GET /employees',
      'GET /me',
      'GET /me/balance',
      'PATCH /employees/:id/hire-date',
    ]);
  });

  // RULES §7-1
  it('каждый закрытый маршрут без токена -> 401 AUTH_REQUIRED', async () => {
    const probes = await probeWithoutToken(app);
    expect(probes.length).toBeGreaterThan(0);
    expect(openRoutes(probes).map(label)).toEqual([]);
  });

  // RULES §7-1
  it('открытых маршрутов ровно три: login, config, health', async () => {
    expect(publicRoutes(await probeWithoutToken(app))).toEqual(
      [...EXPECTED_PUBLIC].sort(),
    );
  });

  // RULES §7-1: токен в URL не считается
  it('токен в query не открывает маршрут', async () => {
    const probes = await probeWithoutToken(app);
    expect(probes.find((p) => label(p) === 'GET /me')?.status).toBe(401);
  });
});

describe('без DEMO_MODE маршрута /clock нет (RULES §9-2)', () => {
  let off: INestApplication;

  beforeAll(async () => {
    off = await createTestApp({});
  });

  afterAll(() => off.close());

  // RULES §9-2: контроллер зарегистрирован, маршрут закрывает DemoOnlyMiddleware
  // (DECISIONS 2026-10-30 20:08), поэтому список тот же, что с DEMO_MODE
  it('краулер находит те же маршруты, что с DEMO_MODE', () => {
    expect(routeLabels(off)).toEqual(EXPECTED_ROUTES);
  });

  const answer = async (method: 'get' | 'put', path: string, auth?: string) => {
    let req = request(off.getHttpServer() as App)[method](path);
    if (auth) req = req.set('Authorization', auth);
    const res = await req;
    return { status: res.status, body: res.body as unknown };
  };

  // RULES §9-2, §7-1: аудит 3, F-11 — без токена, как неизвестный маршрут
  it.each(['get', 'put'] as const)(
    '%s /clock без токена -> 404, как неизвестный маршрут',
    async (method) => {
      const unknown = await answer(method, '/no-such-route');
      expect(unknown.status).toBe(404);
      expect(await answer(method, '/clock')).toEqual(unknown);
    },
  );

  // RULES §9-2: токен не проверяется, маршрута нет
  it.each(['get', 'put'] as const)(
    '%s /clock с недействительным токеном -> 404, как неизвестный маршрут',
    async (method) => {
      const unknown = await answer(method, '/no-such-route', 'Bearer x');
      expect(await answer(method, '/clock', 'Bearer x')).toEqual(unknown);
    },
  );

  // RULES §7-1: остальные маршруты без флага не задеты
  it('прочие закрытые маршруты без токена -> 401, открытых ровно три', async () => {
    const probes = (await probeWithoutToken(off)).filter(
      (p) => p.path !== '/clock',
    );
    expect(openRoutes(probes).map(label)).toEqual([]);
    expect(publicRoutes(probes)).toEqual([...EXPECTED_PUBLIC].sort());
  });
});

describe('краулер ловит нарушения', () => {
  @Controller('leaky')
  class Leaky {
    @Get()
    read() {
      return { secret: 1 };
    }

    @Public()
    @Post()
    extraPublic() {
      return {};
    }
  }

  // RULES §7-1
  it('приложение без guard: закрытый маршрут отвечает не 401', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule, DiscoveryModule],
      controllers: [Leaky],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const probes = await probeWithoutToken(app);
      expect(openRoutes(probes).map(label)).toEqual(['GET /leaky']);
    } finally {
      await app.close();
    }
  });

  // RULES §7-1
  it('лишний @Public меняет множество открытых маршрутов', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule, DiscoveryModule],
      controllers: [Leaky],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const probes = await probeWithoutToken(app);
      expect(publicRoutes(probes)).not.toEqual([...EXPECTED_PUBLIC].sort());
      expect(publicRoutes(probes)).toEqual(['POST /leaky']);
    } finally {
      await app.close();
    }
  });
});
