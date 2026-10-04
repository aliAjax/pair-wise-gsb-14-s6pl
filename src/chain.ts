import { sha256Hex } from "./sha256";

// ---------------------------------------------------------------------------
// 价格凭证链：挂牌价记录 + 调价摘要链 + 离线调价单 + 导出报表
// ---------------------------------------------------------------------------

export const GENESIS = "GENESIS";

/** 业务状态：已发布即冻结，未发布（待发布/已回退）可被级联重算 */
export const STATUSES = ["待发布", "已发布", "已回退"] as const;
export const PUBLISHED = "已发布";

export type PriceRecord = {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  status: string;
  notes: string;
  createdAt: string;
  /** 链内序号，迁移时按时间补齐，之后只增不改 */
  seq?: number;
  /** 摘要版本号，每次重算 +1，让重算后的摘要必然变化 */
  revision?: number;
  prevDigest?: string;
  digest?: string;
};

export type OfflineOrder = {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  notes: string;
  createdAt: string;
  /** 离线开单时终端所知的链头摘要 */
  baseDigest: string;
  /** 开单内容摘要，回连后用于核对单据本身未被改动 */
  digest: string;
  state: "待回连" | "待核" | "已合并";
  mergeError?: string;
};

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/** 固定字段顺序的规范化序列化，避免 key 顺序影响摘要 */
function canonical(record: {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  status: string;
  notes: string;
  createdAt: string;
  revision?: number;
  prevDigest?: string;
}): string {
  return JSON.stringify({
    v: 1,
    id: record.id,
    fuel: record.fuel,
    price: Number(record.price),
    operator: record.operator,
    effectiveDate: record.effectiveDate,
    status: record.status,
    notes: record.notes,
    createdAt: record.createdAt,
    revision: record.revision ?? 0,
    prevDigest: record.prevDigest ?? GENESIS
  });
}

export function computeDigest(record: Parameters<typeof canonical>[0]): string {
  return sha256Hex(canonical(record));
}

export function shortDigest(digest?: string): string {
  if (!digest) return "—";
  return digest === GENESIS ? "GENESIS" : digest.slice(0, 10);
}

// ---------------------------------------------------------------------------
// 链结构
// ---------------------------------------------------------------------------

/** 同一油品按 seq 升序排列的链；无 seq 的旧记录排在最后（等待补链） */
export function chainOf(records: PriceRecord[], fuel: string): PriceRecord[] {
  return records
    .filter((record) => record.fuel === fuel)
    .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}

export function allFuels(records: PriceRecord[]): string[] {
  return [...new Set(records.map((record) => record.fuel))];
}

export function headOf(records: PriceRecord[], fuel: string): PriceRecord | undefined {
  const chain = chainOf(records, fuel).filter((record) => record.digest);
  return chain[chain.length - 1];
}

export function headDigestOf(records: PriceRecord[], fuel: string): string {
  return headOf(records, fuel)?.digest ?? GENESIS;
}

export function nextSeq(records: PriceRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.seq ?? 0), 0) + 1;
}

// ---------------------------------------------------------------------------
// 校验：内容是否被改（digest 重算比对）+ 链接是否断（prevDigest 比对）
// ---------------------------------------------------------------------------

export type VerifyStatus = "ok" | "tampered" | "broken" | "unlinked";

export type VerifyResult = {
  status: VerifyStatus;
  /** 断点时期望接上的上一版摘要 */
  expectedPrev?: string;
  /** 记录里实际写的上一版摘要 */
  actualPrev?: string;
};

export const VERIFY_LABELS: Record<VerifyStatus, string> = {
  ok: "校验通过",
  tampered: "内容被改",
  broken: "链断点",
  unlinked: "未补链"
};

export function verifyRecords(records: PriceRecord[]): Map<string, VerifyResult> {
  const results = new Map<string, VerifyResult>();
  for (const fuel of allFuels(records)) {
    let prevDigest = GENESIS;
    for (const record of chainOf(records, fuel)) {
      if (!record.digest) {
        results.set(record.id, { status: "unlinked" });
        continue; // 未补链的记录不参与后续链接比对
      }
      const actualPrev = record.prevDigest ?? GENESIS;
      if (computeDigest(record) !== record.digest) {
        results.set(record.id, { status: "tampered" });
      } else if (actualPrev !== prevDigest) {
        results.set(record.id, { status: "broken", expectedPrev: prevDigest, actualPrev });
      } else {
        results.set(record.id, { status: "ok" });
      }
      // 链接比对基于存档中的摘要值，内容是否被改不影响链的走向
      prevDigest = record.digest;
    }
  }
  return results;
}

