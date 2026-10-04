<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  GENESIS,
  PUBLISHED,
  STATUSES,
  VERIFY_LABELS,
  buildReport,
  chainOf,
  computeDigest,
  countBreaks,
  createOfflineOrder,
  headDigestOf,
  headOf,
  mergeOfflineOrders,
  migrateUnlinked,
  nextSeq,
  recomputeCascade,
  shortDigest,
  verifyRecords,
  type MigrationReport,
  type OfflineOrder,
  type PriceRecord,
  type VerifyStatus
} from "./chain";

const project = {
  title: "油品价格维护",
  subtitle: "挂牌价、调价单与导出报表接成可校验的价格凭证链：每次调价记录上一版摘要，手工改档即刻显形。",
  industry: "石油",
  stack: ["Vue3", "Vite", "TypeScript", "SHA-256凭证链"],
  storageKey: "dfwlfront-9-price",
  ordersKey: "dfwlfront-9-offline-orders",
  fuels: ["92号汽油", "95号汽油", "98号汽油", "柴油"],
  metricLabels: ["在链价格", "待核单据", "链上断点"]
} as const;

const filters = ["全部油品", ...project.fuels];

// ---------------------------------------------------------------------------
// 存档读写
// ---------------------------------------------------------------------------

function seedRecords(): PriceRecord[] {
  const seeds: Array<Partial<PriceRecord> & Pick<PriceRecord, "fuel" | "price" | "operator" | "effectiveDate" | "status" | "notes">> = [
    { fuel: "92号汽油", price: 7.62, operator: "站长", effectiveDate: "2026-06-30", status: "已发布", notes: "正常调价" },
    { fuel: "柴油", price: 7.18, operator: "值班经理", effectiveDate: "2026-06-30", status: "待发布", notes: "等待复核" }
  ];
  return seeds.map((seed, index) => ({
    ...seed,
    id: `seed-${index + 1}`,
    createdAt: new Date(Date.now() - (seeds.length - index) * 86400000).toISOString()
  })) as PriceRecord[];
}

function loadRecords(): PriceRecord[] {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) return seedRecords();
  try {
    return JSON.parse(raw) as PriceRecord[];
  } catch {
    return [];
  }
}

function loadOrders(): OfflineOrder[] {
  const raw = localStorage.getItem(project.ordersKey);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as OfflineOrder[];
  } catch {
    return [];
  }
}

const records = ref<PriceRecord[]>(loadRecords());
const orders = ref<OfflineOrder[]>(loadOrders());
const migrationReport = ref<MigrationReport | null>(null);
const actionMessage = ref("");

function persist() {
  localStorage.setItem(project.storageKey, JSON.stringify(records.value));
  localStorage.setItem(project.ordersKey, JSON.stringify(orders.value));
}

// 旧数据没有摘要时先做一次迁移补链；补链失败的记录保持原样
function runMigration() {
  if (records.value.every((record) => record.digest)) return;
  const report = migrateUnlinked(records.value);
  migrationReport.value = report;
  persist();
}
runMigration();

// ---------------------------------------------------------------------------
// 校验视图
// ---------------------------------------------------------------------------

const verifyMap = computed(() => verifyRecords(records.value));

function verifyOf(record: PriceRecord) {
  return verifyMap.value.get(record.id) ?? { status: "unlinked" as VerifyStatus };
}

const chainViews = computed(() =>
  project.fuels
    .map((fuel) => {
      const chain = chainOf(records.value, fuel);
      if (!chain.length) return null;
      const nodes = chain.map((record, index) => {
        const prev = index > 0 ? chain[index - 1] : undefined;
        const linkOk = index === 0
          ? (record.prevDigest ?? GENESIS) === GENESIS
          : !!record.digest && !!prev?.digest && record.prevDigest === prev.digest;
        return {
          record,
          linkOk,
          verify: verifyOf(record).status
        };
      });
      return {
        fuel,
        nodes,
        headDigest: headDigestOf(records.value, fuel),
        intact: nodes.every((node) => node.verify === "ok")
      };
    })
    .filter((view): view is NonNullable<typeof view> => view !== null)
);

