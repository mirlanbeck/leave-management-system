/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import {
  Body,
  Controller,
  Get,
  HttpException,
  INestApplication,
  Logger,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString } from 'class-validator';
import request from 'supertest';
import { CommonModule } from './common.module';
import { ApiError } from './problem';

class EchoDto {
  @IsString()
  name!: string;

  @IsInt()
  age!: number;
}

@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() dto: EchoDto) {
    return dto;
  }

  @Get('api-error')
  apiError(): never {
    throw new ApiError(422, 'VACATION_OVERLAP', 'Пересечение', { from: 'x' });
  }

  @Get('too-large')
  tooLarge(): never {
    throw new HttpException('Слишком большой', 413);
  }

  @Get('boom')
  boom(): never {
    throw new Error('секрет внутри: password=hunter2');
  }
}

describe('формат ошибок Problem', () => {
  let app: INestApplication;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [CommonModule],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  // RULES §7-1
  it('ApiError отдаёт statusCode, code, message, details', async () => {
    const res = await request(app.getHttpServer()).get('/probe/api-error');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      statusCode: 422,
      code: 'VACATION_OVERLAP',
      message: 'Пересечение',
      details: { from: 'x' },
    });
  });

  // RULES §3-2
  it('битый JSON -> 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  // RULES §3-2
  it('неверный тип поля -> 400 VALIDATION_FAILED с details.fields', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ name: 'a', age: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.details.fields)).toEqual(['age']);
  });

  // RULES §3-2
  it('лишнее поле отклоняется (400, details.fields)', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ name: 'a', age: 1, isHr: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.details.fields)).toEqual(['isHr']);
  });

  // RULES §7-2
  it('неизвестный маршрут -> 404 NOT_FOUND', async () => {
    const res = await request(app.getHttpServer()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  // RULES §7-1
  it('500 без code, без стека и без текста внутренней ошибки', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      statusCode: 500,
      message: 'Внутренняя ошибка сервера',
    });
    expect(res.text).not.toContain('hunter2');
  });

  // RULES §7-1
  it('статус вне каталога (413) -> {statusCode, message} без code', async () => {
    const res = await request(app.getHttpServer()).get('/probe/too-large');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'Слишком большой' });
  });
});
