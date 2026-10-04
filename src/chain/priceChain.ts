import { digestObject } from "./crypto";

export const CHAIN_VERSION = 2;
export const GENESIS_KIND = "price-genesis-v1";
export const BUSINESS_STATUSES = ["生效中", "待确认", "已回退"] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number] | string;

export type EntryOrigin = "online" | "offline" | "migration";

export type Seal = {
  digest: string;
  sealedAt: string;
  operator: string;
  kind: "publish" | "migration";
};

export type VoidMark = {
  digest: string;
  voidedAt: string;
  operator: string;
  reason: string;
  kind: "rollback" | "superseded";
};

export type PriceEntry = {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  businessStatus: BusinessStatus;
  notes: string;
  createdAt: string;
  seq: number;
  basisDigest: string;
  entryDigest: string;
  revisionOf?: string;
  revisionSeq?: number;
  revisionDigest?: string;
  origin: EntryOrigin;
  legacyId?: string;
  seal?: Seal;
  void?: VoidMark;
};

export type OfflineOrderState = "pending" | "merged" | "pending-review" | "rejected";

export type OfflineReview = {
  digest: string;
  at: string;
  operator: string;
  reason: string;
};

export type OfflineOrder = {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  businessStatus: BusinessStatus;
  notes: string;
  createdAt: string;
  offlineAt: string;
  seq: number;
  basisDigest: string;
  previousOrderDigest?: string;
  reservedEntryId: string;
  projectedEntryDigest: string;
  orderDigest: string;
  state: OfflineOrderState;
  mergedEntryId?: string;
  review?: OfflineReview;
};

export type MigrationRecord = {
  id: string;
  at: string;
  legacyStorageKey: string;
  legacyCount: number;
  entryIds: string[];
  digest: string;
};

export type LedgerData = {
  version: 2;
  entries: PriceEntry[];
  orders: OfflineOrder[];
  migrations: MigrationRecord[];
  offline: boolean;
  updatedAt: string;
};

export type LegacyRecord = {
  id?: string;
  fuel?: unknown;
  price?: unknown;
  operator?: unknown;
  effectiveDate?: unknown;
  status?: unknown;
  notes?: unknown;
  createdAt?: unknown;
};

export type PriceInput = {
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  businessStatus: string;
  notes: string;
  createdAt: string;
};

export type VerificationCode =
  | "VALID"
  | "VOIDED"
  | "ENTRY_TAMPERED"
  | "PUBLISH_TAMPERED"
  | "VOID_TAMPERED"
  | "BASIS_MISSING"
  | "BASIS_FUEL_MISMATCH"
  | "BASIS_MISMATCH"
  | "BRANCH_BROKEN"
  | "MULTIPLE_HEADS"
  | "REVISION_MISSING"
  | "REVISION_MISMATCH"
  | "MIGRATION_TAMPERED"
  | "FROZEN_PUBLISHED";

export type EntryIssue = {
  code: VerificationCode;
  message: string;
  field?: string;
};

export type EntryVerification = {
  code: VerificationCode;
  ok: boolean;
  active: boolean;
  published: boolean;
  frozen: boolean;
  issues: EntryIssue[];
};

export type OrderVerificationCode =
  | "ORDER_VALID"
  | "ORDER_MERGED"
  | "ORDER_PENDING"
  | "ORDER_PENDING_OFFLINE"
  | "ORDER_REJECTED"
  | "ORDER_REVIEW"
  | "ORDER_BLOCKED"
  | "ORDER_TAMPERED"
  | "ORDER_PREVIOUS_MISSING"
  | "ORDER_PREVIOUS_MISMATCH"
  | "ORDER_ENTRY_MISSING"
  | "ORDER_ENTRY_MISMATCH";

export type OrderIssue = {
  code: OrderVerificationCode;
  message: string;
};

export type OrderVerification = {
  code: OrderVerificationCode;
  ok: boolean;
  issues: OrderIssue[];
  expectedBasisDigest?: string;
};

export type PriceReport = {
  version: 2;
  generatedAt: string;
  entries: Array<PriceEntry & { verification: EntryVerification }>;
  orders: Array<OfflineOrder & { verification: OrderVerification }>;
  migrations: MigrationRecord[];
  chains: ChainSummary[];
  reportDigest?: string;
};

export type ChainSummary = {
  fuel: string;
  rootDigest: string | null;
  headDigest: string | null;
  activeEntryId: string | null;
  entryCount: number;
  healthy: boolean;
  breakpoints: EntryIssue[];
  digests: Array<{
    id: string;
    seq: number;
    state: "published" | "draft" | "voided";
    basisDigest: string;
    entryDigest: string;
    revisionOf?: string;
  }>;
};

