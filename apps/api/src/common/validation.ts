import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ApiError, MESSAGES } from './problem';

function collect(
  errors: ValidationError[],
  fields: Record<string, string[]>,
  prefix = '',
): void {
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    if (e.constraints) fields[path] = Object.values(e.constraints);
    if (e.children?.length) collect(e.children, fields, path);
  }
}

/** Белый список полей; лишние поля отклоняются (RULES §3-2, architecture §8). */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => {
      const fields: Record<string, string[]> = {};
      collect(errors, fields);
      return new ApiError(
        400,
        'VALIDATION_FAILED',
        MESSAGES.VALIDATION_FAILED,
        {
          fields,
        },
      );
    },
  });
}
