/*
 * 验稿判定层：承载全部业务规则，不碰 DOM。
 * 页面层只调用这里的函数，判定结论集中在此处维护。
 *
 * 规则：
 * 1. 每件作品至多一张“未结束”（非已作废）的验稿单；开单登记客户姓名与到店时间。
 * 2. 签收条件：贴线进度满（100%）且无断线/翘线；否则停在「待修整」。
 * 3. 签字之后，若作品的胎体 / 纹样 / 线条发生变更，或补记了断线/翘线，
 *    原确认自动作废并重新排队生成新验稿单；旧签字保留在作品履历。
 */
(function (global) {
  "use strict";

  var Store = global.Store;

  var STATUS = {
    WAIT: "待验",
    REPAIR: "待修整",
    CONFIRMED: "已确认",
    VOID: "已作废"
  };
  var OPEN_STATUS = ["待验", "待修整", "已确认"];
  var CORE_FIELDS = { base: "胎体", theme: "纹样", line: "线条" };

  function hasDefect(work) {
    return !!(work.defect && work.defect.trim());
  }

  /*
   * 判定一件作品当前能否签收。
   * 返回 { ok, pass, reasons }，不要求当前必须有验稿单。
   */
  function evaluate(work) {
    var reasons = [];
    if (work.progress < 100) reasons.push("贴线进度未满（当前 " + work.progress + "%）");
    if (hasDefect(work)) reasons.push("仍有断线/翘线：" + work.defect.trim());
    return { ok: reasons.length === 0, pass: reasons.length === 0, reasons: reasons };
  }

  /*
   * 登记 / 修改验稿单。作品已有未结束的单时不能重复开单。
   */
  function register(workId, client, visitTime) {
    var work = Store.getWork(workId);
    if (!work) return { ok: false, message: "作品不存在" };
    client = (client || "").trim();
    if (!client) return { ok: false, message: "请登记客户姓名" };
    if (!visitTime) return { ok: false, message: "请登记到店时间" };
    if (Store.activeSheet(workId)) {
      return { ok: false, message: "该作品已有一张未结束的验稿单" };
    }
    var sheet = Store.addSheet({
      id: Store.uid(),
      workId: workId,
      client: client,
      visitTime: visitTime,
      status: STATUS.WAIT,
      createdAt: Store.nowText(),
      signer: null,
      signedAt: null,
      reasons: [],
      voidedAt: null,
      voidReason: "",
      fromSheetId: null
    });
    Store.log(workId, "登记验稿，客户 " + client + "，到店时间 " + formatTime(visitTime));
    // 新单也要立即按当前作品状态给一次判定
    var result = evaluate(work);
    if (!result.pass) {
      Store.patchSheet(sheet.id, { status: STATUS.REPAIR, reasons: result.reasons });
      Store.log(workId, "验稿判定：未通过，停在待修整（" + result.reasons.join("；") + "）");
    }
    Store && persistLogSafe();
    return { ok: true, sheet: Store.getSheet(sheet.id), evaluation: result };
  }

  // Store.log 内部不持久化，统一在动作末尾随数据写入
  function persistLogSafe() {
    Store.save();
  }

  function updateSheetInfo(workId, client, visitTime) {
    var sheet = Store.activeSheet(workId);
    if (!sheet) return { ok: false, message: "没有未结束的验稿单" };
    client = (client || "").trim();
    if (!client) return { ok: false, message: "客户姓名不能为空" };
    if (!visitTime) return { ok: false, message: "到店时间不能为空" };
    Store.patchSheet(sheet.id, { client: client, visitTime: visitTime });
    Store.log(workId, "更新验稿信息：客户 " + client + "，到店时间 " + formatTime(visitTime));
    persistLogSafe();
    return { ok: true, sheet: Store.getSheet(sheet.id) };
  }

  /*
   * 修整完成后复检：按当前作品进度与缺陷重新判定。
   * 待修整 -> 达标转为待验；不达标继续待修整并刷新原因。
   */
  function rejudge(workId) {
    var work = Store.getWork(workId);
    var sheet = Store.activeSheet(workId);
    if (!work) return { ok: false, message: "作品不存在" };
    if (!sheet) return { ok: false, message: "还没有登记验稿单" };
    if (sheet.status === STATUS.CONFIRMED) {
      return { ok: false, message: "该验稿单已签收，无需复检" };
    }
    var result = evaluate(work);
    if (result.pass) {
      Store.patchSheet(sheet.id, { status: STATUS.WAIT, reasons: [] });
      Store.log(workId, "修整后复检通过，回到待验");
    } else {
      Store.patchSheet(sheet.id, { status: STATUS.REPAIR, reasons: result.reasons });
      Store.log(workId, "修整后复检未通过：" + result.reasons.join("；"));
    }
    persistLogSafe();
    return { ok: result.pass, sheet: Store.getSheet(sheet.id), evaluation: result };
  }

  /*
   * 客户上门签收。进度满且无断线翘线才可签收，否则停在待修整。
   */
  function sign(workId, signer) {
    var work = Store.getWork(workId);
    var sheet = Store.activeSheet(workId);
    if (!work) return { ok: false, message: "作品不存在" };
    if (!sheet) return { ok: false, message: "还没有登记验稿单" };
    if (sheet.status === STATUS.CONFIRMED) {
      return { ok: false, message: "该验稿单已经签过字" };
    }
    var result = evaluate(work);
    if (!result.pass) {
      Store.patchSheet(sheet.id, { status: STATUS.REPAIR, reasons: result.reasons });
      Store.log(workId, "验稿判定：未通过，停在待修整（" + result.reasons.join("；") + "）");
      persistLogSafe();
      return {
        ok: false,
        sheet: Store.getSheet(sheet.id),
        evaluation: result,
        message: "暂不可签收：" + result.reasons.join("；")
      };
    }
    signer = (signer || "").trim() || sheet.client;
    var signedAt = Store.nowText();
    Store.patchSheet(sheet.id, {
      status: STATUS.CONFIRMED,
      reasons: [],
      signer: signer,
      signedAt: signedAt
    });
    Store.log(workId, "验稿通过，客户 " + signer + " 上门签收");
    persistLogSafe();
    return { ok: true, sheet: Store.getSheet(sheet.id), evaluation: result };
  }

  /*
   * 作废一张已确认的验稿单，并自动重新排队生成新验稿单。
   * 旧单（含旧签字人、签字时间）保留，旧签字写入作品履历。
   */
  function voidAndRequeue(workId, reasonText) {
    var work = Store.getWork(workId);
    var old = Store.activeSheet(workId);
    if (!work || !old) return { ok: false, message: "没有可作废的验稿单" };
    var voidedAt = Store.nowText();
    Store.patchSheet(old.id, {
      status: STATUS.VOID,
      voidedAt: voidedAt,
      voidReason: reasonText
    });
    Store.log(
      workId,
      "原确认自动作废（签字人：" + (old.signer || "—") +
      "，签字时间：" + (old.signedAt || "—") + "）：" + reasonText +
      "；旧签字保留在作品履历"
    );
    var fresh = Store.addSheet({
      id: Store.uid(),
      workId: workId,
      client: old.client,
      visitTime: "", // 重新排队，到店时间待重新登记
      status: STATUS.WAIT,
      createdAt: Store.nowText(),
      signer: null,
      signedAt: null,
      reasons: [],
      voidedAt: null,
      voidReason: "",
      fromSheetId: old.id
    });
    Store.log(workId, "自动重新排队（客户 " + old.client + "，请重新预约到店时间）");
    persistLogSafe();
    return { ok: true, oldSheet: Store.getSheet(old.id), sheet: fresh };
  }

  /*
   * 修改作品资料。胎体 / 纹样 / 线条任一在签字后变更：
   * 已确认的验稿单自动作废并重新排队；其他字段直接更新。
   */
  function updateWork(workId, patch) {
    var work = Store.getWork(workId);
    if (!work) return { ok: false, message: "作品不存在" };
    var sheet = Store.activeSheet(workId);

    var coreChanges = [];
    Object.keys(CORE_FIELDS).forEach(function (field) {
      if (patch[field] !== undefined && String(patch[field]) !== String(work[field])) {
        coreChanges.push({
          field: field,
          label: CORE_FIELDS[field],
          from: work[field],
          to: patch[field]
        });
      }
    });

    var voided = null;
    if (coreChanges.length && sheet && sheet.status === STATUS.CONFIRMED) {
      var desc = coreChanges.map(function (c) {
        return "签字后变更" + c.label + "（" + c.from + "→" + c.to + "）";
      }).join("；");
      Store.log(workId, "作品资料变更：" + coreChanges.map(function (c) {
        return c.label + "：" + c.from + " → " + c.to;
      }).join("；"));
      voided = voidAndRequeue(workId, desc);
    }

    Store.patchWork(workId, patch);
    // 资料变更（如进度补满、缺陷相关字段）后，未签字的单按现状重新判定
    var active = Store.activeSheet(workId);
    if (active && active.status !== STATUS.CONFIRMED) {
      var jr = evaluate(Store.getWork(workId));
      Store.patchSheet(active.id, jr.pass
        ? { status: STATUS.WAIT, reasons: [] }
        : { status: STATUS.REPAIR, reasons: jr.reasons });
      Store.log(workId, jr.pass
        ? "资料更新后重新判定：通过，回到待验"
        : "资料更新后重新判定：未通过（" + jr.reasons.join("；") + "）");
    }
    persistLogSafe();
    return {
      ok: true,
      work: Store.getWork(workId),
      coreChanged: coreChanges.length > 0,
      voided: voided
    };
  }

  /*
   * 补记断线 / 翘线。若当前已有确认签字，自动作废并重新排队；
   * 若验稿单处于待验/待修整，补记后立即重判，必落入待修整。
   */
  function recordDefect(workId, text) {
    var work = Store.getWork(workId);
    if (!work) return { ok: false, message: "作品不存在" };
    text = (text || "").trim();
    if (!text) return { ok: false, message: "请填写断线/翘线位置" };

    var sheet = Store.activeSheet(workId);
    var voided = null;
    var merged = work.defect ? work.defect + "; " + text : text;
    Store.log(workId, "补记缺陷：" + text);

    if (sheet && sheet.status === STATUS.CONFIRMED) {
      // 先把缺陷落到作品，再以“补记断线/翘线”为由作废重排
      Store.patchWork(workId, { defect: merged });
      voided = voidAndRequeue(workId, "签字后补记断线/翘线：" + text);
      persistLogSafe();
      return { ok: true, voided: voided, sheet: Store.getSheet(voided.sheet.id) };
    }

    Store.patchWork(workId, { defect: merged });
    var judge = null;
    if (sheet) {
      var result = evaluate(Store.getWork(workId));
      Store.patchSheet(sheet.id, { status: STATUS.REPAIR, reasons: result.reasons });
      Store.log(workId, "验稿判定：未通过，停在待修整（" + result.reasons.join("；") + "）");
      judge = result;
    }
    persistLogSafe();
    return {
      ok: true,
      work: Store.getWork(workId),
      sheet: sheet ? Store.activeSheet(workId) : null,
      evaluation: judge,
      voided: null
    };
  }

  /*
   * 修整完成、清除缺陷后触发复检。
   */
  function clearDefect(workId) {
    var work = Store.getWork(workId);
    if (!work) return { ok: false, message: "作品不存在" };
    if (!hasDefect(work)) return { ok: false, message: "当前没有缺陷记录" };
    Store.log(workId, "缺陷已修整：" + work.defect.trim());
    Store.patchWork(workId, { defect: "" });
    var result = rejudge(workId);
    return { ok: result.ok, sheet: result.sheet, evaluation: result.evaluation };
  }

  function formatTime(value) {
    if (!value) return "未登记";
    return String(value).replace("T", " ");
  }

  global.Inspection = {
    STATUS: STATUS,
    OPEN_STATUS: OPEN_STATUS,
    CORE_FIELDS: CORE_FIELDS,
    evaluate: evaluate,
    register: register,
    updateSheetInfo: updateSheetInfo,
    rejudge: rejudge,
    sign: sign,
    voidAndRequeue: voidAndRequeue,
    updateWork: updateWork,
    recordDefect: recordDefect,
    clearDefect: clearDefect,
    formatTime: formatTime
  };
})(typeof window !== "undefined" ? window : globalThis);
