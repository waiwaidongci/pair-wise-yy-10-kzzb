/*
 * 作品数据层（store.js）
 * 只负责作品 / 缺陷 / 履历的持久化与增改，不含任何页面或 DOM 逻辑。
 * localStorage 结构：{ version, works: [...] }
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "zfl42Works";
  const WORK_DIMENSIONS = ["base", "theme", "line"]; // 签字后修改即触发作废的三个维度
  const DAY = 86400000;

  const uid = () => (global.crypto?.randomUUID ? crypto.randomUUID() : "w-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const dateStr = (d = new Date()) => d.toISOString().slice(0, 10);
  const nowStr = () => new Date().toLocaleString();
  const isoStamp = () => new Date().toISOString();

  // 从旧版自由文本缺陷中尽量辨别断线 / 翘线，辨识不了按断线处理（验稿更谨慎）
  function detectKind(text) {
    if (text.includes("翘")) return "lift";
    if (text.includes("断")) return "broken";
    return "broken";
  }

  function migrateDefect(text) {
    return String(text || "").split(/[;；]/).map(s => s.trim()).filter(Boolean).map(loc => ({
      id: uid(), kind: detectKind(loc), location: loc, fixed: false, at: nowStr()
    }));
  }

  function normalizeDefects(w) {
    if (Array.isArray(w.defects)) {
      w.defects.forEach(d => { if (!d.id) d.id = uid(); if (!d.kind) d.kind = detectKind(d.location); });
      return;
    }
    w.defects = w.defect ? migrateDefect(w.defect) : [];
  }

  function normalizeWork(w) {
    normalizeDefects(w);
    if (!Array.isArray(w.sheets)) w.sheets = [];
    w.sheets.forEach(s => {
      if (!s.id) s.id = uid();
      if (!s.openedAt) s.openedAt = isoStamp();
      if (!s.queueHistory) s.queueHistory = [];
      if (s.voided) {
        s.ended = true;
        s.endedReason = s.endedReason || "签字后作品被改动，确认作废";
      }
    });
    if (!Array.isArray(w.logs)) w.logs = [];
    delete w.defect;
    return w;
  }

  function seedData() {
    return [
      {
        id: uid(), base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 100,
        dryDate: dateStr(), gold: "已上金粉", delivery: dateStr(new Date(Date.now() + 2 * DAY)),
        status: "待交付", note: "边线需保持低浮雕感", defects: [], sheets: [], logs: [nowStr() + " 创建作品"]
      },
      {
        id: uid(), base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 100,
        dryDate: dateStr(new Date(Date.now() - 3 * DAY)), gold: "已上金粉", delivery: dateStr(new Date(Date.now() + 1 * DAY)),
        status: "待交付", note: "客户要求金粉偏暗", defects: [], sheets: [], logs: [nowStr() + " 创建作品"]
      },
      {
        id: uid(), base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 85,
        dryDate: dateStr(new Date(Date.now() + 1 * DAY)), gold: "未处理", delivery: dateStr(new Date(Date.now() + 6 * DAY)),
        status: "贴线中", note: "", defects: [], sheets: [], logs: [nowStr() + " 创建作品"]
      },
      {
        id: uid(), base: "脱胎花瓶", theme: "缠枝莲", line: "粗线", progress: 100,
        dryDate: dateStr(new Date(Date.now() - 2 * DAY)), gold: "已上金粉", delivery: dateStr(),
        status: "待交付", note: "", defects: [], sheets: [], logs: [nowStr() + " 创建作品"]
      }
    ];
  }

  class WorkStore {
    constructor() {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      this.works = (saved && Array.isArray(saved.works) ? saved.works : (Array.isArray(saved) ? saved : seedData()))
        .map(normalizeWork);
      this.persist();
    }

    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, works: this.works }));
    }

    get(id) { return this.works.find(w => w.id === id); }

    log(w, message) {
      w.logs.push(nowStr() + " " + message);
    }

    add(data) {
      const w = normalizeWork({
        id: uid(),
        base: data.base, theme: data.theme, line: data.line,
        progress: Number(data.progress) || 0,
        dryDate: data.dryDate, gold: data.gold,
        delivery: data.delivery, status: data.status,
        note: data.note || "", defects: [], sheets: [], logs: []
      });
      this.log(w, "创建作品");
      this.works.unshift(w);
      this.persist();
      return w;
    }

    updateStatus(id, status) {
      const w = this.get(id);
      w.status = status;
      if (status === "待阴干") w.dryDate = dateStr();
      if (status === "上金粉") w.gold = "已上金粉";
      if (status === "待交付") w.progress = 100;
      this.log(w, "更新为 " + status);
      this.persist();
      return w;
    }

    // 修改作品字段；dimensions 为本次实际变动的维度键（base/theme/line）
    // 返回 { work, voided }，作废判定交给验稿层回调处理
    applyEdits(id, fields, onDimensionChange) {
      const w = this.get(id);
      const changedDims = WORK_DIMENSIONS.filter(k => fields[k] !== undefined && fields[k] !== w[k]);
      Object.assign(w, fields);
      let voided = null;
      if (changedDims.length) {
        this.log(w, "修改" + changedDims.map(k => DIM_LABEL[k]).join("、"));
        if (onDimensionChange) voided = onDimensionChange(this, w, changedDims);
      }
      if (fields.note !== undefined) this.log(w, "更新备注");
      this.persist();
      return { work: w, changedDims, voided };
    }

    addDefect(id, kind, location) {
      const w = this.get(id);
      const defect = { id: uid(), kind, location: location.trim(), fixed: false, at: nowStr() };
      w.defects.push(defect);
      this.log(w, (kind === "broken" ? "记录断线：" : "记录翘线：") + defect.location);
      this.persist();
      return { work: w, defect };
    }

    resolveDefect(id, defectId) {
      const w = this.get(id);
      const d = w.defects.find(x => x.id === defectId);
      if (d && !d.fixed) {
        d.fixed = true;
        d.fixedAt = nowStr();
        this.log(w, "缺陷修整完成：" + d.location);
        this.persist();
      }
      return { work: w, defect: d };
    }

    openDefects(w) {
      return w.defects.filter(d => !d.fixed);
    }

    appendSheet(w, sheet) {
      w.sheets.push(sheet);
      this.persist();
    }

    logMessage(w, message) {
      this.log(w, message);
      this.persist();
    }
  }

  const DIM_LABEL = { base: "胎体", theme: "纹样", line: "线条" };

  global.WorkStore = WorkStore;
  global.WorkData = {
    STORAGE_KEY, WORK_DIMENSIONS, DIM_LABEL,
    uid, dateStr, nowStr, isoStamp
  };
})(window);