export function genesisDigest(fuel: string): string {
  return digestObject(GENESIS_KIND, { fuel });
}

export function normalizePrice(price: number): number {
  return Number(Number(price).toFixed(2));
}

function entryPayload(entry: PriceInput & {
  id: string;
  seq: number;
  basisDigest: string;
  revisionOf?: string;
  revisionSeq?: number;
  revisionDigest?: string;
  origin: EntryOrigin;
  legacyId?: string;
}) {
  return {
    id: entry.id,
    fuel: entry.fuel,
    price: normalizePrice(entry.price),
    operator: entry.operator,
    effectiveDate: entry.effectiveDate,
    businessStatus: entry.businessStatus,
    notes: entry.notes,
    createdAt: entry.createdAt,
    seq: entry.seq,
    basisDigest: entry.basisDigest,
    revisionOf: entry.revisionOf ?? null,
    revisionSeq: entry.revisionSeq ?? null,
    revisionDigest: entry.revisionDigest ?? null,
    origin: entry.origin,
    legacyId: entry.legacyId ?? null
  };
}

export function calculateEntryDigest(entry: Parameters<typeof entryPayload>[0]): string {
  return digestObject("price-entry-v1", entryPayload(entry));
}

export function calculateSealDigest(entryDigest: string, sealedAt: string, operator: string): string {
  return digestObject("price-publish-v1", { entryDigest, sealedAt, operator });
}

export function calculateVoidDigest(entryDigest: string, voidedAt: string, operator: string, reason: string): string {
  return digestObject("price-void-v1", { entryDigest, voidedAt, operator, reason });
}

export function calculateOrderDigest(order: Omit<OfflineOrder, "orderDigest" | "state" | "mergedEntryId" | "review">): string {
  return digestObject("offline-price-order-v1", {
    id: order.id,
    fuel: order.fuel,
    price: normalizePrice(order.price),
    operator: order.operator,
    effectiveDate: order.effectiveDate,
    businessStatus: order.businessStatus,
    notes: order.notes,
    createdAt: order.createdAt,
    offlineAt: order.offlineAt,
    seq: order.seq,
    basisDigest: order.basisDigest,
    previousOrderDigest: order.previousOrderDigest ?? null,
    reservedEntryId: order.reservedEntryId,
    projectedEntryDigest: order.projectedEntryDigest
  });
}

export function calculateMigrationDigest(input: {
  at: string;
  legacyStorageKey: string;
  legacyCount: number;
  entries: Array<{ id: string; legacyId?: string; entryDigest: string }>;
}): string {
  return digestObject("price-migration-v1", input);
}

export function calculateReviewDigest(orderId: string, at: string, operator: string, reason: string): string {
  return digestObject("offline-review-v1", { orderId, at, operator, reason });
}

export function groupByFuel(entries: PriceEntry[]): Map<string, PriceEntry[]> {
  const groups = new Map<string, PriceEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.fuel) ?? [];
    list.push(entry);
    groups.set(entry.fuel, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  return groups;
}

export function nextSeq(entries: PriceEntry[], fuel: string): number {
  return entries.filter((entry) => entry.fuel === fuel).reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
}

export function indexEntries(entries: PriceEntry[]): Map<string, PriceEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

export function findActiveLeaves(entries: PriceEntry[], fuel?: string): PriceEntry[] {
  const scope = fuel ? entries.filter((entry) => entry.fuel === fuel) : entries;
  const referenced = new Set<string>();
  for (const entry of scope) {
    if (entry.void) continue;
    const basis = scope.find((candidate) => candidate.entryDigest === entry.basisDigest && !candidate.void);
    if (basis) referenced.add(basis.id);
    if (entry.revisionOf) {
      const target = scope.find((candidate) => candidate.id === entry.revisionOf);
      if (target) referenced.add(target.id);
    }
  }
  return scope.filter((entry) => !entry.void && !referenced.has(entry.id));
}

export function findActivePath(entries: PriceEntry[], leaf: PriceEntry): PriceEntry[] {
  const path: PriceEntry[] = [];
  let current: PriceEntry | undefined = leaf;
  const seen = new Set<string>();

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);

    // 活动链始终沿父版本摘要行走；revisionOf 只说明本条由哪一版重算。
    if (current.basisDigest === genesisDigest(current.fuel)) break;
    current = entries.find((entry) => entry.entryDigest === current!.basisDigest);
  }

  return path;
}