export function countBreaks(records: PriceRecord[]): number {
  let breaks = 0;
  for (const result of verifyRecords(records).values()) {
    if (result.status === "broken" || result.status === "tampered") breaks += 1;
  }
  return breaks;
}

// ---------------------------------------------------------------------------
// 级联重算：备注/状态改动或删除后，未发布的后续价格失效重算，已发布冻结
// ---------------------------------------------------------------------------

export type CascadeResult = {
  recomputed: number;
  frozenBreak: boolean;
};

/**
 * 从 chain[index] 开始重算同一油品链：
 * - 未发布记录：prevDigest 重新接线、revision+1、重算 digest（即“失效重算”）
 * - 已发布记录：保持冻结，级联到此停止，断点会在校验视图中显形
 */
export function recomputeCascade(
  records: PriceRecord[],
  fuel: string,
  startIndex: number
): CascadeResult {
  const chain = chainOf(records, fuel);
  let recomputed = 0;
  let frozenBreak = false;
  for (let i = Math.max(0, startIndex); i < chain.length; i++) {
    const record = chain[i];
    if (record.seq === undefined) continue; // 未补链的旧记录不在链上，跳过
    if (record.status === PUBLISHED) {
      frozenBreak = true;
      break;
    }
    const prev = i === 0 ? undefined : chain[i - 1];
    record.prevDigest = i === 0 ? GENESIS : prev?.digest ?? GENESIS;
    record.revision = (record.revision ?? 0) + 1;
    record.digest = computeDigest(record);
    recomputed += 1;
  }
  return { recomputed, frozenBreak };
}

// ---------------------------------------------------------------------------
// 迁移补链：旧数据没有摘要时补 seq/prevDigest/digest；失败的记录原样保留
// ---------------------------------------------------------------------------

export type MigrationReport = {
  migrated: number;
  alreadyLinked: number;
  failures: { id: string; reason: string }[];
  ranAt: string;
};

const LEGACY_STATUS: Record<string, string> = {
  生效中: "已发布",
  待确认: "待发布",
  已回退: "已回退"
};

function validateForMigration(record: PriceRecord): string | null {
  if (!record.id) return "缺少记录 id";
  if (!record.fuel) return "缺少油品";
  if (!Number.isFinite(Number(record.price)) || Number(record.price) <= 0) return "挂牌价无效";
  if (!record.effectiveDate) return "缺少生效日期";
  if (!record.createdAt || Number.isNaN(Date.parse(record.createdAt))) return "创建时间无效";
  return null;
}

/**
 * 对每个油品内未补链的记录按 createdAt 升序补链。
 * 任何一条校验不过或前序无摘要可接，都不改写原记录，只记入 failures。
 */