const metrics = computed(() => [
  records.value.filter((record) => record.digest).length,
  orders.value.filter((order) => order.state === "待核").length,
  countBreaks(records.value)
]);

const filter = ref(filters[0]);
const filteredRecords = computed(() => {
  const sorted = [...records.value].sort(
    (a, b) => (b.seq ?? Number.MAX_SAFE_INTEGER) - (a.seq ?? Number.MAX_SAFE_INTEGER)
  );
  if (filter.value === filters[0]) return sorted;
  return sorted.filter((record) => record.fuel === filter.value);
});

// ---------------------------------------------------------------------------
// 调价：每次调价记录上一版摘要
// ---------------------------------------------------------------------------

const form = reactive({ fuel: "", price: 0, operator: "", effectiveDate: "" });
const note = ref("");

function submit() {
  const record: PriceRecord = {
    id: crypto.randomUUID(),
    fuel: form.fuel,
    price: Number(form.price),
    operator: form.operator,
    effectiveDate: form.effectiveDate,
    status: STATUSES[0],
    notes: note.value || "暂无备注",
    createdAt: new Date().toISOString(),
    seq: nextSeq(records.value),
    revision: 0,
    prevDigest: headDigestOf(records.value, form.fuel)
  };
  record.digest = computeDigest(record);
  records.value = [record, ...records.value];
  Object.assign(form, { fuel: "", price: 0, operator: "", effectiveDate: "" });
  note.value = "";
  actionMessage.value = `已上链：${record.fuel} 接住上一版摘要 ${shortDigest(record.prevDigest)}`;
  persist();
}

// ---------------------------------------------------------------------------
// 状态/备注改动：未发布的后续价格失效重算，已发布保持冻结
// ---------------------------------------------------------------------------

function relinkAndCascade(record: PriceRecord) {
  record.revision = (record.revision ?? 0) + 1;
  record.digest = computeDigest(record);
  const chain = chainOf(records.value, record.fuel);
  const index = chain.findIndex((item) => item.id === record.id);
  const result = recomputeCascade(records.value, record.fuel, index + 1);
  actionMessage.value = `已重算 ${result.recomputed} 条未发布价格`
    + (result.frozenBreak ? "；已发布价格保持冻结，断点位置见凭证链视图" : "");
  persist();
}

function publish(record: PriceRecord) {
  if (record.status !== "待发布") return;
  record.status = PUBLISHED; // 发布即冻结，此后不再重算
  relinkAndCascade(record);
}

function rollback(record: PriceRecord) {
  if (record.status !== "待发布") return;
  record.status = "已回退";
  relinkAndCascade(record);
}

const editingId = ref("");
const editingNotes = ref("");

function startEdit(record: PriceRecord) {
  editingId.value = record.id;
  editingNotes.value = record.notes;
}

function saveEdit(record: PriceRecord) {
  record.notes = editingNotes.value || "暂无备注";
  editingId.value = "";
  relinkAndCascade(record);
}

function remove(record: PriceRecord) {
  if (record.status === PUBLISHED) return; // 已发布冻结，不可删
  const chain = chainOf(records.value, record.fuel);
  const index = chain.findIndex((item) => item.id === record.id);
  records.value = records.value.filter((item) => item.id !== record.id);
  const result = recomputeCascade(records.value, record.fuel, index);
  actionMessage.value = `已删除并重算 ${result.recomputed} 条未发布价格`
    + (result.frozenBreak ? "；已发布价格保持冻结" : "");
  persist();
}

function copyVoucher(record: PriceRecord) {
  const verify = verifyOf(record);
  navigator.clipboard?.writeText(JSON.stringify({
    ...record,
    verify: VERIFY_LABELS[verify.status],
    expectedPrev: verify.expectedPrev ?? null
  }, null, 2));
}

