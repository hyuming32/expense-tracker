import type { EntityTable, IDType } from 'dexie';
import { db, type ExpenseDatabase, META_KEYS } from '../db/database';
import type {
  Account,
  BaseRecord,
  Budget,
  Category,
  CurrencyRate,
  LotteryDraw,
  NoSpendDay,
  NotePreset,
  OutboxEntry,
  Place,
  RecurringRule,
  Shortcut,
  Transaction,
  WalletCard,
} from '../db/types';
import type { DriveFile, DriveStore } from './driveStore';
import { mergeRecord } from './merge';

export const DEFAULT_SNAPSHOT_THRESHOLD = 200;
const SNAPSHOT_FILE_NAME = 'snapshot.json';
const CHANGE_PATH_REGEX = /^changes\/([^/]+)\/(\d+)\.json$/;

export interface SyncRecordsPayload {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  notePresets?: NotePreset[];
  recurringRules?: RecurringRule[];
  shortcuts?: Shortcut[];
  places?: Place[];
  lotteryDraws?: LotteryDraw[];
  budgets?: Budget[];
  noSpendDays?: NoSpendDay[];
  cards?: WalletCard[];
  currencies?: CurrencyRate[];
}

export interface ChangeBatchFile {
  deviceId: string;
  seq: number;
  createdAt: number;
  records: SyncRecordsPayload;
}

export interface SnapshotFile {
  createdAt: number;
  includes: Record<string, number>;
  records: SyncRecordsPayload;
}

export interface SyncOnceOptions {
  database?: ExpenseDatabase;
  driveStore: DriveStore;
  deviceId: string;
  snapshotThreshold?: number;
}

export interface SyncOnceResult {
  uploadedCount: number;
  downloadedChanges: number;
  usedSnapshot: boolean;
  compacted: boolean;
  lastSyncAt: number;
  appliedRecordsCount: number;
  appliedTransactionsCount: number;
}

interface ParsedChangeFile {
  file: DriveFile;
  deviceId: string;
  seq: number;
}

function parseChangePath(name: string): { deviceId: string; seq: number } | null {
  const match = CHANGE_PATH_REGEX.exec(name);
  if (!match) {
    return null;
  }
  const deviceId = match[1];
  const seq = Number(match[2]);
  if (!deviceId || !Number.isInteger(seq) || seq <= 0) {
    return null;
  }
  return { deviceId, seq };
}

async function readMetaNumber(database: ExpenseDatabase, key: string): Promise<number> {
  const entry = await database.meta.get(key);
  if (!entry) {
    return 0;
  }
  const num = Number(entry.value);
  return Number.isFinite(num) ? num : 0;
}

async function mergeTableRecords<T extends BaseRecord>(
  table: EntityTable<T, 'id'>,
  incoming: readonly T[],
): Promise<T[]> {
  if (incoming.length === 0) {
    return [];
  }
  const ids = incoming.map((item) => item.id) as Array<IDType<T, 'id'>>;
  const existingList = await table.bulkGet(ids);
  const winners: T[] = [];

  for (let i = 0; i < incoming.length; i++) {
    const remote = incoming[i];
    if (!remote) {
      continue;
    }
    const local = existingList[i] as T | undefined;
    const winner = mergeRecord(local, remote);
    if (winner === remote) {
      winners.push(winner);
    }
  }

  if (winners.length > 0) {
    await table.bulkPut(winners as never);
  }

  return winners;
}

interface ApplyRemoteResult {
  appliedCount: number;
  appliedTransactions: Transaction[];
}

async function applyRemoteRecords(
  database: ExpenseDatabase,
  records: SyncRecordsPayload,
  seenUpdates: Array<{ deviceId: string; seq: number }>,
): Promise<ApplyRemoteResult> {
  return database.transaction(
    'rw',
    [
      database.accounts,
      database.categories,
      database.transactions,
      database.notePresets,
      database.recurringRules,
      database.shortcuts,
      database.places,
      database.lotteryDraws,
      database.budgets,
      database.noSpendDays,
      database.cards,
      database.currencies,
      database.meta,
    ],
    async () => {
      const [
        appliedAccounts,
        appliedCategories,
        appliedTransactions,
        appliedNotePresets,
        appliedRecurringRules,
        appliedShortcuts,
        appliedPlaces,
        appliedLotteryDraws,
        appliedBudgets,
        appliedNoSpendDays,
        appliedCards,
        appliedCurrencies,
      ] = await Promise.all([
        mergeTableRecords(database.accounts, records.accounts),
        mergeTableRecords(database.categories, records.categories),
        mergeTableRecords(database.transactions, records.transactions),
        mergeTableRecords(database.notePresets, records.notePresets ?? []),
        mergeTableRecords(database.recurringRules, records.recurringRules ?? []),
        mergeTableRecords(database.shortcuts, records.shortcuts ?? []),
        mergeTableRecords(database.places, records.places ?? []),
        mergeTableRecords(database.lotteryDraws, records.lotteryDraws ?? []),
        mergeTableRecords(database.budgets, records.budgets ?? []),
        mergeTableRecords(database.noSpendDays, records.noSpendDays ?? []),
        mergeTableRecords(database.cards, records.cards ?? []),
        mergeTableRecords(database.currencies, records.currencies ?? []),
      ]);

      for (const item of seenUpdates) {
        const key = `${META_KEYS.SYNC_SEEN_PREFIX}${item.deviceId}`;
        const current = await readMetaNumber(database, key);
        if (item.seq > current) {
          await database.meta.put({ key, value: String(item.seq) });
        }
      }

      const appliedCount =
        appliedAccounts.length +
        appliedCategories.length +
        appliedTransactions.length +
        appliedNotePresets.length +
        appliedRecurringRules.length +
        appliedShortcuts.length +
        appliedPlaces.length +
        appliedLotteryDraws.length +
        appliedBudgets.length +
        appliedNoSpendDays.length +
        appliedCards.length +
        appliedCurrencies.length;

      return { appliedCount, appliedTransactions };
    },
  );
}

