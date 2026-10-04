import { computed, reactive, ref } from "vue";
import {
  BUSINESS_STATUSES,
  CHAIN_VERSION,
  LedgerData,
  LegacyRecord,
  MigrationRecord,
  OfflineOrder,
  PriceEntry,
  PriceInput,
  createEntry,
  createOfflineOrder,
  createReport,
  mergeOfflineOrders,
  migrateLegacyRecords,
  publishEntry,
  rejectOfflineOrder,
  reviseEntries,
  rollbackEntries,
  summarizeChains,
  verifyEntry,
  verifyOrder
} from "./priceChain";

export const LEGACY_STORAGE_KEY = "dfwlfront-9-price";
export const LEDGER_STORAGE_KEY = "dfwlfront-9-price-ledger-v2";

const seedRecords: LegacyRecord[] = [
  {
    id: "seed-1",
    fuel: "92号汽油",
    price: 7.62,
    operator: "站长",
    effectiveDate: "2026-06-30",
    status: "生效中",
    notes: "正常调价",
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString()
  },
  {
    id: "seed-2",
    fuel: "92号汽油",
    price: 7.68,
    operator: "值班经理",
    effectiveDate: "2026-09-30",
    status: "待确认",
    notes: "等待复核",
    createdAt: new Date(Date.now() - 86400000).toISOString()
  },
  {
    id: "seed-3",
    fuel: "柴油",
    price: 7.18,
    operator: "值班经理",
    effectiveDate: "2026-06-30",
    status: "生效中",
    notes: "批发客户挂牌价",
    createdAt: new Date().toISOString()
  }
];

export type LoadState =
  | { ok: true; data: LedgerData }
  | { ok: false; error: string; legacy: unknown };

function emptyLedger(now: string): LedgerData {
  return {
    version: CHAIN_VERSION,
    entries: [],
    orders: [],
    migrations: [],
    offline: false,
    updatedAt: now
  };
}

function withMigration(data: LedgerData, migration: MigrationRecord): LedgerData {
  return {
    ...data,
    entries: migration.entryIds
      .map((id) => data.entries.find((entry) => entry.id === id))
      .filter((entry): entry is PriceEntry => Boolean(entry)),
    migrations: [...data.migrations, migration],
    updatedAt: new Date().toISOString()
  };
}

export function loadLedger(): LoadState {
  const ledgerRaw = localStorage.getItem(LEDGER_STORAGE_KEY);
  if (ledgerRaw) {
    try {
      const parsed = JSON.parse(ledgerRaw) as LedgerData;
      if (parsed.version !== CHAIN_VERSION || !Array.isArray(parsed.entries) || !Array.isArray(parsed.orders)) {
        return { ok: false, error: "v2 凭证链存档结构不兼容，已停止写入。", legacy: parsed };
      }
      return {
        ok: true,
        data: {
          ...parsed,
          migrations: Array.isArray(parsed.migrations) ? parsed.migrations : [],
          offline: Boolean(parsed.offline)
        }
      };
    } catch (error) {
      return { ok: false, error: `v2 存档解析失败：${String(error)}`, legacy: ledgerRaw };
    }
  }

  const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
  let legacy: unknown;
  if (legacyRaw) {
    try {
      legacy = JSON.parse(legacyRaw);
    } catch (error) {
      return { ok: false, error: `旧存档解析失败：${String(error)}`, legacy: legacyRaw };
    }
  } else {
    legacy = seedRecords;
  }

  const base = emptyLedger(new Date().toISOString());
  const result = migrateLegacyRecords(legacy, LEGACY_STORAGE_KEY);
  if (!result.ok) {
    return { ok: false, error: result.error, legacy };
  }

  const migrated = withMigration({ ...base, entries: result.entries }, result.migration);
  localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(migrated));
  return { ok: true, data: migrated };
}

const state = reactive({
  ready: false,
  readOnly: false,
  loadError: "",
  entries: [] as PriceEntry[],
  orders: [] as OfflineOrder[],
  migrations: [] as MigrationRecord[],
  offline: false,
  updatedAt: "",
  message: "",
  messageKind: "info" as "info" | "error" | "success"
});

function persist() {
  if (state.readOnly) return;
  const data: LedgerData = {
    version: CHAIN_VERSION,
    entries: state.entries,
    orders: state.orders,
    migrations: state.migrations,
    offline: state.offline,
    updatedAt: new Date().toISOString()
  };
  state.updatedAt = data.updatedAt;
  localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(data));
}

function notice(message: string, kind: "info" | "error" | "success" = "info") {
  state.message = message;
  state.messageKind = kind;
}

function fail(error: unknown) {
  notice(error instanceof Error ? error.message : String(error), "error");
}

export function initializeStore() {
  if (state.ready) return;
  const loaded = loadLedger();
  if (!loaded.ok) {
    state.ready = true;
    state.readOnly = true;
    state.loadError = loaded.error;
    state.message = `旧数据补链失败，未改写任何原记录：${loaded.error}`;
    state.messageKind = "error";
    return;
  }
  state.entries = loaded.data.entries;
  state.orders = loaded.data.orders;
  state.migrations = loaded.data.migrations;
  state.offline = loaded.data.offline;
  state.updatedAt = loaded.data.updatedAt;
  state.ready = true;
}

