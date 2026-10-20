// Adapter: node-redis → Store iz @klaka/sdk-node. Isto bi radilo i sa ioredis-om.

import { createClient } from "redis";

import type { Store } from "@klaka/sdk-node";

export async function valkeyStore(url: string): Promise<Store> {
  // Bez reda dok veza ne postoji: komanda odmah pada, SDK to tretira kao „Valkey nedostupan".
  const client = createClient({ url, disableOfflineQueue: true });
  client.on("error", (e: Error) => console.warn(`valkey: ${e.message}`));
  await client.connect().catch((e: Error) => console.warn(`valkey nedostupan (${url}): ${e.message}`));

  return {
    async incr(key, ttlMs) {
      const [n] = await client.multi().incr(key).pExpire(key, ttlMs, "NX").exec();
      return Number(n);
    },
    async setNx(key, ttlMs) {
      return (await client.set(key, "1", { NX: true, PX: ttlMs })) === "OK";
    },
    async mget(keys) {
      return client.mGet(keys);
    },
  };
}
