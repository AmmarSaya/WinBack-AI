/**
 * Local Shopify Session shape, intentionally compatible with
 * `@shopify/shopify-api`'s `Session` class via structural typing. C1 keeps
 * Shopify SDK dependencies out of the workspace; C2 (Remix routes) will
 * bring `@shopify/shopify-api` in and pass its Session objects into our
 * EncryptedSessionStorage — they'll satisfy this shape.
 *
 * `accessToken` is plaintext in memory (the Shopify SDK expects it that
 * way). The storage layer encrypts at write and decrypts at read.
 */
export interface ShopifySession {
  readonly id: string;
  readonly shop: string;
  readonly state: string;
  readonly isOnline: boolean;
  readonly scope?: string | undefined;
  readonly expires?: Date | undefined;
  readonly accessToken?: string | undefined;
  readonly userId?: string | number | bigint | undefined;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly email?: string | undefined;
  readonly accountOwner?: boolean | undefined;
  readonly locale?: string | undefined;
  readonly collaborator?: boolean | undefined;
  readonly emailVerified?: boolean | undefined;
}

/**
 * Matches the Shopify `SessionStorage` interface from
 * `@shopify/shopify-app-session-storage`. We define it locally so C1 has
 * no runtime Shopify dependency. C2's Shopify SDK integration will see
 * `EncryptedSessionStorage` as structurally satisfying their interface.
 */
export interface SessionStorage {
  storeSession(session: ShopifySession): Promise<boolean>;
  loadSession(id: string): Promise<ShopifySession | undefined>;
  deleteSession(id: string): Promise<boolean>;
  deleteSessions(ids: string[]): Promise<boolean>;
  findSessionsByShop(shop: string): Promise<ShopifySession[]>;
}