export function usePriceStore() {
  const entryVerification = computed(() => {
    const map = new Map<string, ReturnType<typeof verifyEntry>>();
    for (const entry of state.entries) {
      map.set(entry.id, verifyEntry(entry, state.entries, state.migrations));
    }
    return map;
  });

  const orderVerification = computed(() => {
    const map = new Map<string, ReturnType<typeof verifyOrder>>();
    for (const order of state.orders) {
      map.set(order.id, verifyOrder(order, state.entries, state.orders));
    }
    return map;
  });

  const chains = computed(() => summarizeChains(state.entries, state.migrations));
  const healthy = computed(() => chains.value.every((chain) => chain.healthy));
  const brokenCount = computed(() =>
    state.entries.filter((entry) => !entryVerification.value.get(entry.id)?.ok).length
  );

  function validatePriceInput(input: Omit<PriceInput, "createdAt">) {
    if (!input.fuel.trim()) throw new Error("油品不能为空。");
    if (!Number.isFinite(input.price) || input.price <= 0) throw new Error("挂牌价必须是大于 0 的数字。");
    if (!input.operator.trim()) throw new Error("操作员不能为空。");
    if (!input.effectiveDate.trim()) throw new Error("生效日期不能为空。");
    if (!input.businessStatus.trim()) throw new Error("业务状态不能为空。");
  }

  function addPrice(input: Omit<PriceInput, "createdAt">) {
    if (state.readOnly || state.offline) return;
    try {
      validatePriceInput(input);
      const entry = createEntry(state.entries, { ...input, createdAt: new Date().toISOString() });
      state.entries = [...state.entries, entry];
      persist();
      notice("已生成新价格版本，摘要链接到当前链头。", "success");
    } catch (error) {
      fail(error);
    }
  }

  function editMetadata(id: string, changes: { notes: string; businessStatus: string }) {
    if (state.readOnly || state.offline) return;
    try {
      state.entries = reviseEntries(state.entries, id, changes, "当前操作员");
      persist();
      notice("已保留原版本；后续未发布价格已失效并重算，已发布价格未改动。", "success");
    } catch (error) {
      fail(error);
    }
  }

  function rollback(id: string) {
    if (state.readOnly || state.offline) return;
    try {
      state.entries = rollbackEntries(state.entries, id, "当前操作员");
      persist();
      notice("未发布版本已退回，后续版本已按新父摘要重算。", "success");
    } catch (error) {
      fail(error);
    }
  }

  function publish(id: string) {
    if (state.readOnly || state.offline) return;
    try {
      state.entries = publishEntry(state.entries, id, "当前操作员");
      persist();
      notice("已发布并加盖冻结戳；后续不得覆盖或重写。", "success");
    } catch (error) {
      fail(error);
    }
  }

  function setOffline(value: boolean) {
    if (state.readOnly) return;
    state.offline = value;
    persist();
    notice(value ? "已进入离线模式：调价单先保存待回连。" : "已退出离线模式。", "info");
  }

  function queueOfflineOrder(input: Omit<PriceInput, "createdAt">) {
    if (state.readOnly || !state.offline) return;
    try {
      validatePriceInput(input);
      const pendingSameFuel = [...state.orders]
        .filter((order) => order.state === "pending" && order.fuel === input.fuel)
        .sort((a, b) => b.offlineAt.localeCompare(a.offlineAt))[0];
      const order = createOfflineOrder(state.entries, { ...input, createdAt: new Date().toISOString() }, pendingSameFuel);
      state.orders = [...state.orders, order];
      persist();
      notice("离线调价单已带摘要入队，等待回连合并。", "success");
    } catch (error) {
      fail(error);
    }
  }

  function queueBrokenOfflineOrder(input: Omit<PriceInput, "createdAt">) {
    if (state.readOnly || !state.offline) return;
    validatePriceInput(input);
    const order = createOfflineOrder(state.entries, { ...input, createdAt: new Date().toISOString() });
    const tampered = { ...order, price: Number((order.price + 0.5).toFixed(2)) };
    state.orders = [...state.orders, tampered];
    persist();
    notice("已生成一张内容与摘要不一致的演示离线单；回连后会停在待核。", "info");
  }

  function reconnect() {
    if (state.readOnly) return;
    try {
      const result = mergeOfflineOrders(state.entries, state.orders);
      state.entries = result.entries;
      state.orders = result.orders;
      state.offline = false;
      persist();
      const pendingReview = result.orders.filter((order) => order.state === "pending-review").length;
      if (pendingReview > 0) {
        notice(`回连完成：${pendingReview} 张单停在待核，未覆盖现有价。`, "error");
      } else {
        notice("离线调价单全部按摘要合并成功。", "success");
      }
    } catch (error) {
      fail(error);
    }
  }

  function rejectOrder(id: string, reason: string) {
    if (state.readOnly) return;
    state.orders = rejectOfflineOrder(state.orders, id, "当前操作员", reason);
    persist();
    notice("待核离线单已驳回；现有价格未改变。", "success");
  }

  function exportReport() {
    if (state.readOnly) return null;
    return createReport(state.entries, state.orders, state.migrations);
  }

  function simulateManualEdit(id: string) {
    if (state.readOnly) return;
    state.entries = state.entries.map((entry) =>
      entry.id === id ? { ...entry, price: Number((entry.price + 0.01).toFixed(2)) } : entry
    );
    persist();
    notice("已模拟手工改写本机价格但未重算摘要，页面应显示断点。", "error");
  }

  function resetDemo() {
    localStorage.removeItem(LEDGER_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    window.location.reload();
  }

  return {
    state,
    BUSINESS_STATUSES,
    entryVerification,
    orderVerification,
    chains,
    healthy,
    brokenCount,
    addPrice,
    editMetadata,
    rollback,
    publish,
    setOffline,
    queueOfflineOrder,
    queueBrokenOfflineOrder,
    reconnect,
    rejectOrder,
    exportReport,
    simulateManualEdit,
    resetDemo
  };
}