async function buildOutboxRecords(
  database: ExpenseDatabase,
  entries: readonly OutboxEntry[],
): Promise<SyncRecordsPayload> {
  const accountIds: string[] = [];
  const categoryIds: string[] = [];
  const transactionIds: string[] = [];
  const notePresetIds: string[] = [];
  const recurringRuleIds: string[] = [];
  const shortcutIds: string[] = [];
  const placeIds: string[] = [];
  const lotteryDrawIds: string[] = [];
  const budgetIds: string[] = [];
  const noSpendDayIds: string[] = [];
  const cardIds: string[] = [];
  const currencyIds: string[] = [];

  for (const entry of entries) {
    if (entry.table === 'accounts') {
      accountIds.push(entry.recordId);
    } else if (entry.table === 'categories') {
      categoryIds.push(entry.recordId);
    } else if (entry.table === 'notePresets') {
      notePresetIds.push(entry.recordId);
    } else if (entry.table === 'recurringRules') {
      recurringRuleIds.push(entry.recordId);
    } else if (entry.table === 'shortcuts') {
      shortcutIds.push(entry.recordId);
    } else if (entry.table === 'places') {
      placeIds.push(entry.recordId);
    } else if (entry.table === 'lotteryDraws') {
      lotteryDrawIds.push(entry.recordId);
    } else if (entry.table === 'budgets') {
      budgetIds.push(entry.recordId);
    } else if (entry.table === 'noSpendDays') {
      noSpendDayIds.push(entry.recordId);
    } else if (entry.table === 'cards') {
      cardIds.push(entry.recordId);
    } else if (entry.table === 'currencies') {
      currencyIds.push(entry.recordId);
    } else {
      transactionIds.push(entry.recordId);
    }
  }

  const [
    accountsRaw,
    categoriesRaw,
    transactionsRaw,
    notePresetsRaw,
    recurringRulesRaw,
    shortcutsRaw,
    placesRaw,
    lotteryDrawsRaw,
    budgetsRaw,
    noSpendDaysRaw,
    cardsRaw,
    currenciesRaw,
  ] = await Promise.all([
    accountIds.length > 0
      ? database.accounts.bulkGet(accountIds)
      : Promise.resolve<Array<Account | undefined>>([]),
    categoryIds.length > 0
      ? database.categories.bulkGet(categoryIds)
      : Promise.resolve<Array<Category | undefined>>([]),
    transactionIds.length > 0
      ? database.transactions.bulkGet(transactionIds)
      : Promise.resolve<Array<Transaction | undefined>>([]),
    notePresetIds.length > 0
      ? database.notePresets.bulkGet(notePresetIds)
      : Promise.resolve<Array<NotePreset | undefined>>([]),
    recurringRuleIds.length > 0
      ? database.recurringRules.bulkGet(recurringRuleIds)
      : Promise.resolve<Array<RecurringRule | undefined>>([]),
    shortcutIds.length > 0
      ? database.shortcuts.bulkGet(shortcutIds)
      : Promise.resolve<Array<Shortcut | undefined>>([]),
    placeIds.length > 0
      ? database.places.bulkGet(placeIds)
      : Promise.resolve<Array<Place | undefined>>([]),
    lotteryDrawIds.length > 0
      ? database.lotteryDraws.bulkGet(lotteryDrawIds)
      : Promise.resolve<Array<LotteryDraw | undefined>>([]),
    budgetIds.length > 0
      ? database.budgets.bulkGet(budgetIds)
      : Promise.resolve<Array<Budget | undefined>>([]),
    noSpendDayIds.length > 0
      ? database.noSpendDays.bulkGet(noSpendDayIds)
      : Promise.resolve<Array<NoSpendDay | undefined>>([]),
    cardIds.length > 0
      ? database.cards.bulkGet(cardIds)
      : Promise.resolve<Array<WalletCard | undefined>>([]),
    currencyIds.length > 0
      ? database.currencies.bulkGet(currencyIds)
      : Promise.resolve<Array<CurrencyRate | undefined>>([]),
  ]);

  const accounts: Account[] = [];
  for (const item of accountsRaw) {
    if (item) {
      accounts.push(item);
    }
  }
  const categories: Category[] = [];
  for (const item of categoriesRaw) {
    if (item) {
      categories.push(item);
    }
  }
  const transactions: Transaction[] = [];
  for (const item of transactionsRaw) {
    if (item) {
      transactions.push(item);
    }
  }
  const notePresets: NotePreset[] = [];
  for (const item of notePresetsRaw) {
    if (item) {
      notePresets.push(item);
    }
  }
  const recurringRules: RecurringRule[] = [];
  for (const item of recurringRulesRaw) {
    if (item) {
      recurringRules.push(item);
    }
  }
  const shortcuts: Shortcut[] = [];
  for (const item of shortcutsRaw) {
    if (item) {
      shortcuts.push(item);
    }
  }
  const places: Place[] = [];
  for (const item of placesRaw) {
    if (item) {
      places.push(item);
    }
  }
  const lotteryDraws: LotteryDraw[] = [];
  for (const item of lotteryDrawsRaw) {
    if (item) {
      lotteryDraws.push(item);
    }
  }
  const budgets: Budget[] = [];
  for (const item of budgetsRaw) {
    if (item) {
      budgets.push(item);
    }
  }
  const noSpendDays: NoSpendDay[] = [];
  for (const item of noSpendDaysRaw) {
    if (item) {
      noSpendDays.push(item);
    }
  }
  const cards: WalletCard[] = [];
  for (const item of cardsRaw) {
    if (item) {
      cards.push(item);
    }
  }
  const currencies: CurrencyRate[] = [];
  for (const item of currenciesRaw) {
    if (item) {
      currencies.push(item);
    }
  }

  return {
    accounts,
    categories,
    transactions,
    notePresets,
    recurringRules,
    shortcuts,
    places,
    lotteryDraws,
    budgets,
    noSpendDays,
    cards,
    currencies,
  };
}

