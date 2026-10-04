<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { shortDigest } from "./chain/crypto";
import {
  BUSINESS_STATUSES,
  PriceEntry,
  VerificationCode,
  groupByFuel
} from "./chain/priceChain";
import { initializeStore, usePriceStore } from "./chain/store";

initializeStore();
const store = usePriceStore();
const { state } = store;

const fuels = ["92号汽油", "95号汽油", "98号汽油", "柴油"];
const filter = ref("全部油品");
const reportDigest = ref("");

const form = reactive({
  fuel: fuels[0],
  price: 7.68,
  operator: "值班经理",
  effectiveDate: "2026-10-04",
  businessStatus: "待确认",
  notes: ""
});

const editTargetId = ref<string | null>(null);
const editForm = reactive({ notes: "", businessStatus: "待确认" });
const rejectReason = ref("基准摘要不一致，需现场复核");

const groupedEntries = computed(() => groupByFuel(state.entries));
const visibleChains = computed(() =>
  store.chains.value.filter((chain) => filter.value === "全部油品" || chain.fuel === filter.value)
);

const filteredOrders = computed(() =>
  [...state.orders]
    .filter((order) => filter.value === "全部油品" || order.fuel === filter.value)
    .sort((a, b) => b.offlineAt.localeCompare(a.offlineAt))
);

const metrics = computed(() => [
  { label: "价格版本", value: state.entries.length },
  { label: "校验断点", value: store.brokenCount.value },
  { label: "待核离线单", value: state.orders.filter((order) => order.state === "pending-review").length },
  { label: "凭证链", value: store.healthy.value ? "全部连通" : "存在断点" }
]);

const verificationLabels: Record<VerificationCode, string> = {
  VALID: "链证完整",
  VOIDED: "已归档",
  ENTRY_TAMPERED: "本版摘要不一致",
  PUBLISH_TAMPERED: "发布戳异常",
  VOID_TAMPERED: "失效戳异常",
  BASIS_MISSING: "上一版缺失",
  BASIS_FUEL_MISMATCH: "跨油品链接",
  BASIS_MISMATCH: "上一版摘要不匹配",
  BRANCH_BROKEN: "分支已断裂",
  MULTIPLE_HEADS: "存在多个链头",
  REVISION_MISSING: "修订来源缺失",
  REVISION_MISMATCH: "修订摘要不匹配",
  MIGRATION_TAMPERED: "迁移补链异常",
  FROZEN_PUBLISHED: "冻结记录被改写"
};

function verificationOf(entry: PriceEntry) {
  return store.entryVerification.value.get(entry.id);
}

function chainEntries(fuel: string): PriceEntry[] {
  return groupedEntries.value.get(fuel) ?? [];
}

function isActiveLeaf(entry: PriceEntry): boolean {
  const verification = verificationOf(entry);
  return Boolean(verification?.active && verification.ok);
}

function verificationCode(entry: PriceEntry): VerificationCode {
  return verificationOf(entry)?.code ?? "ENTRY_TAMPERED";
}

function statusText(entry: PriceEntry): string {
  if (entry.void) return entry.void.kind === "rollback" ? "已回退" : "已失效";
  return entry.seal ? "已发布" : "未发布";
}

function statusClass(entry: PriceEntry): string {
  const verification = verificationOf(entry);
  if (!verification?.ok) return "danger";
  if (entry.void) return "muted";
  if (entry.seal) return "success";
  return "warning";
}

function startEdit(entry: PriceEntry) {
  editTargetId.value = entry.id;
  editForm.notes = entry.notes;
  editForm.businessStatus = String(entry.businessStatus);
}

function cancelEdit() {
  editTargetId.value = null;
}

function saveEdit() {
  if (!editTargetId.value) return;
  store.editMetadata(editTargetId.value, { ...editForm });
  editTargetId.value = null;
}

