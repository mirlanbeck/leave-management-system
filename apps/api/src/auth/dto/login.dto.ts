import { IsNotEmpty, IsString, ValidateBy } from 'class-validator';
import { PASSWORD_MAX_BYTES } from '../password';

/** Длина в байтах UTF-8, а не в символах: кириллица занимает 2 байта (RULES §7-1). */
function MaxUtf8Bytes(max: number) {
  return ValidateBy({
    name: 'maxUtf8Bytes',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
      defaultMessage: (args) =>
        `${args?.property}: не длиннее ${max} байт (латиница — до ${max} символов, кириллица — до ${max / 2})`,
    },
  });
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  login!: string;

  @IsString()
  @IsNotEmpty()
  @MaxUtf8Bytes(PASSWORD_MAX_BYTES)
  password!: string;
}