export function activeLeafForFuel(entries: PriceEntry[], fuel: string): PriceEntry | null {
  const leaves = findActiveLeaves(entries, fuel);
  return leaves.length === 1 ? leaves[0] : null;
}

function expectedMigration(
  entry: PriceEntry,
  migrations: MigrationRecord[]
): MigrationRecord | null {
  if (entry.origin !== "migration") return null;
  return migrations.find((migration) => migration.entryIds.includes(entry.id)) ?? null;
}

export function verifyEntry(entry: PriceEntry, entries: PriceEntry[], migrations: MigrationRecord[]): EntryVerification {
  const issues: EntryIssue[] = [];
  const byDigest = new Map(entries.map((candidate) => [candidate.entryDigest, candidate]));
  const byId = indexEntries(entries);
  const leaves = findActiveLeaves(entries, entry.fuel);
  const active = !entry.void && leaves.some((leaf) => leaf.id === entry.id);
  const published = Boolean(entry.seal);
  const frozen = published;

  const expectedEntryDigest = calculateEntryDigest(entry);
  if (entry.entryDigest !== expectedEntryDigest) {
    issues.push({
      code: "ENTRY_TAMPERED",
      message: "本条记录内容与摘要不一致，字段已被直接改写。",
      field: "entryDigest"
    });
  }

  if (entry.seal) {
    const expectedSeal = calculateSealDigest(expectedEntryDigest, entry.seal.sealedAt, entry.seal.operator);
    if (entry.seal.digest !== expectedSeal) {
      issues.push({
        code: "PUBLISH_TAMPERED",
        message: "发布冻结戳与记录摘要接不上。",
        field: "seal.digest"
      });
    }
  }

  if (entry.void) {
    const expectedVoid = calculateVoidDigest(
      expectedEntryDigest,
      entry.void.voidedAt,
      entry.void.operator,
      entry.void.reason
    );
    if (entry.void.digest !== expectedVoid) {
      issues.push({
        code: "VOID_TAMPERED",
        message: "失效/回退戳与记录摘要接不上。",
        field: "void.digest"
      });
    }
  }

  const migration = expectedMigration(entry, migrations);
  if (entry.origin === "migration") {
    if (!migration) {
      issues.push({ code: "MIGRATION_TAMPERED", message: "迁移来源存在，但迁移批次摘要缺失。" });
    } else {
      const expected = calculateMigrationDigest({
        at: migration.at,
        legacyStorageKey: migration.legacyStorageKey,
        legacyCount: migration.legacyCount,
        entries: migration.entryIds.map((id) => {
          const migrated = byId.get(id);
          return {
            id,
            legacyId: migrated?.legacyId,
            entryDigest: migrated?.entryDigest ?? ""
          };
        })
      });
      if (migration.digest !== expected) {
        issues.push({ code: "MIGRATION_TAMPERED", message: `迁移批次 ${migration.id} 的补链摘要不一致。` });
      }
    }
  }

  if (entry.revisionOf) {
    const target = byId.get(entry.revisionOf);
    if (!target) {
      issues.push({ code: "REVISION_MISSING", message: `修订来源 ${entry.revisionOf} 已缺失。` });
    } else {
      if (entry.revisionDigest !== target.entryDigest || entry.revisionSeq !== target.seq) {
        issues.push({ code: "REVISION_MISMATCH", message: "修订来源摘要或序号不一致。" });
      }
    }
  }

  const genesis = genesisDigest(entry.fuel);
  if (entry.basisDigest === genesis) {
    // 油品的第一条补链记录以创世摘要为锚点。
  } else {
    const basis = byDigest.get(entry.basisDigest);
    if (!basis) {
      issues.push({ code: "BASIS_MISSING", message: "上一版摘要指向的记录不存在。" });
    } else if (basis.fuel !== entry.fuel) {
      issues.push({ code: "BASIS_FUEL_MISMATCH", message: "上一版记录属于其他油品。" });
    } else if (basis.entryDigest !== entry.basisDigest) {
      issues.push({ code: "BASIS_MISMATCH", message: "上一版摘要不匹配。" });
    } else if (basis.void && active && entry.revisionOf !== basis.id) {
      issues.push({
        code: "BRANCH_BROKEN",
        message: "当前未发布记录接在已失效版本之后，需要重算。"
      });
    } else if (!basis.void && active) {
      const leaf = leaves.find((candidate) => candidate.id === entry.id) ?? null;
      const path = leaf ? findActivePath(entries, leaf) : [];
      if (!path.some((candidate) => candidate.id === basis.id)) {
        issues.push({
          code: "BRANCH_BROKEN",
          message: "上一版存在另一条活动分支，当前记录形成分叉。"
        });
      }
    }
  }

  if (active && leaves.length > 1) {
    issues.push({ code: "MULTIPLE_HEADS", message: `${entry.fuel} 存在 ${leaves.length} 个活动链头。` });
  }

  if (frozen && issues.some((issue) => ["ENTRY_TAMPERED", "PUBLISH_TAMPERED"].includes(issue.code))) {
    issues.push({ code: "FROZEN_PUBLISHED", message: "已发布价格必须冻结；本条检测到发布后改写。" });
  }

  const code = issues[0]?.code ?? (entry.void ? "VOIDED" : "VALID");
  return {
    code,
    ok: issues.length === 0,
    active,
    published,
    frozen,
    issues
  };
}

