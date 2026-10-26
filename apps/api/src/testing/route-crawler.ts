/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
// Краулер маршрутов: обходит все контроллеры приложения и без токена вызывает каждый маршрут
// (RULES §7-1: «все маршруты закрыты, открытые помечены @Public()»).
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import request from 'supertest';
import { IS_PUBLIC } from '../auth/public.decorator';

export interface CrawledRoute {
  method: string;
  path: string;
  isPublic: boolean;
}

export interface ProbedRoute extends CrawledRoute {
  status: number;
  code?: string;
}

const join = (...parts: string[]) =>
  '/' +
  parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

export function listRoutes(app: INestApplication): CrawledRoute[] {
  const discovery = app.get(DiscoveryService, { strict: false });
  const scanner = new MetadataScanner();
  const routes: CrawledRoute[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const base = Reflect.getMetadata(PATH_METADATA, metatype) as
      string | string[] | undefined;
    const proto = Object.getPrototypeOf(instance) as object;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined) continue;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as
        string | string[] | undefined;
      const isPublic =
        Reflect.getMetadata(IS_PUBLIC, handler) === true ||
        Reflect.getMetadata(IS_PUBLIC, metatype) === true;
      routes.push({
        method: RequestMethod[method],
        path: join(String(base ?? ''), String(sub ?? '')),
        isPublic,
      });
    }
  }
  return routes;
}

/** Вызывает каждый маршрут без токена и без тела. */
export async function probeWithoutToken(
  app: INestApplication,
): Promise<ProbedRoute[]> {
  const out: ProbedRoute[] = [];
  for (const r of listRoutes(app)) {
    const url = r.path.replace(/:\w+/g, '1');
    const agent = request(app.getHttpServer());
    const m = r.method.toLowerCase() as
      'get' | 'post' | 'put' | 'patch' | 'delete';
    const res = await agent[m](url);
    out.push({
      ...r,
      status: res.status,
      code: (res.body as { code?: string }).code,
    });
  }
  return out;
}

export const label = (r: CrawledRoute) => `${r.method} ${r.path}`;
