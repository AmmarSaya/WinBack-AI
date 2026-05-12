import { Prisma } from '@prisma/client';

import { applyReadHooks, applyWriteHooks, type ReadArgs, type WriteArgs } from './hooks.js';

/**
 * The single Prisma Client Extension for the @winback platform.
 *
 * Wiring only — all logic lives in `./hooks.ts` so it can be unit-tested
 * without a Prisma client. Adding a behavior means editing `hooks.ts`, not
 * this file; this file's structure is fixed.
 *
 * Composition (handled inside `applyReadHooks` / `applyWriteHooks`):
 *   1. Tenant-scope assertion — reads AND writes.
 *   2. Soft-delete filter — reads on Customer / Product / ProductVariant.
 *   3. AiTone zod validation — writes on MerchantSettings.aiTone.
 *
 * Audit hooks are deferred to D2 — see hooks.ts header comment.
 */
export const winbackExtension = Prisma.defineExtension({
  name: 'winback',
  query: {
    $allModels: {
      // -------- reads --------
      async findMany({ model, args, query }) {
        return query(applyReadHooks(model, args as ReadArgs) as typeof args);
      },
      async findFirst({ model, args, query }) {
        return query(applyReadHooks(model, args as ReadArgs) as typeof args);
      },
      async findFirstOrThrow({ model, args, query }) {
        return query(applyReadHooks(model, args as ReadArgs) as typeof args);
      },
      async findUnique({ model, args, query }) {
        return query(
          applyReadHooks(model, args as ReadArgs, { findUnique: true }) as typeof args,
        );
      },
      async findUniqueOrThrow({ model, args, query }) {
        return query(
          applyReadHooks(model, args as ReadArgs, { findUnique: true }) as typeof args,
        );
      },
      async count({ model, args, query }) {
        return query(applyReadHooks(model, args as ReadArgs) as typeof args);
      },
      async aggregate({ model, args, query }) {
        return query(applyReadHooks(model, args as ReadArgs) as typeof args);
      },
      async groupBy({ model, args, query }) {
        return query(applyReadHooks(model, args as ReadArgs) as typeof args);
      },

      // -------- writes --------
      async create({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'create') as typeof args);
      },
      async createMany({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'createMany') as typeof args);
      },
      async update({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'update') as typeof args);
      },
      async updateMany({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'updateMany') as typeof args);
      },
      async upsert({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'upsert') as typeof args);
      },
      async delete({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'delete') as typeof args);
      },
      async deleteMany({ model, args, query }) {
        return query(applyWriteHooks(model, args as WriteArgs, 'deleteMany') as typeof args);
      },
    },
  },
});
