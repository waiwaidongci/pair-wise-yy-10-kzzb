/*
 * 页面操作层：渲染、看板筛选、表单与弹窗交互。
 * 不在此处写验稿规则，签收 / 作废 / 重排等判定一律调用 Inspection。
 */
(function () {
  "use strict";

  var Store = window.Store;
  var Inspection = window.Inspection;
  var STATUS = Inspection.STATUS;

  var statuses = ["贴线中", "待阴干", "上金粉", "待交付"];
  var goldOptions = ["未处理", "试扫粉", "已上金粉"];
  var lineOptions = ["细线", "中线", "粗线", "混合线"];
  var today = new Date().toISOString().slice(0, 10);

  var currentView = "inspection"; // inspection | process
  var queueFilter = "全部";       // 全部 | 待验 | 待修整 | 已确认
  var activeId = null;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function shortId(id) { return String(id).slice(-8); }
  function fmtTime(v) { return v ? String(v).replace("T", " ") : "未登记"; }

  /* ---------------- 渲染：顶部摘要 ---------------- */

  function renderSummaries() {
    var works = Store.works();
    var activeSheets = works
      .map(function (w) { return { w: w, s: Store.activeSheet(w.id) }; })
      .filter(function (x) { return x.s; });

    var arrival = activeSheets
      .filter(function (x) { return x.s.visitTime && x.s.visitTime.slice(0, 10) === today; })
      .sort(function (a, b) {
        return String(a.s.visitTime).localeCompare(String(b.s.visitTime));
      });

    $("#todayArrival").innerHTML = arrival.length ? arrival.map(function (x) {
      return '<div class="item" data-work="' + x.w.id + '"><b>' + esc(x.w.theme) +
        '</b><div class="meta">' + esc(x.s.client) + " · " + fmtTime(x.s.visitTime) +
        ' · <span class="badge ' + badgeClass(x.s.status) + '">' + x.s.status + "</span></div></div>";
    }).join("") : '<div class="empty">今日暂无到店</div>';

    var defects = works.filter(function (w) { return w.defect; });
    $("#defectList").innerHTML = defects.length ? defects.map(function (w) {
      return '<div class="item overdue" data-work="' + w.id + '"><b>' + esc(w.theme) +
        '</b><div class="meta">' + esc(w.defect) + "</div></div>";
    }).join("") : '<div class="empty">暂无</div>';

    var delivery = works.slice().sort(function (a, b) {
      return a.delivery.localeCompare(b.delivery);
    }).slice(0, 4);
    $("#deliveryList").innerHTML = delivery.map(function (w) {
      var s = Store.activeSheet(w.id);
      return '<div class="item" data-work="' + w.id + '"><b>' + esc(w.theme) +
        '</b><div class="meta">' + esc(w.delivery) + " · " +
        (s ? '<span class="badge ' + badgeClass(s.status) + '">' + s.status + "</span>"
           : "未排验") + "</div></div>";
    }).join("");
  }

  function badgeClass(status) {
    if (status === STATUS.WAIT) return "b-wait";
    if (status === STATUS.REPAIR) return "b-repair";
    if (status === STATUS.CONFIRMED) return "b-ok";
    return "b-void";
  }

  /* ---------------- 渲染：验稿看板 ---------------- */

  function inspectionGroups() {
    var groups = { "待验": [], "待修整": [], "已确认": [], "未排验": [] };
    Store.works().forEach(function (w) {
      var s = Store.activeSheet(w.id);
      if (!s) groups["未排验"].push({ w: w, s: null });
      else if (groups[s.status]) groups[s.status].push({ w: w, s: s });
    });
    Object.keys(groups).forEach(function (k) {
      groups[k].sort(function (a, b) {
        var ta = a.s && a.s.visitTime ? a.s.visitTime : "9999";
        var tb = b.s && b.s.visitTime ? b.s.visitTime : "9999";
        return ta.localeCompare(tb);
      });
    });
    return groups;
  }

  function sheetCard(x) {
    var w = x.w, s = x.s;
    var actions = "";

    if (!s) {
      return '<article class="item q-unqueued" data-work="' + w.id + '">' +
        "<b>" + esc(w.theme) + '</b><div class="meta">' + esc(w.base) + " · " + esc(w.line) +
        "<br>进度 " + w.progress + "% · " + (w.defect ? "有断线/翘线" : "无缺陷") +
        "</div><div class=\"actions\" data-stop>" +
        '<button class="violet" data-act="open" data-work="' + w.id + '">登记验稿</button>' +
        "</div></article>";
    }

    if (s.status === STATUS.WAIT) {
      actions =
        '<button data-act="sign" data-work="' + w.id + '">客户签收</button>' +
        '<button class="warn" data-act="defect" data-work="' + w.id + '">补记断线</button>';
    } else if (s.status === STATUS.REPAIR) {
      actions =
        '<button data-act="rejudge" data-work="' + w.id + '">修整复检</button>' +
        '<button class="warn" data-act="defect" data-work="' + w.id + '">补记断线</button>';
    } else {
      actions =
        '<button class="secondary" data-act="open" data-work="' + w.id + '">查看履历</button>';
    }

    var body =
      "<b>" + esc(w.theme) + "</b>" +
      '<div class="meta">单号 …' + esc(shortId(s.id)) + " · " + esc(s.client) +
      "<br>到店 " + fmtTime(s.visitTime) +
      "<br>进度 " + w.progress + "% · " + (w.defect ? "缺陷：" + esc(w.defect) : "无断线/翘线") +
      (s.status === STATUS.REPAIR && s.reasons.length
        ? '<br><span class="reasons">判定：' + s.reasons.map(esc).join("；") + "</span>"
        : "") +
      (s.status === STATUS.CONFIRMED
        ? "<br>签字：" + esc(s.signer) + " · " + esc(s.signedAt)
        : "") +
      (s.status === STATUS.CONFIRMED
        ? '<br><span class="hint">改胎体/纹样/线条或补记断线将自动作废重排</span>'
        : "") +
      "</div>";

    return '<article class="item q-' + ({
      "待验": "wait", "待修整": "repair", "已确认": "ok"
    }[s.status]) + '" data-work="' + w.id + '">' +
      body +
      '<div class="actions" data-stop>' + actions + "</div></article>";
  }

  function renderInspectionBoard() {
    var groups = inspectionGroups();
    var single = queueFilter !== "全部";
    var cols = single ? [queueFilter] : ["待验", "待修整", "已确认", "未排验"];
    $("#kanbanInspection").classList.toggle("one-col", single);

    $("#kanbanInspection").innerHTML = cols.map(function (name) {
      var list = groups[name];
      return '<section class="col"><h3><span>' + name +
        '</span><span>' + list.length + "</span></h3>" +
        (list.length
          ? list.map(sheetCard).join("")
          : '<div class="empty">暂无作品</div>') +
        "</section>";
    }).join("");
  }

  /* ---------------- 渲染：工序看板（原有功能） ---------------- */

  function filteredWorks() {
    var themeFilter = $("#themeFilter").value.trim();
    var statusFilter = $("#statusFilter").value;
    var sortMode = $("#sortMode").value;
    return Store.works()
      .filter(function (w) { return !statusFilter || w.status === statusFilter; })
      .filter(function (w) { return !themeFilter || w.theme.includes(themeFilter); })
      .sort(function (a, b) {
        return String(a[sortMode] || "").localeCompare(String(b[sortMode] || ""));
      });
  }

  function renderProcessBoard() {
    $("#kanbanProcess").innerHTML = statuses.map(function (status) {
      var cards = filteredWorks().filter(function (w) { return w.status === status; });
      return '<section class="col"><h3><span>' + status +
        '</span><span>' + cards.length + "</span></h3>" +
        (cards.length ? cards.map(function (w) {
          var s = Store.activeSheet(w.id);
          return '<article class="item ' + (w.defect ? "overdue" : "") +
            '" data-work="' + w.id + '">' +
            "<b>" + esc(w.theme) + "</b>" +
            '<div class="meta">' + esc(w.base) + " · " + esc(w.line) +
            "<br>进度 " + w.progress + "% · 阴干 " + esc(w.dryDate) +
            "<br>金粉：" + esc(w.gold) + " · 交付：" + esc(w.delivery) +
            "<br>" + (w.defect ? "缺陷：" + esc(w.defect) : "缺陷：无") +
            "<br>验稿：" + (s
              ? '<span class="badge ' + badgeClass(s.status) + '">' + s.status + "</span>"
              : "未排验") +
            "</div>" +
            '<div class="actions" data-stop>' +
            statuses.map(function (t) {
              return '<button class="' + (t === status ? "secondary" : "") +
                '" data-act="status" data-status="' + t + '" data-work="' + w.id + '">' +
                t + "</button>";
            }).join("") +
            '<button class="warn" data-act="defect" data-work="' + w.id + '">记缺陷</button>' +
            "</div></article>";
        }).join("") : '<div class="empty">暂无作品</div>') +
        "</section>";
    }).join("");
  }

  function render() {
    renderSummaries();
    if (currentView === "inspection") renderInspectionBoard();
    else renderProcessBoard();
    if (activeId && $("#detailDialog").open) renderDialog();
  }

  /* ---------------- 作品详情 / 验稿操作弹窗 ---------------- */

  function optionTags(options, current) {
    return options.map(function (o) {
      return '<option value="' + esc(o) + '"' + (o === current ? " selected" : "") + ">" +
        esc(o) + "</option>";
    }).join("");
  }

  function workFieldsHTML(w) {
    return [
      '<div class="grid2">',
      '<label>胎体材质<input id="f_base" value="' + esc(w.base) + '"></label>',
      '<label>纹样主题<input id="f_theme" value="' + esc(w.theme) + '"></label>',
      "</div>",
      '<div class="grid2">',
      '<label>线条粗细<select id="f_line">' + optionTags(lineOptions, w.line) + "</select></label>",
      '<label>贴线进度<input id="f_line_progress" type="number" min="0" max="100" value="' + w.progress + '"></label>',
      "</div>",
      '<div class="grid2">',
      '<label>阴干日期<input id="f_dryDate" type="date" value="' + esc(w.dryDate) + '"></label>',
      '<label>交付日期<input id="f_delivery" type="date" value="' + esc(w.delivery) + '"></label>',
      "</div>",
      '<div class="grid2">',
      '<label>金粉处理状态<select id="f_gold">' + optionTags(goldOptions, w.gold) + "</select></label>",
      '<label>当前状态<select id="f_status">' + optionTags(statuses, w.status) + "</select></label>",
      "</div>",
      '<label>备注<textarea id="f_note">' + esc(w.note || "") + "</textarea></label>",
      '<div class="actions"><button data-act="save-work" data-work="' + w.id +
        '">保存资料</button></div>',
      '<div class="hint">已签收后修改胎体、纹样或线条，原确认会自动作废并重新排队。</div>'
    ].join("");
  }

  function defectBlockHTML(w) {
    return '<div class="subhead">断线 / 翘线</div>' +
      '<div class="meta">当前：' + (w.defect ? esc(w.defect) : "无") + "</div>" +
      '<input id="defectInput" placeholder="补记断线/翘线位置，如：右下花瓣断线">' +
      '<div class="actions">' +
      '<button class="warn" data-act="defect-dialog" data-work="' + w.id + '">补记缺陷</button>' +
      '<button class="secondary" data-act="clear-defect" data-work="' + w.id + '">已修整，复检</button>' +
      "</div>";
  }

  function historyHTML(w) {
    var all = Store.sheetsOf(w.id).slice().reverse();
    if (!all.length) return '<div class="empty">还没有验稿单</div>';
    return all.map(function (s) {
      return '<div class="history ' + badgeClass(s.status) + '">' +
        '单号 …' + esc(shortId(s.id)) +
        ' · <span class="badge ' + badgeClass(s.status) + '">' + s.status + "</span>" +
        '<div class="meta">客户：' + esc(s.client) + " · 到店：" + fmtTime(s.visitTime) +
        "<br>开单：" + esc(s.createdAt) +
        (s.signedAt ? "<br>签字：" + esc(s.signer) + " · " + esc(s.signedAt) : "") +
        (s.voidReason ? "<br>作废：" + esc(s.voidReason) + " · " + esc(s.voidedAt) : "") +
        "</div></div>";
    }).join("");
  }

  function sheetBlockHTML(w, s) {
    var evalResult = Inspection.evaluate(w);
    var head =
      '<div class="subhead">验稿单 <span class="meta">（单号 …' +
      esc(shortId(s.id)) + " · 开单 " + esc(s.createdAt) + "）</span></div>";

    var statusLine =
      '<div class="meta">当前状态：<span class="badge ' + badgeClass(s.status) + '">' +
      s.status + "</span>" +
      (s.status === STATUS.CONFIRMED
        ? "　签字：" + esc(s.signer) + " · " + esc(s.signedAt)
        : "") +
      "</div>";

    var judgeLine = s.status === STATUS.REPAIR && s.reasons.length
      ? '<div class="notice bad">未通过：' + s.reasons.map(esc).join("；") + "</div>"
      : (s.status !== STATUS.CONFIRMED
        ? '<div class="notice ' + (evalResult.pass ? "ok" : "bad") + '">实时判定：' +
          (evalResult.pass ? "进度满且无断线/翘线，可签收"
                           : evalResult.reasons.map(esc).join("；")) + "</div>"
        : "");

    var inputs =
      '<div class="grid2">' +
      '<label>客户姓名<input id="f_client" value="' + esc(s.client) + '"></label>' +
      '<label>到店时间<input id="f_visit" type="datetime-local" value="' + esc(s.visitTime) + '"></label>' +
      "</div>";

    var buttons = '<div class="actions">' +
      '<button class="secondary" data-act="save-info" data-work="' + w.id + '">保存信息</button>';
    if (s.status !== STATUS.CONFIRMED) {
      buttons +=
        '<button data-act="rejudge" data-work="' + w.id + '">修整复检</button>' +
        '<button data-act="sign" data-work="' + w.id + '">客户签收</button>';
    }
    buttons += "</div>";

    var voidHint = s.status === STATUS.CONFIRMED
      ? '<div class="hint">此后更换胎体 / 纹样 / 线条，或补记断线，原确认自动作废并重新排队，旧签字仍留在下方履历。</div>'
      : "";

    return head + statusLine + judgeLine + inputs + buttons + voidHint;
  }

  function noSheetBlockHTML(w) {
    var evalResult = Inspection.evaluate(w);
    return '<div class="subhead">验稿单</div>' +
      '<div class="notice ' + (evalResult.pass ? "ok" : "bad") + '">登记前判定：' +
      (evalResult.pass ? "进度满且无断线/翘线，登记后可直接签收"
                       : evalResult.reasons.map(esc).join("；")) + "</div>" +
      '<div class="grid2">' +
      '<label>客户姓名<input id="f_client" placeholder="先看照片、再上门签字的客户"></label>' +
      '<label>到店时间<input id="f_visit" type="datetime-local"></label>' +
      "</div>" +
      '<div class="actions">' +
      '<button class="violet" data-act="register" data-work="' + w.id + '">登记验稿</button>' +
      "</div>" +
      '<div class="hint">每件作品只能有一张未结束的验稿单。</div>';
  }

  function renderDialog() {
    var w = Store.getWork(activeId);
    if (!w) return;
    var s = Store.activeSheet(w.id);
    $("#detailTitle").textContent = w.theme + " · " + w.base;
    $("#detailBody").innerHTML =
      '<div class="dlg-section"><h4>作品资料</h4>' + workFieldsHTML(w) + "</div>" +
      '<div class="dlg-section"><h4>缺陷追踪</h4>' + defectBlockHTML(w) + "</div>" +
      '<div class="dlg-section"><h4>验稿</h4>' + (s ? sheetBlockHTML(w, s) : noSheetBlockHTML(w)) + "</div>" +
      '<div class="dlg-section"><h4>验稿履历（含已作废签字）</h4>' + historyHTML(w) + "</div>" +
      '<div class="dlg-section"><h4>作品履历</h4><div class="logs">' +
      (w.logs || []).map(esc).join("<br>") + "</div></div>";
  }

  function showDetail(id) {
    activeId = id;
    renderDialog();
    $("#detailDialog").showModal();
  }

  function refreshDialog() {
    if (activeId && Store.getWork(activeId)) renderDialog();
  }

  /* ---------------- 页面动作（只做取数/提示，判定交给 Inspection） ---------------- */

  function handleAct(act, el) {
    var workId = el.getAttribute("data-work");

    if (act === "open") { showDetail(workId); return; }

    if (act === "sign") {
      var r0 = Inspection.sign(workId, "");
      alert(r0.ok ? "已签收：" + r0.sheet.signer + " · " + r0.sheet.signedAt
                  : r0.message);
      if ($("#detailDialog").open) showDetail(workId);
      render();
      return;
    }

    if (act === "rejudge") {
      var r1 = Inspection.rejudge(workId);
      alert(r1.ok ? "复检通过，回到待验，可以约客户签收"
                  : ("仍未通过：" + (r1.evaluation ? r1.evaluation.reasons.join("；") : r1.message)));
      render();
      return;
    }

    if (act === "defect") {
      var text = prompt("补记断线 / 翘线位置");
      if (text === null) return;
      var r2 = Inspection.recordDefect(workId, text);
      if (!r2.ok) { alert(r2.message); return; }
      alert(r2.voided
        ? "已补记缺陷，原确认自动作废并重新排队，旧签字保留在作品履历"
        : "已补记，验稿停在待修整");
      render();
      return;
    }

    if (act === "status") {
      updateStatus(workId, el.getAttribute("data-status"));
      render();
      return;
    }

    if (!$("#detailDialog").open) {
      // 以下动作都在弹窗内取输入值
      if (act === "defect-dialog" || act === "register" || act === "save-info" ||
          act === "clear-defect" || act === "save-work") {
        showDetail(workId);
      }
      return;
    }

    if (act === "register") {
      var reg = Inspection.register(workId, $("#f_client").value, $("#f_visit").value);
      alert(reg.ok
        ? "验稿单已登记，状态：" + reg.sheet.status
        : reg.message);
      if (reg.ok) showDetail(workId);
      render();
    } else if (act === "save-info") {
      var upd = Inspection.updateSheetInfo(workId, $("#f_client").value, $("#f_visit").value);
      alert(upd.ok ? "验稿信息已更新" : upd.message);
      if (upd.ok) showDetail(workId);
      render();
    } else if (act === "defect-dialog") {
      var rd = Inspection.recordDefect(workId, $("#defectInput").value);
      if (!rd.ok) { alert(rd.message); return; }
      alert(rd.voided
        ? "已补记缺陷，原确认自动作废并重新排队，旧签字保留在作品履历"
        : "已补记，验稿停在待修整");
      showDetail(workId);
      render();
    } else if (act === "clear-defect") {
      var cd = Inspection.clearDefect(workId);
      if (!cd.ok) { alert(cd.message); return; }
      alert(cd.ok ? "缺陷已修整，复检通过，回到待验"
                  : "缺陷已登记修整，但复检未过：" + cd.evaluation.reasons.join("；"));
      showDetail(workId);
      render();
    } else if (act === "save-work") {
      var patch = {
        base: $("#f_base").value.trim(),
        theme: $("#f_theme").value.trim(),
        line: $("#f_line").value,
        progress: Number($("#f_line_progress").value),
        dryDate: $("#f_dryDate").value,
        delivery: $("#f_delivery").value,
        gold: $("#f_gold").value,
        status: $("#f_status").value,
        note: $("#f_note").value
      };
      if (!patch.base || !patch.theme) { alert("胎体与纹样不能为空"); return; }
      var uw = Inspection.updateWork(workId, patch);
      if (uw.voided) {
        alert("胎体 / 纹样 / 线条在签字后发生变更，原确认自动作废并重新排队，旧签字保留在作品履历");
      }
      showDetail(workId);
      render();
    }
  }

  // 统一事件委托：看板与弹窗里的按钮、卡片。
  // 按钮本身也带 data-work，命中动作后必须立即返回，避免再冒泡触发卡片打开。
  document.addEventListener("click", function (e) {
    var actionEl = e.target.closest("[data-act]");
    if (actionEl) {
      e.preventDefault();
      handleAct(actionEl.getAttribute("data-act"), actionEl);
      return;
    }
    var card = e.target.closest("[data-work]");
    if (card && !card.closest("[data-stop]")) {
      showDetail(card.getAttribute("data-work"));
    }
  });

  /* ---------------- 工序流转（页面操作，非验稿判定） ---------------- */

  function updateStatus(id, next) {
    var w = Store.getWork(id);
    if (!w) return;
    w.status = next;
    if (next === "待阴干") w.dryDate = today;
    if (next === "上金粉") w.gold = "已上金粉";
    if (next === "待交付") w.progress = 100;
    Store.log(id, "更新为 " + next);
    // 进度可能变化：未签字的验稿单顺带复检；已确认的不动（未改胎体/纹样/线条、未补断线）
    var s = Store.activeSheet(id);
    if (s && s.status !== STATUS.CONFIRMED) Inspection.rejudge(id);
    Store.save();
  }

  /* ---------------- 绑定 ---------------- */

  var form = $("#workForm");
  var fd = function (name) { return form.elements[name]; };
  fd("dryDate").value = today;
  fd("delivery").value = Store.todayISO(5);
  $("#statusFilter").innerHTML =
    '<option value="">全部状态</option>' + statuses.map(function (s) {
      return "<option>" + s + "</option>";
    }).join("");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var d = Object.fromEntries(new FormData(form).entries());
    Store.addWork({
      id: Store.uid(),
      base: d.base,
      theme: d.theme,
      line: d.line,
      progress: Number(d.progress),
      dryDate: d.dryDate,
      gold: d.gold,
      defect: d.defect || "",
      delivery: d.delivery,
      status: d.status,
      note: d.note || "",
      logs: [Store.nowText() + " 创建作品"]
    });
    form.reset();
    fd("dryDate").value = today;
    fd("delivery").value = Store.todayISO(5);
    render();
  });

  $$("[data-view]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      currentView = btn.getAttribute("data-view");
      $$("[data-view]").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      $("#kanbanInspection").hidden = currentView !== "inspection";
      $("#kanbanProcess").hidden = currentView !== "process";
      $("#processFilters").hidden = currentView !== "process";
      render();
    });
  });

  $$("[data-queue]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      queueFilter = btn.getAttribute("data-queue");
      $$("[data-queue]").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-queue") === queueFilter);
      });
      renderInspectionBoard();
    });
  });

  $("#clearFilters").addEventListener("click", function () {
    $("#themeFilter").value = "";
    $("#statusFilter").value = "";
    render();
  });
  ["#statusFilter", "#themeFilter", "#sortMode"].forEach(function (sel) {
    $(sel).addEventListener("input", function () {
      if (currentView === "process") renderProcessBoard();
    });
  });

  $("#closeDialog").addEventListener("click", function () {
    $("#detailDialog").close();
  });
  $("#detailDialog").addEventListener("close", function () {
    activeId = null;
  });

  $("#exportBtn").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(Store.snapshot(), null, 2)],
      { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lacquer-thread-inspections.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  render();
})();
