/*
 * 验稿判定层（inspection.js）
 * 纯业务规则，不读写 DOM：验稿单状态机、签收判定、签字作废与重新排队。
 *
 * 验稿单状态（sheet.state）：
 *   pending 待验 —— 已开单登记，排队等客户到店
 *   repair  待修整 —— 签收判定未通过（进度未满 或 存在未处理断线/翘线）
 *   done    已确认 —— 客户已签字
 * 每张作品至多一张「未结束」验稿单（state ∈ pending/repair/done 且 ended !== true）。
 * 签字后改动胎体/纹样/线条，或补记断线：旧单结束并标记 voided（旧签字保留），
 * 同时新开一张 pending 单重新排队。
 */
(function (global) {
  "use strict";

  const { uid, nowStr, isoStamp, DIM_LABEL } = global.WorkData;

  const PENDING = "pending";
  const REPAIR = "repair";
  const REPAIR_STATES = new Set(["repair", "pending"]); // 修整完成后可重新排队的单态
  const DONE = "done";

  const STATE_LABEL = { pending: "待验", repair: "待修整", done: "已确认" };
  const KIND_LABEL = { broken: "断线", lift: "翘线" };

  function activeSheet(w) {
    return w.sheets.find(s => !s.ended) || null;
  }

  // 看板状态：没有未结束验稿单的作品归 null（不进验稿看板）
  function inspectState(w) {
    const s = activeSheet(w);
    return s ? s.state : null;
  }

  // 签收硬条件：进度满（100%）且无未处理断线、翘线
  function blockingReasons(w) {
    const reasons = [];
    if (Number(w.progress) < 100) reasons.push("贴线进度未满（当前 " + w.progress + "%）");
    const open = w.defects.filter(d => !d.fixed);
    const broken = open.filter(d => d.kind === "broken").map(d => d.location);
    const lift = open.filter(d => d.kind === "lift").map(d => d.location);
    if (broken.length) reasons.push("存在断线：" + broken.join("、"));
    if (lift.length) reasons.push("存在翘线：" + lift.join("、"));
    return reasons;
  }

  function canSign(w) {
    return blockingReasons(w).length === 0;
  }

  function newSheet(params = {}) {
    return {
      id: uid(),
      state: PENDING,
      customer: params.customer || "",
      visitAt: params.visitAt || "",
      queueNo: params.queueNo || 0,
      queueHistory: [{ queuedAt: isoStamp(), note: params.queueNote || "开单排队" }],
      openedAt: isoStamp(),
      signedAt: null,
      signName: null,
      ended: false,
      endedReason: "",
      voided: false,
      voidedAt: null,
      voidReason: null,
      baseAtOpen: params.base || "",
      themeAtOpen: params.theme || "",
      lineAtOpen: params.line || ""
    };
  }

  // 开单：每件作品只允许一张未结束验稿单；登记客户姓名与到店时间
  function openSheet(store, w, input) {
    const existing = activeSheet(w);
    if (existing) return { ok: false, reason: "该作品已有一张未结束的验稿单", sheet: existing };
    const customer = (input.customer || "").trim();
    const visitAt = (input.visitAt || "").trim();
    if (!customer) return { ok: false, reason: "请登记客户姓名" };
    if (!visitAt) return { ok: false, reason: "请登记到店时间" };

    const queueNo = store.works.reduce((m, x) => {
      const s = activeSheet(x);
      return s ? Math.max(m, s.queueNo || 0) : m;
    }, 0) + 1;

    const sheet = newSheet({
      customer, visitAt, queueNo,
      base: w.base, theme: w.theme, line: w.line
    });
    store.appendSheet(w, sheet);
    store.logMessage(w, "开验稿单：客户 " + customer + "，到店时间 " + visitAt.replace("T", " ") + "，排队 #" + queueNo);
    return { ok: true, sheet };
  }

  // 待验单可补登记 / 修改客户姓名与到店时间
  function register(store, w, input) {
    const s = activeSheet(w);
    if (!s || s.state !== PENDING) return { ok: false, reason: "只有待验验稿单可以登记到店信息" };
    const customer = (input.customer || "").trim();
    const visitAt = (input.visitAt || "").trim();
    if (!customer) return { ok: false, reason: "请登记客户姓名" };
    if (!visitAt) return { ok: false, reason: "请登记到店时间" };
    s.customer = customer;
    s.visitAt = visitAt;
    store.logMessage(w, "登记验稿到店：客户 " + customer + "，到店时间 " + visitAt.replace("T", " "));
    return { ok: true, sheet: s };
  }

  // 签收：条件不满足则停在「待修整」
  function sign(store, w) {
    const s = activeSheet(w);
    if (!s) return { ok: false, reason: "尚未开验稿单" };
    if (s.state === DONE) return { ok: false, reason: "本张验稿单已签字确认" };
    if (s.state !== PENDING) return { ok: false, reason: "验稿单处于待修整，修整完成后需重新排队" };
    if (!s.customer || !s.visitAt) return { ok: false, reason: "请先登记客户姓名与到店时间" };

    const reasons = blockingReasons(w);
    if (reasons.length) {
      s.state = REPAIR;
      s.stoppedReasons = reasons;
      store.logMessage(w, "验稿未通过，停在待修整：" + reasons.join("；"));
      return { ok: false, state: REPAIR, reasons, sheet: s };
    }
    s.state = DONE;
    s.signedAt = isoStamp();
    s.signName = s.customer;
    s.signedSnapshot = { base: w.base, theme: w.theme, line: w.line };
    s.stoppedReasons = [];
    store.logMessage(w, "客户 " + s.customer + " 签字确认（验稿单 #" + s.queueNo + "）");
    return { ok: true, state: DONE, sheet: s };
  }

  // 待修整单：修整完成后重新排队回到待验
  function requeue(store, w, note) {
    const s = activeSheet(w);
    if (!s || !REPAIR_STATES.has(s.state)) return { ok: false, reason: "当前验稿单无需重新排队" };
    s.state = PENDING;
    s.queueHistory.push({ queuedAt: isoStamp(), note: note || "修整完成，重新排队" });
    s.stoppedReasons = [];
    store.logMessage(w, "验稿单重新排队（" + (note || "修整完成") + "）");
    return { ok: true, sheet: s };
  }

  // 旧确认作废并新开一张单重新排队；旧单（含旧签字）保留在作品履历
  function voidAndReopen(store, w, reasonText) {
    const old = activeSheet(w);
    if (!old) return null;
    const carriedName = old.customer;
    old.ended = true;
    old.endedAt = isoStamp();
    old.endedReason = reasonText;
    old.voided = true;
    old.voidedAt = old.endedAt;
    old.voidReason = reasonText;

    const queueNo = store.works.reduce((m, x) => {
      const s = activeSheet(x);
      return s ? Math.max(m, s.queueNo || 0) : m;
    }, 0) + 1;
    const fresh = newSheet({
      customer: carriedName, // 沿用客户姓名，到店时间需重新登记
      queueNo,
      queueNote: "前序确认作废后重新排队",
      base: w.base, theme: w.theme, line: w.line
    });
    store.appendSheet(w, fresh);
    store.logMessage(w, "原确认作废（" + reasonText + "），旧签字 " +
      (old.signName || "—") + " 留存履历，重新排队 #" + queueNo);
    return { oldSheet: old, newSheet: fresh };
  }

  // 触发源 1：签字后改动胎体 / 纹样 / 线条（由作品数据层在字段变动后回调）
  function onWorkDimensionsChanged(store, w, dims) {
    const s = activeSheet(w);
    if (!s || s.state !== DONE) return null;
    const text = "签字后修改" + dims.map(k => DIM_LABEL[k]).join("、");
    return voidAndReopen(store, w, text);
  }

  // 触发源 2：签字后补记断线（翘线不在作废规则内，仅影响下一次签收判定）
  function onDefectAdded(store, w, defect) {
    const s = activeSheet(w);
    if (s && s.state === DONE && defect.kind === "broken") {
      return voidAndReopen(store, w, "签字后补记断线：" + defect.location);
    }
    return null;
  }

  function formatVisit(value) {
    return value ? String(value).replace("T", " ") : "";
  }

  function formatStamp(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  }

  global.Inspection = {
    PENDING, REPAIR, DONE,
    STATE_LABEL, KIND_LABEL,
    activeSheet, inspectState,
    blockingReasons, canSign,
    openSheet, register, sign, requeue,
    voidAndReopen, onWorkDimensionsChanged, onDefectAdded,
    formatVisit, formatStamp
  };
})(window);
