import { AppModule } from '../src/app.module.js';

describe('Smoke E2E', () => {
  it('should define AppModule', () => {
    expect(AppModule).toBeDefined();
  });
});
