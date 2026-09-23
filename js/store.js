/*
 * 数据层：作品数据与验稿单的存取（localStorage）。
 * 只负责承载数据，不包含任何验稿判定规则，也不操作页面。
 *
 * 验稿单结构：
 * { id, workId, client, visitTime, status, createdAt,
 *   signer, signedAt, reasons, voidedAt, voidReason, fromSheetId }
 * status: 待验 / 待修整 / 已确认 / 已作废
 * 约束：每件作品至多一张“未结束”（状态非已作废）的验稿单。
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "zfl42Works";

  function uid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function nowText() {
    return new Date().toLocaleString();
  }

  function todayISO(offsetDays) {
    return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
  }

  function sheet(workId, client, visitTime, extras) {
    var s = {
      id: uid(),
      workId: workId,
      client: client,
      visitTime: visitTime,
      status: "待验",
      createdAt: nowText(),
      signer: null,
      signedAt: null,
      reasons: [],
      voidedAt: null,
      voidReason: "",
      fromSheetId: null
    };
    if (extras) Object.keys(extras).forEach(function (k) { s[k] = extras[k]; });
    return s;
  }

  function seed() {
    var w1 = uid();
    var w2 = uid();
    var w3 = uid();
    var w4 = uid();
    var works = [
      {
        id: w1, base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 90,
        dryDate: todayISO(-2), gold: "已上金粉", defect: "",
        delivery: todayISO(3), status: "待交付", note: "客户看过照片后预约到店",
        logs: [nowText() + " 创建作品", nowText() + " 贴线进度更新至 90%"]
      },
      {
        id: w2, base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 100,
        dryDate: todayISO(-5), gold: "试扫粉", defect: "左侧枝干翘线",
        delivery: todayISO(1), status: "上金粉", note: "客户要求金粉偏暗",
        logs: [nowText() + " 创建作品", nowText() + " 缺陷：左侧枝干翘线"]
      },
      {
        id: w3, base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40,
        dryDate: todayISO(1), gold: "未处理", defect: "",
        delivery: todayISO(7), status: "贴线中", note: "",
        logs: [nowText() + " 创建作品"]
      },
      {
        id: w4, base: "木胎茶盘", theme: "缠枝牡丹", line: "细线", progress: 100,
        dryDate: todayISO(-6), gold: "已上金粉", defect: "",
        delivery: todayISO(2), status: "待交付", note: "第一轮签字后应客户要求换过纹样",
        logs: [
          nowText() + " 创建作品",
          "2026/9/12 16:20 验稿通过，客户 周敏 上门签收",
          "2026/9/15 10:02 作品资料变更：纹样：卷草纹 → 缠枝牡丹",
          "2026/9/15 10:02 原确认自动作废（签字人：周敏，签字时间：2026/9/12 16:20）：签字后变更纹样（卷草纹→缠枝牡丹）；旧签字保留在作品履历",
          "2026/9/20 16:40 验稿通过，客户 周敏 上门签收"
        ]
      }
    ];
    var inspections = [
      sheet(w1, "林秀娥", todayISO() + "T15:00", { createdAt: "2026/9/22 10:12" }),
      sheet(w2, "陈伯安", todayISO(-1) + "T10:30", {
        status: "待修整",
        createdAt: "2026/9/20 09:40",
        reasons: ["仍有断线/翘线：左侧枝干翘线"]
      }),
      sheet(w4, "周敏", "2026/9/12T16:20", {
        status: "已作废",
        createdAt: "2026/9/10 11:00",
        signer: "周敏",
        signedAt: "2026/9/12 16:20",
        voidedAt: "2026/9/15 10:02",
        voidReason: "签字后变更纹样（卷草纹→缠枝牡丹）"
      }),
      sheet(w4, "周敏", "2026/9/20T16:40", {
        status: "已确认",
        createdAt: "2026/9/15 10:02",
        signer: "周敏",
        signedAt: "2026/9/20 16:40",
        fromSheetId: null
      })
    ];
    // 第二轮验稿单指回作废的第一轮
    inspections[3].fromSheetId = inspections[2].id;
    return { version: 2, works: works, inspections: inspections };
  }

  function load() {
    var raw = null;
    try {
      raw = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "null");
    } catch (e) {
      raw = null;
    }
    // 兼容旧版：旧数据直接是作品数组
    if (Array.isArray(raw)) return { version: 2, works: raw, inspections: [] };
    if (raw && Array.isArray(raw.works)) {
      return {
        version: 2,
        works: raw.works,
        inspections: Array.isArray(raw.inspections) ? raw.inspections : []
      };
    }
    return seed();
  }

  var state = load();

  function persist() {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  var Store = {
    STORAGE_KEY: STORAGE_KEY,
    uid: uid,
    nowText: nowText,
    todayISO: todayISO,
    save: persist,

    works: function () { return state.works; },
    inspections: function () { return state.inspections; },

    getWork: function (id) {
      return state.works.find(function (w) { return w.id === id; }) || null;
    },
    getSheet: function (id) {
      return state.inspections.find(function (s) { return s.id === id; }) || null;
    },
    sheetsOf: function (workId) {
      return state.inspections.filter(function (s) { return s.workId === workId; });
    },
    // 每件作品唯一一张未结束（非已作废）的验稿单
    activeSheet: function (workId) {
      return state.inspections.find(function (s) {
        return s.workId === workId && s.status !== "已作废";
      }) || null;
    },

    addWork: function (w) {
      state.works.unshift(w);
      persist();
      return w;
    },
    patchWork: function (id, patch) {
      var w = this.getWork(id);
      if (!w) return null;
      Object.keys(patch).forEach(function (k) { w[k] = patch[k]; });
      persist();
      return w;
    },
    log: function (workId, text) {
      var w = this.getWork(workId);
      if (w) {
        w.logs = w.logs || [];
        w.logs.push(nowText() + " " + text);
      }
    },

    addSheet: function (s) {
      state.inspections.push(s);
      persist();
      return s;
    },
    patchSheet: function (id, patch) {
      var s = this.getSheet(id);
      if (!s) return null;
      Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
      persist();
      return s;
    },

    snapshot: function () {
      return {
        works: JSON.parse(JSON.stringify(state.works)),
        inspections: JSON.parse(JSON.stringify(state.inspections))
      };
    }
  };

  global.Store = Store;
})(typeof window !== "undefined" ? window : globalThis);
