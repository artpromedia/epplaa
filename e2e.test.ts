import { test, expect } from '@playwright/test';

test('Epplaa E2E Journey', async ({ page }) => {
  // 1. Navigate to /profile
  await page.goto('http://localhost:80/profile');
  await expect(page).toHaveURL(/.*\/profile/);
  console.log('Step 1: PASS');

  // 2. Click "Payment Methods" row. Verify it routes to /account/payment-methods and shows "No saved methods yet".
  await page.click('data-testid=link-payment-methods');
  await expect(page).toHaveURL(/.*\/account\/payment-methods/);
  await expect(page.locator('text=No saved methods yet')).toBeVisible();
  console.log('Step 2: PASS');

  // 3. Click "Add payment method". Verify the form appears with the country's payment method options.
  await page.click('data-testid=button-add-payment');
  await expect(page.locator('data-testid=select-method-paystack-card')).toBeVisible();
  await expect(page.locator('data-testid=select-method-flutterwave-bank')).toBeVisible();
  await expect(page.locator('data-testid=select-method-ussd')).toBeVisible();
  await expect(page.locator('data-testid=select-method-cod')).toBeVisible();
  console.log('Step 3: PASS');

  // 4. Select "Card via Paystack", type "4242424242424242" in the detail input, click Save.
  await page.click('data-testid=select-method-paystack-card');
  await page.fill('data-testid=input-payment-detail', '4242424242424242');
  await page.click('data-testid=button-save-payment');
  console.log('Step 4: PASS');

  // 5. Verify the saved method appears in the list as "Card via Paystack" with detail "•••• 4242".
  await expect(page.locator('text=Card via Paystack')).toBeVisible();
  await expect(page.locator('text=•••• 4242')).toBeVisible();
  console.log('Step 5: PASS');

  // 6. Reload the page. Verify the saved method persists.
  await page.reload();
  await expect(page.locator('text=Card via Paystack')).toBeVisible();
  await expect(page.locator('text=•••• 4242')).toBeVisible();
  console.log('Step 6: PASS');

  // 7. Click the trash icon on the saved method. Verify it disappears and the empty state returns.
  // The id is dynamic so we use a partial match on the testid or the trash icon within the row
  await page.click('button[data-testid^="remove-payment-"]');
  await expect(page.locator('text=No saved methods yet')).toBeVisible();
  console.log('Step 7: PASS');

  // 8. Click the back chevron in the header. Verify it routes back to /profile.
  await page.click('data-testid=button-back');
  await expect(page).toHaveURL(/.*\/profile/);
  console.log('Step 8: PASS');

  // 9. Click "Addresses" row. Routes to /account/addresses, shows "No saved addresses yet".
  await page.click('data-testid=link-addresses');
  await expect(page).toHaveURL(/.*\/account\/addresses/);
  await expect(page.locator('text=No saved addresses yet')).toBeVisible();
  console.log('Step 9: PASS');

  // 10. Click "Add address". Fill in label="Home", recipient="Ada O.", line="14 Marina Rd", city="Lagos", phone="+2348012345678". Click Save.
  await page.click('data-testid=button-add-address');
  await page.fill('data-testid=input-label', 'Home');
  await page.fill('data-testid=input-recipient', 'Ada O.');
  await page.fill('data-testid=input-line', '14 Marina Rd');
  await page.fill('data-testid=input-city', 'Lagos');
  await page.fill('data-testid=input-phone', '+2348012345678');
  await page.click('data-testid=button-save-address');
  console.log('Step 10: PASS');

  // 11. Verify the address appears with a "DEFAULT" badge.
  await expect(page.locator('text=Home')).toBeVisible();
  await expect(page.locator('text=DEFAULT')).toBeVisible();
  console.log('Step 11: PASS');

  // 12. Reload. Verify it persists.
  await page.reload();
  await expect(page.locator('text=Home')).toBeVisible();
  await expect(page.locator('text=DEFAULT')).toBeVisible();
  console.log('Step 12: PASS');

  // 13. Click back, click "Settings". Verify it routes to /account/settings.
  await page.click('data-testid=button-back');
  await page.click('data-testid=link-settings');
  await expect(page).toHaveURL(/.*\/account\/settings/);
  console.log('Step 13: PASS');

  // 14. Verify the three notification toggles render (Live drops, Order updates ON; Promos & marketing OFF).
  const liveDrops = page.locator('data-testid=switch-live-drops');
  const orderUpdates = page.locator('data-testid=switch-order-updates');
  const marketing = page.locator('data-testid=switch-marketing');
  
  await expect(liveDrops).toHaveAttribute('aria-checked', 'true');
  await expect(orderUpdates).toHaveAttribute('aria-checked', 'true');
  await expect(marketing).toHaveAttribute('aria-checked', 'false');
  console.log('Step 14: PASS');

  // 15. Toggle "Promos & marketing" on, reload, verify it stayed on.
  await marketing.click();
  await expect(marketing).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(page.locator('data-testid=switch-marketing')).toHaveAttribute('aria-checked', 'true');
  console.log('Step 15: PASS');

  // 16. Click "Clear local data", confirm in the modal, verify the page reloads and saved data reset to defaults.
  await page.click('data-testid=button-clear-data');
  await page.click('data-testid=button-confirm-clear');
  // After reload, we should be back at defaults. 
  // Marketing should be back to false.
  await expect(page.locator('data-testid=switch-marketing')).toHaveAttribute('aria-checked', 'false');
  // Check that country is still NG (default) or at least available
  await expect(page.locator('data-testid=settings-region')).toContainText('Nigeria');
  console.log('Step 16: PASS');
});
