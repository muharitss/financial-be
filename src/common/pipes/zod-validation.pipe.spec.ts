import { describe, it, expect } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const schema = z.object({
    name: z.string().min(3),
    age: z.number().positive(),
  });

  const pipe = new ZodValidationPipe(schema);

  it('mengembalikan parsed data jika valid', () => {
    const input = { name: 'Budi', age: 20 };
    const result = pipe.transform(input);
    expect(result).toEqual(input);
  });

  it('melempar BadRequestException dengan VALIDATION_ERROR jika invalid', () => {
    const input = { name: 'A', age: -5 };
    expect(() => pipe.transform(input)).toThrow(BadRequestException);

    try {
      pipe.transform(input);
    } catch (err: any) {
      expect(err).toBeInstanceOf(BadRequestException);
      const res = err.getResponse();
      expect(res.code).toBe('VALIDATION_ERROR');
      expect(res.message).toBe('Data tidak valid');
      expect(res.details).toBeDefined();
      expect(res.details.name).toBeDefined();
      expect(res.details.age).toBeDefined();
    }
  });
});
