import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
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

  // RULES §7-1
  it('краулер находит маршруты S3 и S4', () => {
    const found = listRoutes(app).map(label);
    expect(found).toEqual(
      expect.arrayContaining([
        'POST /auth/login',
        'GET /config',
        'GET /health',
        'GET /me',
        'GET /clock',
        'PUT /clock',
        'GET /employees',
        'GET /me/balance',
        'GET /vacations',
        'GET /vacations/:id',
      ]),
    );
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

  // RULES §7-2, §9-2: Q3 — сначала проверка токена, потом 404 про /clock
  it('/clock без флага и без токена -> 401', async () => {
    const off = await createTestApp({});
    try {
      const probes = await probeWithoutToken(off);
      const clock = probes.filter((p) => p.path === '/clock');
      expect(clock.map((p) => p.status)).toEqual([401, 401]);
    } finally {
      await off.close();
    }
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