/**
 * 執行一次完整雙向同步流程（上傳 outbox、套用快照與他裝置變更、必要時壓縮快照）。
 */
export async function syncOnce(options: SyncOnceOptions): Promise<SyncOnceResult> {
  const database = options.database ?? db;
  const { driveStore, deviceId } = options;
  const snapshotThreshold = options.snapshotThreshold ?? DEFAULT_SNAPSHOT_THRESHOLD;

  let uploadedCount = 0;
  let downloadedChanges = 0;
  let usedSnapshot = false;
  let compacted = false;
  let appliedRecordsCount = 0;
  const appliedTransactionsMap = new Map<string, Transaction>();

  // 1. 上傳本機待同步的 outbox 項目
  const outboxEntries = await database.outbox.toArray();
  if (outboxEntries.length > 0) {
    const records = await buildOutboxRecords(database, outboxEntries);
    const currentSeq = await readMetaNumber(database, META_KEYS.SYNC_LOCAL_SEQ);
    const nextSeq = currentSeq + 1;

    const batch: ChangeBatchFile = {
      deviceId,
      seq: nextSeq,
      createdAt: Date.now(),
      records,
    };

    await driveStore.upload(`changes/${deviceId}/${nextSeq}.json`, JSON.stringify(batch));

    const uploadedKeys = outboxEntries.map((entry) => entry.key);
    await database.transaction('rw', database.outbox, database.meta, async () => {
      await database.outbox.bulkDelete(uploadedKeys);
      await database.meta.put({ key: META_KEYS.SYNC_LOCAL_SEQ, value: String(nextSeq) });
    });

    uploadedCount = uploadedKeys.length;
  }

  // 2. 列出 appDataFolder 內所有檔案
  const files = await driveStore.list();
  const snapshotFile = files.find((f) => f.name === SNAPSHOT_FILE_NAME) ?? null;
  const changeFiles: ParsedChangeFile[] = [];

  for (const file of files) {
    const parsed = parseChangePath(file.name);
    if (parsed) {
      changeFiles.push({ file, deviceId: parsed.deviceId, seq: parsed.seq });
    }
  }

  // 3. 若本機從未同步過且有 snapshot.json，先下載並合併快照
  const lastSyncMeta = await database.meta.get(META_KEYS.SYNC_LAST_SYNC_AT);
  if (!lastSyncMeta && snapshotFile) {
    const snapshotRaw = await driveStore.download(snapshotFile.id);
    const snapshot = JSON.parse(snapshotRaw) as SnapshotFile;
    const seenUpdates = Object.entries(snapshot.includes ?? {}).map(([devId, seq]) => ({
      deviceId: devId,
      seq,
    }));
    const applied = await applyRemoteRecords(database, snapshot.records, seenUpdates);
    appliedRecordsCount += applied.appliedCount;
    for (const tx of applied.appliedTransactions) {
      appliedTransactionsMap.set(tx.id, tx);
    }
    usedSnapshot = true;
  }

  // 4. 下載每台「其他裝置」seq 大於 seen 的變更檔並依序合併
  const changesByDevice = new Map<string, ParsedChangeFile[]>();
  for (const item of changeFiles) {
    if (item.deviceId === deviceId) {
      continue;
    }
    const list = changesByDevice.get(item.deviceId) ?? [];
    list.push(item);
    changesByDevice.set(item.deviceId, list);
  }

  for (const [remoteDeviceId, remoteFiles] of changesByDevice) {
    const seenSeq = await readMetaNumber(database, `${META_KEYS.SYNC_SEEN_PREFIX}${remoteDeviceId}`);
    const pending = remoteFiles
      .filter((item) => item.seq > seenSeq)
      .sort((a, b) => a.seq - b.seq);

    for (const item of pending) {
      const batchRaw = await driveStore.download(item.file.id);
      const batch = JSON.parse(batchRaw) as ChangeBatchFile;
      const applied = await applyRemoteRecords(database, batch.records, [
        { deviceId: remoteDeviceId, seq: batch.seq },
      ]);
      appliedRecordsCount += applied.appliedCount;
      for (const tx of applied.appliedTransactions) {
        appliedTransactionsMap.set(tx.id, tx);
      }
      downloadedChanges += 1;
    }
  }

  // 6. 變更檔總數超過門檻時，產生新的 snapshot.json 並清理已包含的變更檔
  if (changeFiles.length > snapshotThreshold) {
    const [
      accounts,
      categories,
      transactions,
      notePresets,
      recurringRules,
      shortcuts,
      places,
      lotteryDraws,
      budgets,
      noSpendDays,
      cards,
      currencies,
      allMeta,
    ] = await Promise.all([
      database.accounts.toArray(),
      database.categories.toArray(),
      database.transactions.toArray(),
      database.notePresets.toArray(),
      database.recurringRules.toArray(),
      database.shortcuts.toArray(),
      database.places.toArray(),
      database.lotteryDraws.toArray(),
      database.budgets.toArray(),
      database.noSpendDays.toArray(),
      database.cards.toArray(),
      database.currencies.toArray(),
      database.meta.toArray(),
    ]);

    const includes: Record<string, number> = {};
    for (const entry of allMeta) {
      if (entry.key === META_KEYS.SYNC_LOCAL_SEQ) {
        const localSeq = Number(entry.value);
        if (Number.isFinite(localSeq) && localSeq > 0) {
          includes[deviceId] = localSeq;
        }
      } else if (entry.key.startsWith(META_KEYS.SYNC_SEEN_PREFIX)) {
        const devId = entry.key.slice(META_KEYS.SYNC_SEEN_PREFIX.length);
        const seq = Number(entry.value);
        if (devId && Number.isFinite(seq) && seq > 0) {
          includes[devId] = seq;
        }
      }
    }

    const snapshot: SnapshotFile = {
      createdAt: Date.now(),
      includes,
      records: {
        accounts,
        categories,
        transactions,
        notePresets,
        recurringRules,
        shortcuts,
        places,
        lotteryDraws,
        budgets,
        noSpendDays,
        cards,
        currencies,
      },
    };
    const snapshotJson = JSON.stringify(snapshot);

    if (snapshotFile) {
      await driveStore.update(snapshotFile.id, snapshotJson);
    } else {
      await driveStore.upload(SNAPSHOT_FILE_NAME, snapshotJson);
    }

    const coveredFiles = changeFiles.filter(
      (item) => item.seq <= (includes[item.deviceId] ?? 0),
    );
    for (const item of coveredFiles) {
      await driveStore.remove(item.file.id);
    }
    compacted = true;
  }

  // 7. 更新 lastSyncAt
  const lastSyncAt = Date.now();
  await database.meta.put({ key: META_KEYS.SYNC_LAST_SYNC_AT, value: String(lastSyncAt) });

  let appliedTransactionsCount = 0;
  for (const tx of appliedTransactionsMap.values()) {
    if (!tx.deleted) {
      appliedTransactionsCount += 1;
    }
  }

  return {
    uploadedCount,
    downloadedChanges,
    usedSnapshot,
    compacted,
    lastSyncAt,
    appliedRecordsCount,
    appliedTransactionsCount,
  };
}