function submitPrimary() {
  const price = Number(form.price);
  if (!Number.isFinite(price) || price <= 0) {
    store.state.message = "挂牌价必须是大于 0 的数字。";
    store.state.messageKind = "error";
    return;
  }
  const payload = { ...form, price };
  if (state.offline) {
    store.queueOfflineOrder(payload);
  } else {
    store.addPrice(payload);
  }
}

function downloadReport() {
  const report = store.exportReport();
  if (!report) return;
  reportDigest.value = report.reportDigest ?? "";
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `price-chain-report-${report.generatedAt.replaceAll(":", "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function rejectOrder(id: string) {
  store.rejectOrder(id, rejectReason.value || "人工复核不通过");
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 可校验价格凭证链</p>
          <h1>油品价格凭证链</h1>
          <p class="subtitle">
            每次调价记录上一版摘要；发布价格加盖冻结戳。备注或状态变更只重算后续未发布版本，离线单摘要接不上时停在待核且不覆盖现有价。
          </p>
        </div>
        <div class="stack">
          <span class="tag">SHA-256</span>
          <span class="tag">版本链</span>
          <span class="tag">发布冻结</span>
          <span class="tag">离线合并</span>
        </div>
      </header>

      <div v-if="state.readOnly" class="banner danger-banner">
        <strong>补链失败，当前只读：</strong>{{ state.loadError }}
        <span>旧记录未被改写；请修复原存档后再重新加载。</span>
      </div>

      <section class="metrics">
        <article v-for="item in metrics" :key="item.label" class="metric" :class="{ broken: item.label === '凭证链' && !store.healthy.value }">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </article>
      </section>

      <section class="controlbar panel">
        <div class="control-group">
          <label>
            工作模式
            <select :value="state.offline ? 'offline' : 'online'" :disabled="state.readOnly" @change="store.setOffline(($event.target as HTMLSelectElement).value === 'offline')">
              <option value="online">在线：直接形成调价版本</option>
              <option value="offline">离线：先生成离线调价单</option>
            </select>
          </label>
          <button type="button" class="secondary" :disabled="state.readOnly" @click="downloadReport">导出整条链报表</button>
          <button type="button" class="secondary" :disabled="state.readOnly" @click="store.resetDemo()">重置演示数据</button>
        </div>
        <p v-if="reportDigest" class="report-digest">报表整链摘要：<code>{{ reportDigest }}</code></p>
      </section>

      <section class="workspace">
        <form class="panel form-panel" @submit.prevent="submitPrimary">
          <h2>{{ state.offline ? "新建离线调价单" : "调整油品价格" }}</h2>
          <div class="form-grid">
            <label>
              油品
              <select v-model="form.fuel" required>
                <option v-for="fuel in fuels" :key="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              挂牌价
              <input v-model.number="form.price" type="number" min="0.01" step="0.01" required />
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
              初始业务状态
              <select v-model="form.businessStatus">
                <option v-for="status in BUSINESS_STATUSES.filter((item) => item !== '已回退')" :key="status">{{ status }}</option>
              </select>
            </label>
            <label class="wide">
              备注
              <textarea v-model="form.notes" placeholder="填写处理说明或现场备注" />
            </label>
            <button type="submit" :disabled="state.readOnly">{{ state.offline ? "加入离队列" : "保存价格版本" }}</button>
            <button
              v-if="state.offline"
              type="button"
              class="secondary"
              :disabled="state.readOnly"
              @click="store.queueBrokenOfflineOrder({ ...form, price: Number(form.price) })"
            >
              造一张断链离线单
            </button>
            <button v-if="state.offline" type="button" :disabled="state.readOnly" @click="store.reconnect()">
              回连并合并
            </button>
          </div>
          <p class="hint">
            离线单保存创建时链头摘要；回连时若链头不同或订单内容被改，只会进入“待核”，不会覆盖现有价。
          </p>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <div>
              <h2>价格凭证链</h2>
              <p class="toolbar-note">从旧到新展示；每版包含上一版摘要、本版摘要和发布/失效戳。</p>
            </div>
            <select v-model="filter">
              <option>全部油品</option>
              <option v-for="fuel in fuels" :key="fuel">{{ fuel }}</option>
            </select>
          </div>

          <div v-if="state.migrations.length" class="migration">
            <span class="chain-pill success">已完成旧数据补链</span>
            <span>{{ state.migrations.length }} 次迁移 · {{ state.migrations[0].legacyCount }} 条旧记录</span>
            <code>{{ shortDigest(state.migrations[0].digest, 12) }}</code>
          </div>

          <div v-for="chain in visibleChains" :key="chain.fuel" class="chain-block">
            <div class="chain-head">
              <div>
                <h3>{{ chain.fuel }}</h3>
                <p>
                  根 <code>{{ chain.rootDigest ? shortDigest(chain.rootDigest, 8) : "缺失" }}</code>
                  → 当前头 <code>{{ chain.headDigest ? shortDigest(chain.headDigest, 10) : "无活动头" }}</code>
                </p>
              </div>
              <span class="chain-pill" :class="chain.healthy ? 'success' : 'danger'">
                {{ chain.healthy ? "链连通" : `${chain.breakpoints.length} 个断点` }}
              </span>
            </div>

            <div class="timeline">
              <article
                v-for="entry in chainEntries(chain.fuel)"
                :key="entry.id"
                class="record"
                :class="{ voided: entry.void, published: entry.seal, broken: !verificationOf(entry)?.ok }"
              >
                <div class="record-head">
                  <div>
                    <p class="record-title">#{{ entry.seq }} · ¥{{ Number(entry.price).toFixed(2) }}</p>
                    <p class="record-meta">{{ entry.operator }} · {{ entry.effectiveDate }} · {{ entry.createdAt.slice(0, 16).replace('T', ' ') }}</p>
                  </div>
                  <div class="badges">
                    <span class="status" :class="statusClass(entry)">{{ statusText(entry) }}</span>
                    <span class="status" :class="verificationOf(entry)?.ok ? 'success' : 'danger'">
                      {{ verificationLabels[verificationCode(entry)] }}
                    </span>
                  </div>
                </div>

                <div class="details">
                  <span>业务状态：{{ entry.businessStatus }}</span>
                  <span>来源：{{ entry.origin === 'migration' ? '迁移补链' : entry.origin === 'offline' ? '离线合并' : '在线调价' }}</span>
                  <span>备注：{{ entry.notes || "无" }}</span>
                  <span v-if="entry.revisionOf">修订自：#{{ entry.revisionSeq }} {{ shortDigest(entry.revisionDigest ?? '', 8) }}</span>
                </div>

                <div class="digest-box">
                  <div>
                    <span>上一版摘要</span>
                    <code>{{ shortDigest(entry.basisDigest, 12) }}</code>
                  </div>
                  <div class="digest-arrow">→</div>
                  <div>
                    <span>本版摘要</span>
                    <code>{{ shortDigest(entry.entryDigest, 12) }}</code>
                  </div>
                </div>

                <div v-if="entry.seal" class="stamp success-stamp">
                  发布冻结：{{ entry.seal.operator }} · {{ entry.seal.sealedAt.slice(0, 16).replace('T', ' ') }} ·
                  <code>{{ shortDigest(entry.seal.digest, 10) }}</code>
                </div>
                <div v-if="entry.void" class="stamp void-stamp">
                  {{ entry.void.reason }} · {{ entry.void.voidedAt.slice(0, 16).replace('T', ' ') }} ·
                  <code>{{ shortDigest(entry.void.digest, 10) }}</code>
                </div>

                <div v-if="!verificationOf(entry)?.ok" class="issues">
                  <strong>断点位置：#{{ entry.seq }}</strong>
                  <ul>
                    <li v-for="(issue, index) in verificationOf(entry)?.issues" :key="index">
                      {{ issue.message }}
                      <code v-if="issue.field">[{{ issue.field }}]</code>
                    </li>
                  </ul>
                </div>

                <div v-if="editTargetId === entry.id" class="inline-edit">
                  <label>
                    新备注
                    <textarea v-model="editForm.notes" />
                  </label>
                  <label>
                    新业务状态
                    <select v-model="editForm.businessStatus">
                      <option v-for="status in BUSINESS_STATUSES.filter((item) => item !== '已回退')" :key="status">{{ status }}</option>
                    </select>
                  </label>
                  <div class="actions">
                    <button type="button" @click="saveEdit">保存并重算后续</button>
                    <button type="button" class="secondary" @click="cancelEdit">取消</button>
                  </div>
                </div>

                <div v-else class="actions">
                  <button
                    type="button"
                    :disabled="state.readOnly || state.offline || Boolean(entry.void) || Boolean(entry.seal)"
                    @click="startEdit(entry)"
                  >
                    改备注/状态
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    :disabled="state.readOnly || state.offline || !isActiveLeaf(entry) || Boolean(entry.seal) || !verificationOf(entry)?.ok"
                    @click="store.publish(entry.id)"
                  >
                    发布冻结
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    :disabled="state.readOnly || state.offline || Boolean(entry.void) || Boolean(entry.seal)"
                    @click="store.rollback(entry.id)"
                  >
                    退回未发布价
                  </button>
                  <button type="button" class="danger ghost" :disabled="state.readOnly" @click="store.simulateManualEdit(entry.id)">
                    模拟手工改写
                  </button>
                </div>
              </article>
            </div>
          </div>
        </section>
      </section>

      <section class="orders panel">
        <div class="toolbar">
          <div>
            <h2>离线调价单回连队列</h2>
            <p class="toolbar-note">待核单据不会生成或覆盖价格；驳回和合并结果都带复核摘要。</p>
          </div>
        </div>
        <div v-if="filteredOrders.length === 0" class="empty">暂无离线调价单。切到离线模式后可演示。</div>
        <div v-else class="order-grid">
          <article v-for="order in filteredOrders" :key="order.id" class="order" :class="{ blocked: order.state === 'pending-review' }">
            <div class="record-head">
              <div>
                <p class="record-title">{{ order.fuel }} · ¥{{ Number(order.price).toFixed(2) }}</p>
                <p class="record-meta">{{ order.operator }} · 离线于 {{ order.offlineAt.slice(0, 16).replace('T', ' ') }}</p>
              </div>
              <span class="status" :class="order.state === 'merged' ? 'success' : order.state === 'rejected' ? 'muted' : 'danger'">
                {{ { pending: '待回连', merged: '已合并', 'pending-review': '待核', rejected: '已驳回' }[order.state] }}
              </span>
            </div>
            <div class="digest-box compact">
              <div>
                <span>基准链头</span><code>{{ shortDigest(order.basisDigest, 10) }}</code>
              </div>
              <div>
                <span>订单摘要</span><code>{{ shortDigest(order.orderDigest, 10) }}</code>
              </div>
              <div>
                <span>当前期望基准</span><code>{{ shortDigest(store.orderVerification.value.get(order.id)?.expectedBasisDigest ?? '', 10) }}</code>
              </div>
            </div>
            <ul v-if="!store.orderVerification.value.get(order.id)?.ok" class="order-issues">
              <li v-for="(issue, index) in store.orderVerification.value.get(order.id)?.issues" :key="index">{{ issue.message }}</li>
            </ul>
            <p v-if="order.review" class="review">
              复核：{{ order.review.operator }} · {{ order.review.reason }} · <code>{{ shortDigest(order.review.digest, 10) }}</code>
            </p>
            <div v-if="order.state === 'pending-review'" class="actions">
              <input v-model="rejectReason" placeholder="填写待核原因或驳回说明" />
              <button type="button" class="danger" @click="rejectOrder(order.id)">驳回且不覆盖</button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>