// ---------------------------------------------------------------------------
// 离线调价单：回连合并，摘要接不上就停在待核
// ---------------------------------------------------------------------------

const offlineForm = reactive({ fuel: "", price: 0, operator: "", effectiveDate: "" });
const offlineNote = ref("");
const offlineBase = ref("head");

function baseDigestFor(fuel: string, mode: string): string {
  if (!fuel) return GENESIS;
  if (mode === "previous") {
    const head = headOf(records.value, fuel);
    return head?.prevDigest ?? GENESIS; // 模拟只同步到上一版的离线终端
  }
  return headDigestOf(records.value, fuel);
}

function submitOffline() {
  const order = createOfflineOrder({
    fuel: offlineForm.fuel,
    price: Number(offlineForm.price),
    operator: offlineForm.operator,
    effectiveDate: offlineForm.effectiveDate,
    notes: offlineNote.value || "离线开单",
    baseDigest: baseDigestFor(offlineForm.fuel, offlineBase.value)
  });
  orders.value = [order, ...orders.value];
  Object.assign(offlineForm, { fuel: "", price: 0, operator: "", effectiveDate: "" });
  offlineNote.value = "";
  actionMessage.value = `离线单已开出，基准摘要 ${shortDigest(order.baseDigest)}，等待回连合并`;
  persist();
}

function reconnectMerge() {
  const result = mergeOfflineOrders(records.value, orders.value);
  records.value = [...records.value];
  orders.value = [...orders.value];
  actionMessage.value = `回连合并：并入 ${result.merged} 条，${result.held} 条摘要接不上停在待核（未覆盖现有价格）`;
  persist();
}

function removeOrder(id: string) {
  orders.value = orders.value.filter((order) => order.id !== id);
  persist();
}

// ---------------------------------------------------------------------------
// 导出报表：保留整条链的摘要
// ---------------------------------------------------------------------------