export function summarizeChains(entries: PriceEntry[], migrations: MigrationRecord[]): ChainSummary[] {
  return Array.from(groupByFuel(entries), ([fuel, fuelEntries]) => {
    const leaves = findActiveLeaves(fuelEntries, fuel);
    const leaf = leaves.length === 1 ? leaves[0] : null;
    const verifications = fuelEntries.map((entry) => verifyEntry(entry, entries, migrations));
    const breakpoints = verifications.flatMap((verification) => verification.issues);
    const root = fuelEntries.find((entry) => entry.basisDigest === genesisDigest(fuel)) ?? null;
    return {
      fuel,
      rootDigest: root?.entryDigest ?? null,
      headDigest: leaf?.entryDigest ?? null,
      activeEntryId: leaf?.id ?? null,
      entryCount: fuelEntries.length,
      healthy: breakpoints.length === 0 && leaves.length <= 1,
      breakpoints,
      digests: fuelEntries.map((entry) => ({
        id: entry.id,
        seq: entry.seq,
        state: entry.void ? "voided" as const : entry.seal ? "published" as const : "draft" as const,
        basisDigest: entry.basisDigest,
        entryDigest: entry.entryDigest,
        revisionOf: entry.revisionOf
      }))
    };
  }).sort((a, b) => a.fuel.localeCompare(b.fuel, "zh-Hans-CN"));
}

function makeEntry(input: PriceInput & {
  id: string;
  seq: number;
  basisDigest: string;
  origin: EntryOrigin;
  revisionOf?: string;
  revisionSeq?: number;
  revisionDigest?: string;
  legacyId?: string;
}): PriceEntry {
  const normalized = { ...input, price: normalizePrice(input.price) };
  const entryDigest = calculateEntryDigest({ ...normalized, ...input } as Parameters<typeof entryPayload>[0]);
  return { ...normalized, entryDigest };
}

export function createEntry(
  entries: PriceEntry[],
  input: PriceInput,
  origin: EntryOrigin = "online",
  id = crypto.randomUUID()
): PriceEntry {
  const leaf = activeLeafForFuel(entries, input.fuel);
  const basisDigest = leaf?.entryDigest ?? genesisDigest(input.fuel);
  return makeEntry({
    ...input,
    id,
    seq: nextSeq(entries, input.fuel),
    basisDigest,
    origin
  });
}

function sealedEntry(entry: PriceEntry, operator: string, at: string): PriceEntry {
  return {
    ...entry,
    seal: {
      digest: calculateSealDigest(entry.entryDigest, at, operator),
      sealedAt: at,
      operator,
      kind: "publish"
    }
  };
}

function voidEntry(entry: PriceEntry, operator: string, reason: string, kind: VoidMark["kind"], at: string): PriceEntry {
  return {
    ...entry,
    void: {
      digest: calculateVoidDigest(entry.entryDigest, at, operator, reason),
      voidedAt: at,
      operator,
      reason,
      kind
    }
  };
}

function revisionCopy(options: {
  source: PriceEntry;
  basisDigest: string;
  id: string;
  seq: number;
  at: string;
  overrides?: Partial<Pick<PriceEntry, "notes" | "businessStatus">>;
  origin?: EntryOrigin;
}): PriceEntry {
  const { source, basisDigest, id, seq, at, overrides = {}, origin = "online" } = options;
  return makeEntry({
    id,
    fuel: source.fuel,
    price: source.price,
    operator: source.operator,
    effectiveDate: source.effectiveDate,
    businessStatus: overrides.businessStatus ?? source.businessStatus,
    notes: overrides.notes ?? source.notes,
    createdAt: at,
    seq,
    basisDigest,
    origin,
    revisionOf: source.id,
    revisionSeq: source.seq,
    revisionDigest: source.entryDigest
  });
}