export function migrateUnlinked(records: PriceRecord[]): MigrationReport {
  const report: MigrationReport = {
    migrated: 0,
    alreadyLinked: 0,
    failures: [],
    ranAt: new Date().toISOString()
  };
  let seq = nextSeq(records);
  for (const fuel of allFuels(records)) {
    const linked = chainOf(records, fuel).filter((record) => record.digest);
    report.alreadyLinked += linked.length;
    let prevDigest = linked.length ? linked[linked.length - 1].digest! : GENESIS;

    const pending = records
      .filter((record) => record.fuel === fuel && !record.digest)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    for (const record of pending) {
      const invalid = validateForMigration(record);
      if (invalid) {
        report.failures.push({ id: record.id || "(无id)", reason: `${fuel}：${invalid}，原记录未改动` });
        continue; // 不改写原记录；有效记录仍按时间顺序彼此接续，失败记录留在链外待人工处理
      }
      const status = STATUSES.includes(record.status as (typeof STATUSES)[number])
        ? record.status
        : LEGACY_STATUS[record.status] ?? "待发布";
      record.status = status;
      record.seq = seq++;
      record.revision = record.revision ?? 0;
      record.prevDigest = prevDigest;
      record.digest = computeDigest(record);
      prevDigest = record.digest;
      report.migrated += 1;
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// 离线调价单：回连合并时摘要接不上就停在待核，绝不覆盖现有价
// ---------------------------------------------------------------------------

/** 离线单摘要：只覆盖开单时的不可变内容，不随回连状态变化 */
export function computeOrderDigest(order: {
  id: string;
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  notes: string;
  createdAt: string;
  baseDigest: string;
}): string {
  return sha256Hex(JSON.stringify({
    v: 1,
    kind: "offline-order",
    id: order.id,
    fuel: order.fuel,
    price: Number(order.price),
    operator: order.operator,
    effectiveDate: order.effectiveDate,
    notes: order.notes,
    createdAt: order.createdAt,
    baseDigest: order.baseDigest
  }));
}

export function createOfflineOrder(input: {
  fuel: string;
  price: number;
  operator: string;
  effectiveDate: string;
  notes: string;
  baseDigest: string;
}): OfflineOrder {
  const order: OfflineOrder = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    state: "待回连",
    digest: ""
  };
  order.digest = computeOrderDigest(order);
  return order;
}

export type MergeResult = {
  merged: number;
  held: number;
};

/** 合并离线单：只追加，不改写任何现有记录；摘要不一致的单据停在待核 */
export function mergeOfflineOrders(records: PriceRecord[], orders: OfflineOrder[]): MergeResult {
  const result: MergeResult = { merged: 0, held: 0 };
  let seq = nextSeq(records);
  for (const order of orders) {
    if (order.state === "已合并") continue;
    // 先核对单据本身在离线期间没被改动
    if (computeOrderDigest(order) !== order.digest) {
      order.state = "待核";
      order.mergeError = "单据摘要与内容不符，疑似离线期间被改动，未合并";
      result.held += 1;
      continue;
    }
    const headDigest = headDigestOf(records, order.fuel);
    if (order.baseDigest !== headDigest) {
      order.state = "待核";
      order.mergeError = `摘要接不上：单据基准 ${shortDigest(order.baseDigest)} ≠ 当前链头 ${shortDigest(headDigest)}，已停在待核，未覆盖现有价格`;
      result.held += 1;
      continue;
    }
    records.push({
      id: crypto.randomUUID(),
      fuel: order.fuel,
      price: order.price,
      operator: order.operator,
      effectiveDate: order.effectiveDate,
      status: "待发布",
      notes: `${order.notes}（离线单 ${order.id.slice(0, 8)} 回连合并）`,
      createdAt: order.createdAt,
      seq: seq++,
      revision: 0,
      prevDigest: order.baseDigest,
      digest: ""
    });
    const record = records[records.length - 1];
    record.digest = computeDigest(record);
    order.state = "已合并";
    order.mergeError = undefined;
    result.merged += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 导出报表：保留每条链的头摘要与整链总摘要，附带导出时刻的校验结论
// ---------------------------------------------------------------------------

export function buildReport(records: PriceRecord[], orders: OfflineOrder[]) {
  const verify = verifyRecords(records);
  const chains = allFuels(records).map((fuel) => {
    const chain = chainOf(records, fuel);
    const breaks = chain
      .filter((record) => {
        const status = verify.get(record.id)?.status;
        return status === "broken" || status === "tampered";
      })
      .map((record) => ({
        seq: record.seq ?? null,
        recordId: record.id,
        status: VERIFY_LABELS[verify.get(record.id)!.status],
        expectedPrev: verify.get(record.id)?.expectedPrev ?? null,
        actualPrev: verify.get(record.id)?.actualPrev ?? null
      }));
    return {
      fuel,
      length: chain.length,
      headDigest: headDigestOf(records, fuel),
      intact: breaks.length === 0 && chain.every((record) => record.digest),
      breaks
    };
  });
  const rows = [...records]
    .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
    .map((record) => ({
      ...record,
      verify: VERIFY_LABELS[verify.get(record.id)?.status ?? "unlinked"]
    }));
  const body = {
    type: "price-voucher-report",
    version: 1,
    generatedAt: new Date().toISOString(),
    chains,
    records: rows,
    offlineOrders: orders.map((order) => ({
      id: order.id,
      fuel: order.fuel,
      price: order.price,
      state: order.state,
      baseDigest: order.baseDigest,
      digest: order.digest,
      mergeError: order.mergeError ?? null
    }))
  };
  const reportDigest = sha256Hex(JSON.stringify(body));
  return { ...body, reportDigest };
}
