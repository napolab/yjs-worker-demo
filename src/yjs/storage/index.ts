import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";

import { storageKey } from "./storage-key";

import type { TransactionStorage } from "./type";

interface YTransactionStorage {
  getYDoc(): Promise<Doc>;
  storeUpdate(update: Uint8Array): Promise<void>;
  commit(): Promise<void>;
}

type Options = {
  maxBytes?: number;
  maxUpdates?: number;
};

export class YTransactionStorageImpl implements YTransactionStorage {
  private readonly MAX_BYTES: number;
  private readonly MAX_UPDATES: number;

  // eslint-disable-next-line no-useless-constructor
  constructor(
    private readonly storage: TransactionStorage,
    options?: Options,
  ) {
    this.MAX_BYTES = options?.maxBytes ?? 1024 * 1024 * 1;

    this.MAX_UPDATES = options?.maxUpdates ?? 500;
  }

  async getYDoc(): Promise<Doc> {
    try {
      const snapshot = await this.storage.get<Uint8Array>(
        storageKey({ type: "state", name: "doc" }),
      );
      const data = await this.storage.list<Uint8Array>({
        prefix: storageKey({ type: "update" }),
      });
      console.log(
        "snapshot instanceof Uint8Array:",
        snapshot instanceof Uint8Array,
        "snapshot undefined",
        snapshot === undefined,
        "data instanceof Map:",
        Array.from(data.values()).map((v) => v instanceof Uint8Array),
      );

      const updates: Uint8Array[] = Array.from(data.values());
      const doc = new Doc();

      doc.transact(() => {
        if (snapshot) {
          applyUpdate(doc, snapshot);
        }
        for (const update of updates) {
          applyUpdate(doc, update);
        }
      });

      return doc;
    } catch (e) {
      throw new Error("getYDoc error", { cause: e });
    }
  }

  storeUpdate(update: Uint8Array): Promise<void> {
    return this.storage.transaction(async (tx) => {
      const bytes =
        (await tx.get<number>(storageKey({ type: "state", name: "bytes" }))) ??
        0;
      const count =
        (await tx.get<number>(storageKey({ type: "state", name: "count" }))) ??
        0;

      const updateBytes = bytes + update.byteLength;
      const updateCount = count + 1;

      if (updateBytes > this.MAX_BYTES || updateCount > this.MAX_UPDATES) {
        const doc = await this.getYDoc();
        applyUpdate(doc, update);

        await this._commit(doc, tx);
      } else {
        await tx.put(storageKey({ type: "state", name: "bytes" }), updateBytes);
        await tx.put(storageKey({ type: "state", name: "count" }), updateCount);
        await tx.put(storageKey({ type: "update", name: updateCount }), update);
      }
    });
  }

  private async _commit(doc: Doc, tx: Omit<TransactionStorage, "transaction">) {
    try {
      const data = await tx.list<Uint8Array>({
        prefix: storageKey({ type: "update" }),
      });

      await tx.delete(Array.from(data.keys()));

      for (const update of data.values()) {
        applyUpdate(doc, update);
      }

      const update = encodeStateAsUpdate(doc);
      console.log("update:", update.byteLength, update instanceof Uint8Array);
      await tx.put(storageKey({ type: "state", name: "bytes" }), 0);
      await tx.put(storageKey({ type: "state", name: "count" }), 0);
      await tx.put(storageKey({ type: "state", name: "doc" }), update);
    } catch (e) {
      throw new Error("commit error", { cause: e });
    }
  }

  async commit(): Promise<void> {
    const doc = await this.getYDoc();

    return this.storage.transaction(async (tx) => {
      await this._commit(doc, tx);
    });
  }
}