export function reviseEntries(
  entries: PriceEntry[],
  targetId: string,
  changes: Partial<Pick<PriceEntry, "notes" | "businessStatus">>,
  operator: string,
  at = new Date().toISOString()
): PriceEntry[] {
  const target = entries.find((entry) => entry.id === targetId);
  if (!target) throw new Error("待修订记录不存在");
  if (target.void) throw new Error("已失效记录不能直接修订");
  if (target.seal) throw new Error("已发布记录冻结，不能改备注或状态");
  if (changes.businessStatus === "已回退") throw new Error("退回操作必须保留回退戳，不能作为普通修订");

  const leaves = findActiveLeaves(entries, target.fuel);
  const leaf = leaves[0];
  if (!leaf || leaves.length > 1) throw new Error("活动链存在分叉，不能自动重算");

  const path = findActivePath(entries, leaf);
  const index = path.findIndex((entry) => entry.id === target.id);
  if (index < 0) throw new Error("目标不在当前活动链上");
  if (path.slice(index + 1).some((entry) => entry.seal)) {
    throw new Error("后续已有发布价格，发布链保持冻结，不能重算其上游");
  }

  let next = [...entries];
  const oldTarget = voidEntry(target, operator, "备注或状态修订：原未发布版本归档", "superseded", at);
  next = next.map((entry) => (entry.id === target.id ? oldTarget : entry));

  let basis = revisionCopy({
    source: target,
    basisDigest: target.entryDigest,
    id: crypto.randomUUID(),
    seq: nextSeq(next, target.fuel),
    at,
    overrides: changes
  });
  next = [...next, basis];

  for (const descendant of path.slice(index + 1)) {
    const oldDescendant = voidEntry(
      descendant,
      operator,
      "上游未发布版本的备注或状态变更，本版失效并自动重算",
      "superseded",
      at
    );
    next = next.map((entry) => (entry.id === descendant.id ? oldDescendant : entry));
    basis = revisionCopy({
      source: descendant,
      basisDigest: basis.entryDigest,
      id: crypto.randomUUID(),
      seq: nextSeq(next, descendant.fuel),
      at
    });
    next = [...next, basis];
  }

  return next;
}

export function rollbackEntries(
  entries: PriceEntry[],
  targetId: string,
  operator: string,
  at = new Date().toISOString()
): PriceEntry[] {
  const target = entries.find((entry) => entry.id === targetId);
  if (!target) throw new Error("待退回记录不存在");
  if (target.void) throw new Error("记录已失效");
  if (target.seal) throw new Error("已发布记录不能退回；发布价格保持冻结");

  const leaves = findActiveLeaves(entries, target.fuel);
  const leaf = leaves[0];
  if (!leaf || leaves.length > 1) throw new Error("活动链存在分叉，不能自动重算");
  const path = findActivePath(entries, leaf);
  const index = path.findIndex((entry) => entry.id === target.id);
  if (index < 0) throw new Error("目标不在当前活动链上");
  if (path.slice(index + 1).some((entry) => entry.seal)) {
    throw new Error("后续已有发布价格，不能回退其上游");
  }

  let next = [...entries];
  next = next.map((entry) =>
    entry.id === target.id ? voidEntry(entry, operator, "未发布价格人工退回", "rollback", at) : entry
  );

  let basisDigest: string = target.basisDigest;
  let basis: PriceEntry;
  for (const descendant of path.slice(index + 1)) {
    next = next.map((entry) =>
      entry.id === descendant.id
        ? voidEntry(entry, operator, "上游未发布价格退回，本版失效并自动重算", "superseded", at)
        : entry
    );
    basis = revisionCopy({
      source: descendant,
      basisDigest,
      id: crypto.randomUUID(),
      seq: nextSeq(next, descendant.fuel),
      at
    });
    next = [...next, basis];
    basisDigest = basis.entryDigest;
  }

  return next;
}

