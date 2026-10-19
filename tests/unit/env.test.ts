import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('aplica valores por defecto seguros', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      HOST: '127.0.0.1',
      PORT: 3000,
      DEFAULT_TARGET_MARGIN_PERCENT: 30,
      DEFAULT_MAX_DELIVERY_DAYS: 7,
      DEFAULT_REQUIRED_ORIGIN_COUNTRY: 'US',
    });
  });

  it('convierte tipos y normaliza el país', () => {
    const config = loadConfig({
      PORT: '4000',
      DEFAULT_TARGET_MARGIN_PERCENT: '35.5',
      DEFAULT_REQUIRED_ORIGIN_COUNTRY: 'us',
    });
    expect(config.PORT).toBe(4000);
    expect(config.DEFAULT_TARGET_MARGIN_PERCENT).toBe(35.5);
    expect(config.DEFAULT_REQUIRED_ORIGIN_COUNTRY).toBe('US');
  });

  it('permite desactivar la regla de país con NONE', () => {
    expect(
      loadConfig({ DEFAULT_REQUIRED_ORIGIN_COUNTRY: 'NONE' }).DEFAULT_REQUIRED_ORIGIN_COUNTRY,
    ).toBeNull();
  });

  it('falla con mensaje claro ante valores inválidos', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ DEFAULT_TARGET_MARGIN_PERCENT: '100' })).toThrow(
      /DEFAULT_TARGET_MARGIN_PERCENT/,
    );
    expect(() => loadConfig({ DEFAULT_REQUIRED_ORIGIN_COUNTRY: 'USA' })).toThrow(ConfigError);
  });
});