function exportReport() {
  const report = buildReport(records.value, orders.value);
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `price-voucher-report-${report.generatedAt.slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  actionMessage.value = `报表已导出，整链总摘要 ${shortDigest(report.reportDigest)}`;
}

function copyChainSummary() {
  const report = buildReport(records.value, orders.value);
  const lines = report.chains.map((chain) =>
    `${chain.fuel}：${chain.intact ? "完整" : "存在断点"} 头摘要 ${chain.headDigest}`
  );
  lines.push(`整链总摘要 ${report.reportDigest}`);
  navigator.clipboard?.writeText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 演练：模拟有人手工改本机存档（绕过应用直接改 localStorage，不碰摘要）
// ---------------------------------------------------------------------------

function simulateTamper() {
  const raw = localStorage.getItem(project.storageKey);
  if (!raw) return;
  const data = JSON.parse(raw) as PriceRecord[];
  const target = data.find((record) => record.digest);
  if (!target) return;
  if (!window.confirm(`模拟手工改档：把「${target.fuel}」存档价格 +0.5 且不改摘要，刷新后查看校验结果？`)) return;
  target.price = Number(target.price) + 0.5;
  localStorage.setItem(project.storageKey, JSON.stringify(data));
  location.reload();
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业 · 价格凭证链</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong :class="{ alarm: index === 2 && metrics[index] > 0 }">{{ metrics[index] }}</strong>
        </article>
      </section>

      <div v-if="migrationReport" class="banner info">
        <div>
          迁移补链：新补 {{ migrationReport.migrated }} 条 · 已在链 {{ migrationReport.alreadyLinked }} 条
          · 失败 {{ migrationReport.failures.length }} 条（原记录未改动）
          <ul v-if="migrationReport.failures.length">
            <li v-for="failure in migrationReport.failures" :key="failure.id">{{ failure.id }}：{{ failure.reason }}</li>
          </ul>
        </div>
        <button class="secondary" type="button" @click="migrationReport = null">知道了</button>
      </div>

      <div v-if="actionMessage" class="banner ok">
        <span>{{ actionMessage }}</span>
        <button class="secondary" type="button" @click="actionMessage = ''">关闭</button>
      </div>

      <section class="workspace">
        <div class="side">
          <form class="panel" @submit.prevent="submit">
            <h2>调整油品价格</h2>
            <div class="form-grid">
              <label>
                油品
                <select v-model="form.fuel" required>
                  <option value="">请选择</option>
                  <option v-for="fuel in project.fuels" :key="fuel">{{ fuel }}</option>
                </select>
              </label>
              <label>
                挂牌价
                <input v-model="form.price" type="number" step="0.01" min="0.01" required />
              </label>
              <label>
                操作员
                <input v-model="form.operator" required />
              </label>
              <label>
                生效日期
                <input v-model="form.effectiveDate" type="date" required />
              </label>
              <label>
                备注
                <textarea v-model="note" placeholder="填写处理说明或现场备注" />
              </label>
              <p v-if="form.fuel" class="hint">
                上链接住 {{ form.fuel }} 当前链头：{{ shortDigest(headDigestOf(records, form.fuel)) }}
              </p>
              <button type="submit">保存价格（上链）</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitOffline">
            <h2>离线调价单</h2>
            <div class="form-grid">
              <label>
                油品
                <select v-model="offlineForm.fuel" required>
                  <option value="">请选择</option>
                  <option v-for="fuel in project.fuels" :key="fuel">{{ fuel }}</option>
                </select>
              </label>
              <label>
                挂牌价
                <input v-model="offlineForm.price" type="number" step="0.01" min="0.01" required />
              </label>
              <label>
                操作员
                <input v-model="offlineForm.operator" required />
              </label>
              <label>
                生效日期
                <input v-model="offlineForm.effectiveDate" type="date" required />
              </label>
              <label>
                基准摘要（终端所知的链头）
                <select v-model="offlineBase">
                  <option value="head">当前链头（正常）</option>
                  <option value="previous">上一版链头（模拟未同步终端）</option>
                </select>
              </label>
              <label>
                备注
                <textarea v-model="offlineNote" placeholder="离线现场备注" />
              </label>
              <button type="submit">开出离线单</button>
            </div>

            <div v-if="orders.length" class="orders">
              <div class="orders-head">
                <h3>待回连 / 待核单据</h3>
                <button type="button" @click="reconnectMerge">回连合并</button>
              </div>
              <article v-for="order in orders" :key="order.id" class="order" :class="{ held: order.state === '待核' }">
                <div class="record-head">
                  <p class="record-title">{{ order.fuel }} / {{ order.price }}</p>
                  <span class="verify" :class="order.state === '待核' ? 'broken' : order.state === '已合并' ? 'ok' : 'unlinked'">
                    {{ order.state }}
                  </span>
                </div>
                <div class="details">
                  <span>基准摘要: {{ shortDigest(order.baseDigest) }}</span>
                  <span>单据摘要: {{ shortDigest(order.digest) }}</span>
                </div>
                <p v-if="order.mergeError" class="merge-error">{{ order.mergeError }}</p>
                <div class="actions">
                  <button class="danger" type="button" @click="removeOrder(order.id)">作废</button>
                </div>
              </article>
            </div>
          </form>

          <section class="panel">
            <h2>凭证与报表</h2>
            <div class="form-grid">
              <button type="button" @click="exportReport">导出报表（含整链摘要）</button>
              <button class="secondary" type="button" @click="copyChainSummary">复制各链头摘要</button>
              <button class="secondary" type="button" @click="runMigration">重新检测补链</button>
              <button class="danger" type="button" @click="simulateTamper">演练：手工改本机存档</button>
            </div>
          </section>
        </div>

        <section class="list-panel">
          <div class="toolbar">
            <h2>凭证链视图</h2>
            <select v-model="filter">
              <option v-for="item in filters" :key="item">{{ item }}</option>
            </select>
          </div>

          <div class="chains">
            <div v-for="view in chainViews" :key="view.fuel" class="chain">
              <div class="chain-head">
                <strong>{{ view.fuel }}</strong>
                <span class="verify" :class="view.intact ? 'ok' : 'broken'">{{ view.intact ? "链完整" : "存在断点" }}</span>
                <code>头摘要 {{ shortDigest(view.headDigest) }}</code>
              </div>
              <div class="chain-nodes">
                <template v-for="(node, index) in view.nodes" :key="node.record.id">
                  <span v-if="index > 0" class="chain-link" :class="{ bad: !node.linkOk }">
                    {{ node.linkOk ? "→" : "✗ 断" }}
                  </span>
                  <span
                    class="chain-node"
                    :class="[node.verify, { frozen: node.record.status === '已发布' }]"
                    :title="`#${node.record.seq ?? '?'} ${node.record.status} · ${node.record.digest ?? '未补链'}`"
                  >
                    {{ node.record.status === '已发布' ? '🔒' : '' }}#{{ node.record.seq ?? "?" }}
                    {{ shortDigest(node.record.digest) }}
                  </span>
                </template>
              </div>
            </div>
          </div>

          <div class="record-grid">
            <div v-if="filteredRecords.length === 0" class="empty">暂无匹配数据</div>
            <article
              v-for="record in filteredRecords"
              :key="record.id"
              class="record"
              :class="verifyOf(record).status"
            >
              <div class="record-head">
                <p class="record-title">{{ record.fuel }} / {{ record.price }} 元</p>
                <span class="verify" :class="verifyOf(record).status">
                  {{ VERIFY_LABELS[verifyOf(record).status] }}
                </span>
              </div>
              <div class="details">
                <span>状态: {{ record.status }}{{ record.status === '已发布' ? '（冻结）' : '' }}</span>
                <span>操作员: {{ record.operator }}</span>
                <span>生效日期: {{ record.effectiveDate }}</span>
                <span>链序号: #{{ record.seq ?? "未补链" }} · 版本 v{{ record.revision ?? 0 }}</span>
                <span>本版摘要: {{ shortDigest(record.digest) }}</span>
                <span>上一版摘要: {{ shortDigest(record.prevDigest) }}</span>
              </div>

              <p v-if="verifyOf(record).status === 'tampered'" class="break-detail">
                存档内容与摘要不符：这条记录疑似被手工改动，改动点就在本条。
              </p>
              <p v-else-if="verifyOf(record).status === 'broken'" class="break-detail">
                断点位置：本条。期望接上 {{ shortDigest(verifyOf(record).expectedPrev) }}，
                存档写的却是 {{ shortDigest(verifyOf(record).actualPrev) }}。
              </p>

              <div v-if="editingId === record.id" class="edit-box">
                <textarea v-model="editingNotes" />
                <div class="actions">
                  <button type="button" @click="saveEdit(record)">保存备注并重算后续</button>
                  <button class="secondary" type="button" @click="editingId = ''">取消</button>
                </div>
              </div>
              <p v-else class="note">{{ record.notes }}</p>

              <div class="actions">
                <button v-if="record.status === '待发布'" type="button" @click="publish(record)">发布（冻结）</button>
                <button v-if="record.status === '待发布'" class="secondary" type="button" @click="rollback(record)">回退</button>
                <button
                  v-if="record.status !== '已发布'"
                  class="secondary"
                  type="button"
                  @click="startEdit(record)"
                >改备注</button>
                <button class="secondary" type="button" @click="copyVoucher(record)">复制凭证</button>
                <button
                  v-if="record.status !== '已发布'"
                  class="danger"
                  type="button"
                  @click="remove(record)"
                >删除</button>
              </div>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