export function publishEntry(
  entries: PriceEntry[],
  targetId: string,
  operator: string,
  at = new Date().toISOString()
): PriceEntry[] {
  const target = entries.find((entry) => entry.id === targetId);
  if (!target) throw new Error("待发布记录不存在");
  if (target.void) throw new Error("已失效记录不能发布");
  if (target.seal) throw new Error("记录已经发布并冻结");
  const leaves = findActiveLeaves(entries, target.fuel);
  if (leaves.length !== 1 || leaves[0].id !== target.id) {
    throw new Error("只能发布当前活动链头；请先处理后续未发布版本");
  }
  return entries.map((entry) => (entry.id === target.id ? sealedEntry(entry, operator, at) : entry));
}

function projectedOfflineEntryDigest(input: {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  businessStatus: string;
  notes: string;
  createdAt: string;
  seq: number;
  basisDigest: string;
}): string {
  return calculateEntryDigest({ ...input, origin: "offline" });
}

export function createOfflineOrder(
  entries: PriceEntry[],
  input: PriceInput,
  previousPending?: OfflineOrder,
  id = crypto.randomUUID(),
  at = new Date().toISOString()
): OfflineOrder {
  if (previousPending && previousPending.fuel !== input.fuel) {
    throw new Error("连续离线调价单必须属于同一种油品");
  }
  const leaf = activeLeafForFuel(entries, input.fuel);
  const basisDigest =
    previousPending?.projectedEntryDigest ?? leaf?.entryDigest ?? genesisDigest(input.fuel);
  const seq = previousPending ? previousPending.seq + 1 : nextSeq(entries, input.fuel);
  const reservedEntryId = crypto.randomUUID();
  const normalizedInput = { ...input, price: normalizePrice(input.price) };
  const projectedEntryDigest = projectedOfflineEntryDigest({
    ...normalizedInput,
    id: reservedEntryId,
    seq,
    basisDigest
  });
  const order = {
    id,
    ...normalizedInput,
    offlineAt: at,
    seq,
    basisDigest,
    previousOrderDigest: previousPending?.orderDigest,
    reservedEntryId,
    projectedEntryDigest
  };
  return { ...order, orderDigest: calculateOrderDigest(order), state: "pending" };
}

export type MergeResult = {
  entries: PriceEntry[];
  orders: OfflineOrder[];
};

