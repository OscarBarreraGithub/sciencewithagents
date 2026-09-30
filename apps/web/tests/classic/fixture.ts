import { test as base } from '@playwright/test';
export * from '@playwright/test';

// Historic behavior remains testable during the screen-by-screen rebuild.
// This selects the retained interface; it does not bypass authentication.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.addInitScript(() => sessionStorage.setItem('dock:workspace-ui', 'classic'));
    await use(context);
  },
});
