import { describe, it, expect } from 'vitest';
import { adminProductUrl } from '../../src/format/helpers';

describe('adminProductUrl', () => {
  it('is an in-admin deep link', () => {
    expect(adminProductUrl('gid://shopify/Product/123', 'shop.example.com')).toBe('shopify://admin/products/123');
  });
  it('is null for anything that is not a product id', () => {
    expect(adminProductUrl('gid://shopify/Collection/1', 'x')).toBeNull();
    expect(adminProductUrl('nope', 'x')).toBeNull();
  });
});