export function mergeOfflineOrders(
  sourceEntries: PriceEntry[],
  sourceOrders: OfflineOrder[],
  at = new Date().toISOString()
): MergeResult {
  let entries = [...sourceEntries];
  const orders = [...sourceOrders];

  const pending = orders
    .filter((order) => order.state === "pending")
    .sort((a, b) => a.offlineAt.localeCompare(b.offlineAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  for (const order of pending) {
    const markReview = (reason: string) => {
      const index = orders.findIndex((item) => item.id === order.id);
      const review = {
        digest: calculateReviewDigest(order.id, at, "系统", reason),
        at,
        operator: "系统",
        reason
      };
      orders[index] = { ...order, state: "pending-review", review };
    };

    const selfDigest = calculateOrderDigest(order);
    if (order.orderDigest !== selfDigest) {
      markReview("离线单内容与订单摘要不一致，禁止覆盖现有价。");
      continue;
    }

    let expectedBasis: string;
    if (order.previousOrderDigest) {
      const previous = orders.find((item) => item.orderDigest === order.previousOrderDigest);
      if (!previous) {
        markReview("上一张离线调价单缺失。");
        continue;
      }
      if (previous.fuel !== order.fuel) {
        markReview("上一张离线单属于其他油品，后续单停在待核。");
        continue;
      }
      if (previous.state !== "merged") {
        markReview("上一张离线单未成功合并，后续单停在待核。");
        continue;
      }
      expectedBasis = previous.projectedEntryDigest;
    } else {
      const leaf = activeLeafForFuel(entries, order.fuel);
      expectedBasis = leaf?.entryDigest ?? genesisDigest(order.fuel);
    }

    if (order.basisDigest !== expectedBasis) {
      markReview(`回连时当前链头为 ${expectedBasis.slice(0, 10)}…，离线单基准接不上；保留现有价。`);
      continue;
    }

    const seq = nextSeq(entries, order.fuel);
    const entry = makeEntry({
      id: order.reservedEntryId,
      fuel: order.fuel,
      price: order.price,
      operator: order.operator,
      effectiveDate: order.effectiveDate,
      businessStatus: order.businessStatus,
      notes: order.notes,
      createdAt: order.createdAt,
      seq,
      basisDigest: expectedBasis,
      origin: "offline"
    });

    if (entry.entryDigest !== order.projectedEntryDigest) {
      markReview("合并后的实际条目摘要与离线投影摘要不一致，停止写入。");
      continue;
    }

    entries = [...entries, entry];
    const index = orders.findIndex((item) => item.id === order.id);
    orders[index] = { ...order, state: "merged", mergedEntryId: entry.id };
  }

  return { entries, orders };
}

export function rejectOfflineOrder(
  orders: OfflineOrder[],
  orderId: string,
  operator: string,
  reason: string,
  at = new Date().toISOString()
): OfflineOrder[] {
  return orders.map((order) => {
    if (order.id !== orderId || order.state !== "pending-review") return order;
    return {
      ...order,
      state: "rejected",
      review: {
        digest: calculateReviewDigest(orderId, at, operator, reason),
        at,
        operator,
        reason
      }
    };
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type MigrationResult =
  | { ok: true; entries: PriceEntry[]; migration: MigrationRecord }
  | { ok: false; error: string; legacy: LegacyRecord[] };

export function migrateLegacyRecords(
  legacy: unknown,
  legacyStorageKey: string,
  at = new Date().toISOString()
): MigrationResult {
  if (!Array.isArray(legacy)) {
    return { ok: false, error: "旧存档不是数组，已停止补链。", legacy: [] };
  }

  const records = legacy as LegacyRecord[];
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    const label = record.id && isNonEmptyString(record.id) ? record.id : `第 ${index + 1} 条`;
    if (!isNonEmptyString(record.fuel)) return { ok: false, error: `${label} 缺少油品。`, legacy: records };
    if (typeof record.price !== "number" || !Number.isFinite(record.price) || record.price <= 0) {
      return { ok: false, error: `${label} 挂牌价无效。`, legacy: records };
    }
    if (!isNonEmptyString(record.operator)) return { ok: false, error: `${label} 缺少操作员。`, legacy: records };
    if (!isNonEmptyString(record.effectiveDate)) return { ok: false, error: `${label} 缺少生效日期。`, legacy: records };
    if (!isNonEmptyString(record.status)) return { ok: false, error: `${label} 缺少状态。`, legacy: records };
    if (record.notes !== undefined && typeof record.notes !== "string") {
      return { ok: false, error: `${label} 备注类型无效。`, legacy: records };
    }
    if (!isNonEmptyString(record.createdAt)) return { ok: false, error: `${label} 缺少创建时间。`, legacy: records };
    const id = isNonEmptyString(record.id) ? record.id : `legacy-${index + 1}`;
    if (ids.has(id)) return { ok: false, error: `旧记录 ID 重复：${id}。`, legacy: records };
    ids.add(id);
  }

  const groups = new Map<string, LegacyRecord[]>();
  for (const record of records) {
    const fuel = String(record.fuel);
    groups.set(fuel, [...(groups.get(fuel) ?? []), record]);
  }

  const entries: PriceEntry[] = [];
  for (const [fuel, groupRecords] of groups) {
    groupRecords.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    // 旧数据没有显式父摘要；已回退记录不能成为后续有效价的链头。
    let activeBasisDigest = genesisDigest(fuel);
    groupRecords.forEach((record, zeroIndex) => {
      const id = isNonEmptyString(record.id) ? record.id : `legacy-${zeroIndex + 1}`;
      const seq = zeroIndex + 1;
      const status = String(record.status);
      const base = makeEntry({
        id: `mig-${id}-${fuel}-${seq}`,
        legacyId: id,
        fuel,
        price: record.price as number,
        operator: String(record.operator),
        effectiveDate: String(record.effectiveDate),
        businessStatus: status,
        notes: typeof record.notes === "string" ? record.notes : "",
        createdAt: String(record.createdAt),
        seq,
        basisDigest: activeBasisDigest,
        origin: "migration"
      });
      let entry = base;
      if (status === "生效中") {
        entry = {
          ...entry,
          seal: {
            digest: calculateSealDigest(entry.entryDigest, at, "系统迁移"),
            sealedAt: at,
            operator: "系统迁移",
            kind: "migration"
          }
        };
      }
      if (status === "已回退") {
        const reason = "旧数据迁移：原状态为已回退";
        entry = {
          ...entry,
          void: {
            digest: calculateVoidDigest(entry.entryDigest, at, "系统迁移", reason),
            voidedAt: at,
            operator: "系统迁移",
            reason,
            kind: "rollback"
          }
        };
      }
      entries.push(entry);
      if (status !== "已回退") {
        activeBasisDigest = entry.entryDigest;
      }
    });
  }

  const migrationId = crypto.randomUUID();
  const migration = {
    id: migrationId,
    at,
    legacyStorageKey,
    legacyCount: records.length,
    entryIds: entries.map((entry) => entry.id),
    digest: ""
  };
  migration.digest = calculateMigrationDigest({
    at: migration.at,
    legacyStorageKey: migration.legacyStorageKey,
    legacyCount: migration.legacyCount,
    entries: entries.map((entry) => ({ id: entry.id, legacyId: entry.legacyId, entryDigest: entry.entryDigest }))
  });

  return { ok: true, entries, migration };
}

export function verifyOrder(
  order: OfflineOrder,
  entries: PriceEntry[],
  orders: OfflineOrder[]
): OrderVerification {
  const issues: OrderIssue[] = [];
  const selfDigest = calculateOrderDigest(order);

  if (order.orderDigest !== selfDigest) {
    issues.push({ code: "ORDER_TAMPERED", message: "离线单内容与摘要不一致。" });
  }

  let expectedBasisDigest: string | undefined;
  if (order.previousOrderDigest) {
    const previous = orders.find((item) => item.orderDigest === order.previousOrderDigest);
    if (!previous) {
      issues.push({ code: "ORDER_PREVIOUS_MISSING", message: "上一张离线单缺失。" });
    } else if (previous.fuel !== order.fuel) {
      issues.push({ code: "ORDER_PREVIOUS_MISMATCH", message: "上一张离线单属于其他油品。" });
    } else if (previous.state !== "merged") {
      issues.push({ code: "ORDER_BLOCKED", message: "上一张离线单未合并，本单不能覆盖现有价。" });
    } else {
      const previousEntry = entries.find((entry) => entry.id === previous.mergedEntryId);
      if (!previousEntry) {
        issues.push({ code: "ORDER_ENTRY_MISSING", message: "上一张离线单合并出的记录缺失。" });
      } else {
        expectedBasisDigest = previousEntry.entryDigest;
      }
    }
  } else {
    const leaf = activeLeafForFuel(entries, order.fuel);
    expectedBasisDigest = leaf?.entryDigest ?? genesisDigest(order.fuel);
  }

  if (order.state === "merged") {
    const entry = entries.find((item) => item.id === order.mergedEntryId);
    if (!entry) {
      issues.push({ code: "ORDER_ENTRY_MISSING", message: "合并后的价格记录缺失。" });
    } else {
      const valuesMatch =
        entry.fuel === order.fuel &&
        entry.price === normalizePrice(order.price) &&
        entry.operator === order.operator &&
        entry.effectiveDate === order.effectiveDate &&
        entry.businessStatus === order.businessStatus &&
        entry.notes === order.notes &&
        entry.origin === "offline" &&
        entry.id === order.reservedEntryId &&
        entry.seq === order.seq &&
        entry.basisDigest === order.basisDigest &&
        entry.entryDigest === order.projectedEntryDigest;
      if (!valuesMatch) {
        issues.push({ code: "ORDER_ENTRY_MISMATCH", message: "合并记录与离线单内容或基准摘要不一致。" });
      }
    }
  }

  const pendingLike = order.state === "pending" || order.state === "pending-review";
  if (pendingLike && expectedBasisDigest && order.basisDigest !== expectedBasisDigest) {
    issues.push({
      code: "ORDER_REVIEW",
      message: `基准摘要接不上：期望 ${expectedBasisDigest.slice(0, 10)}…`
    });
  }

  let code: OrderVerificationCode;
  if (issues.length > 0) {
    code = issues[0].code;
  } else if (order.state === "merged") {
    code = "ORDER_MERGED";
  } else if (order.state === "rejected") {
    code = "ORDER_REJECTED";
  } else if (order.state === "pending-review") {
    code = "ORDER_REVIEW";
  } else if (order.previousOrderDigest) {
    code = "ORDER_PENDING_OFFLINE";
  } else {
    code = "ORDER_PENDING";
  }

  return { code, ok: issues.length === 0, issues, expectedBasisDigest };
}

export function createReport(entries: PriceEntry[], orders: OfflineOrder[], migrations: MigrationRecord[], at = new Date().toISOString()): PriceReport {
  const report: PriceReport = {
    version: 2,
    generatedAt: at,
    entries: entries.map((entry) => ({ ...entry, verification: verifyEntry(entry, entries, migrations) })),
    orders: orders.map((order) => ({ ...order, verification: verifyOrder(order, entries, orders) })),
    migrations,
    chains: summarizeChains(entries, migrations)
  };
  return {
    ...report,
    reportDigest: digestObject("price-report-v1", report)
  };
}
