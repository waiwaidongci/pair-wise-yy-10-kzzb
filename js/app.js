/*
 * 页面操作层（app.js）
 * 只负责渲染与交互：作品数据来自 WorkStore，验稿规则全部走 Inspection，
 * 本文件不内嵌任何签收 / 作废判定。
 */
(function () {
  "use strict";

  const store = new WorkStore();
  const I = Inspection;
  const statuses = ["贴线中", "待阴干", "上金粉", "待交付"];
  const today = new Date().toISOString().slice(0, 10);

  let activeId = null;
  let detailEditing = false;

  const form = document.querySelector("#workForm");
  const board = document.querySelector("#board");
  const statusFilter = document.querySelector("#statusFilter");
  const themeFilter = document.querySelector("#themeFilter");
  const sortMode = document.querySelector("#sortMode");
  const inspectFilter = document.querySelector("#inspectFilter");
  const inspectBoard = document.querySelector("#inspectionBoard");
  const dialog = document.querySelector("#detailDialog");
  const toastEl = document.querySelector("#toast");

  form.dryDate.value = today;
  form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  statusFilter.innerHTML = `<option value="">全部状态</option>` + statuses.map(s => `<option>${s}</option>`).join("");

  /* ---------- 工具 ---------- */

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let toastTimer;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = "show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ""; }, 3200);
  }

  function nowLocalInput() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  function openDefects(w) {
    return w.defects.filter(d => !d.fixed);
  }

  function defectSummary(w) {
    const open = openDefects(w);
    if (!open.length) return "";
    return open.map(d => I.KIND_LABEL[d.kind] + "·" + d.location).join("；");
  }

  function filteredWorks() {
    return store.works
      .filter(w => !statusFilter.value || w.status === statusFilter.value)
      .filter(w => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
      .sort((a, b) => (a[sortMode.value] || "").localeCompare(b[sortMode.value] || ""));
  }

  /* ---------- 今日与风险 ---------- */

  function renderSummaries() {
    const todayDry = store.works.filter(w => w.dryDate <= today && w.status === "待阴干");
    const defects = store.works.filter(w => openDefects(w).length);
    const delivery = [...store.works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);

    document.querySelector("#todayDry").innerHTML = todayDry.length
      ? todayDry.map(w => `<div class="item" data-act="openDetail" data-id="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(w.base)} · ${esc(w.dryDate)}</div></div>`).join("")
      : `<div class="empty">暂无</div>`;
    document.querySelector("#defectList").innerHTML = defects.length
      ? defects.map(w => `<div class="item overdue" data-act="openDetail" data-id="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(defectSummary(w))}</div></div>`).join("")
      : `<div class="empty">暂无</div>`;
    document.querySelector("#deliveryList").innerHTML = delivery
      .map(w => `<div class="item" data-act="openDetail" data-id="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(w.delivery)} · ${esc(w.status)}</div></div>`).join("");
  }

  /* ---------- 工序看板 ---------- */

  function renderBoard() {
    const list = filteredWorks();
    board.innerHTML = statuses.map(status => {
      const cards = list.filter(w => w.status === status);
      return `<section class="col">
        <h3><span>${status}</span><span>${cards.length}</span></h3>
        ${cards.length ? cards.map(w => `<article class="item ${openDefects(w).length ? "overdue" : ""}" data-act="openDetail" data-id="${w.id}">
          <b>${esc(w.theme)}</b>
          <div class="meta">${esc(w.base)} · ${esc(w.line)}<br>进度 ${w.progress}% · 阴干 ${esc(w.dryDate)}<br>金粉：${esc(w.gold)} · 交付：${esc(w.delivery)}<br>缺陷：${esc(defectSummary(w)) || "无"}</div>
          <div class="actions" data-stop>
            ${statuses.map(s => `<button class="${s === status ? "secondary" : ""}" onclick="updateStatus('${w.id}', '${s}')">${s}</button>`).join("")}
            <button class="warn" onclick="recordDefect('${w.id}')">记缺陷</button>
          </div>
        </article>`).join("") : `<div class="empty">暂无作品</div>`}
      </section>`;
    }).join("");
  }

  /* ---------- 客户验稿看板：待验 / 待修整 / 已确认 ---------- */

  function inspectionGroups() {
    const kw = inspectFilter.value.trim();
    const match = w => !kw || [w.theme, w.base, w.line, I.activeSheet(w)?.customer]
      .some(v => String(v || "").includes(kw));
    const groups = { pending: [], repair: [], done: [] };
    store.works.forEach(w => {
      const st = I.inspectState(w);
      if (st && match(w)) groups[st].push(w);
    });
    const byQueue = (a, b) => (I.activeSheet(a).queueNo || 0) - (I.activeSheet(b).queueNo || 0);
    groups.pending.sort(byQueue);
    groups.repair.sort(byQueue);
    groups.done.sort((a, b) => (I.activeSheet(b).signedAt || "").localeCompare(I.activeSheet(a).signedAt || ""));
    return groups;
  }

  function precheckLine(w) {
    const reasons = I.blockingReasons(w);
    return reasons.length
      ? `<div class="meta" style="color:var(--amber)">签收预检：${esc(reasons.join("；"))}</div>`
      : `<div class="meta" style="color:var(--green)">签收预检：进度满且无断线翘线，可签收</div>`;
  }

  function renderInspectionBoard() {
    const groups = inspectionGroups();
    const columns = [
      { key: "pending", cls: "b-pending", itemCls: "s-pending" },
      { key: "repair", cls: "b-repair", itemCls: "s-repair" },
      { key: "done", cls: "b-done", itemCls: "s-done" }
    ];
    inspectBoard.innerHTML = columns.map(col => {
      const cards = groups[col.key];
      return `<section class="col">
        <h3><span class="badge ${col.cls}">${I.STATE_LABEL[col.key]}</span><span>${cards.length}</span></h3>
        ${cards.length ? cards.map(w => inspectionCard(w, col.key, col.itemCls)).join("") : `<div class="empty">暂无作品</div>`}
      </section>`;
    }).join("");
  }

  function inspectionCard(w, state, itemCls) {
    const s = I.activeSheet(w);
    let body = "";
    let actions = "";
    if (state === "pending") {
      body = `<div class="meta">${esc(w.base)} · ${esc(w.line)}<br>客户：${esc(s.customer || "未登记")}<br>到店：${esc(I.formatVisit(s.visitAt)) || "未登记"} · 交付 ${esc(w.delivery)}</div>${precheckLine(w)}`;
      actions = `<button class="green btn-sm" data-act="quickSign" data-id="${w.id}">客户签收</button>
                 <button class="secondary btn-sm" data-act="openDetail" data-id="${w.id}">详情</button>`;
    } else if (state === "repair") {
      const reasons = (s.stoppedReasons || I.blockingReasons(w));
      body = `<div class="meta">${esc(w.base)} · 客户：${esc(s.customer || "—")}</div>
        <ul class="reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>`;
      actions = `<button class="warn btn-sm" data-act="quickRequeue" data-id="${w.id}">修整后重新排队</button>
                 <button class="secondary btn-sm" data-act="openDetail" data-id="${w.id}">详情</button>`;
    } else {
      body = `<div class="meta">${esc(w.base)} · ${esc(w.line)}<br>签字人：${esc(s.signName || s.customer)}<br>签字时间：${esc(I.formatStamp(s.signedAt))}</div>`;
      actions = `<button class="secondary btn-sm" data-act="openDetail" data-id="${w.id}">履历</button>`;
    }
    return `<article class="item ${itemCls}">
      <div class="dhead"><b>${esc(w.theme)}</b><span class="queue-no">#${s.queueNo}</span></div>
      ${body}
      <div class="actions">${actions}</div>
    </article>`;
  }

  /* ---------- 作品详情弹窗 ---------- */

  function showDetail(id) {
    activeId = id;
    detailEditing = false;
    renderDetail();
    dialog.showModal();
  }

  function renderDetail() {
    const w = store.get(activeId);
    if (!w) { dialog.close(); return; }
    document.querySelector("#detailTitle").textContent = `${w.theme} · ${w.base}`;
    document.querySelector("#detailWork").innerHTML = detailWork(w);
    document.querySelector("#detailDefects").innerHTML = detailDefects(w);
    document.querySelector("#detailInspection").innerHTML = detailInspection(w);
    document.querySelector("#detailHistory").innerHTML = detailHistory(w);
  }

  function detailWork(w) {
    const rows = [
      ["胎体材质", w.base], ["纹样主题", w.theme], ["线条粗细", w.line],
      ["贴线进度", w.progress + "%"], ["阴干日期", w.dryDate], ["金粉状态", w.gold],
      ["交付日期", w.delivery], ["当前状态", w.status], ["备注", w.note || "无"]
    ].map(([k, v]) => `${k}：${esc(v)}`).join("<br>");

    if (!detailEditing) {
      return `<section class="dsec">
        <div class="dhead"><h3>作品信息</h3><button class="secondary btn-sm" data-act="editToggle">修改作品</button></div>
        <div class="meta">${rows}</div>
      </section>`;
    }

    const golds = ["未处理", "试扫粉", "已上金粉"];
    return `<section class="dsec">
      <div class="dhead"><h3>修改作品</h3><span class="hint">改胎体 / 纹样 / 线条且已签字时，确认自动作废</span></div>
      <div class="grid2">
        <label>胎体材质<input id="edBase" value="${esc(w.base)}"></label>
        <label>纹样主题<input id="edTheme" value="${esc(w.theme)}"></label>
      </div>
      <div class="grid2">
        <label>线条粗细<select id="edLine">${["细线", "中线", "粗线", "混合线"].map(x => `<option ${x === w.line ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>贴线进度<input id="edProgress" type="number" min="0" max="100" value="${w.progress}"></label>
      </div>
      <div class="grid2">
        <label>阴干日期<input id="edDry" type="date" value="${esc(w.dryDate)}"></label>
        <label>交付日期<input id="edDelivery" type="date" value="${esc(w.delivery)}"></label>
      </div>
      <div class="grid2">
        <label>金粉状态<select id="edGold">${golds.map(x => `<option ${x === w.gold ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>当前状态<select id="edStatus">${statuses.map(x => `<option ${x === w.status ? "selected" : ""}>${x}</option>`).join("")}</select></label>
      </div>
      <label>备注<textarea id="edNote">${esc(w.note)}</textarea></label>
      <div class="actions">
        <button class="green btn-sm" data-act="saveEdit">保存修改</button>
        <button class="secondary btn-sm" data-act="cancelEdit">取消</button>
      </div>
    </section>`;
  }

  function detailDefects(w) {
    const list = w.defects.length
      ? w.defects.slice().reverse().map(d => `<div class="chip-row">
          <span class="chip c-${d.kind} ${d.fixed ? "done" : ""}">${I.KIND_LABEL[d.kind]}${d.fixed ? "（已修整）" : ""}</span>
          <span>${esc(d.location)}</span>
          <span class="meta">${esc(d.at)}</span>
          ${d.fixed ? "" : `<button class="secondary btn-sm" data-act="fixDefect" data-did="${d.id}">修整完成</button>`}
        </div>`).join("")
      : `<div class="empty">暂无缺陷记录</div>`;
    return `<section class="dsec">
      <div class="dhead"><h3>缺陷记录（断线 / 翘线）</h3></div>
      ${list}
      <div class="inline">
        <select id="newDefectKind" style="width:96px;flex:none;"><option value="broken">断线</option><option value="lift">翘线</option></select>
        <input id="newDefectLoc" placeholder="缺陷位置，如：右下花瓣">
        <button class="warn btn-sm" data-act="addDefect" style="flex:none;">记录</button>
      </div>
      <div class="hint">已确认的作品补记断线，原确认自动作废并重新排队；翘线将影响下次签收。</div>
    </section>`;
  }

  function detailInspection(w) {
    const s = I.activeSheet(w);
    if (!s) {
      return `<section class="dsec">
        <div class="dhead"><h3>验稿单</h3></div>
        <div class="hint">当前没有未结束验稿单。客户看过照片、确定到店后开单，登记客户姓名与到店时间即进入待验队列。</div>
        <div class="grid2">
          <label>客户姓名<input id="newCustomer" placeholder="例如：林女士"></label>
          <label>到店时间<input id="newVisit" type="datetime-local" value="${nowLocalInput()}"></label>
        </div>
        <button data-act="openSheet">开单排队（待验）</button>
      </section>`;
    }

    const head = `<div class="dhead"><h3>验稿单 · 排队 #${s.queueNo}</h3><span class="badge b-${s.state}">${I.STATE_LABEL[s.state]}</span></div>`;

    if (s.state === I.PENDING) {
      return `<section class="dsec">
        ${head}
        <div class="grid2">
          <label>客户姓名<input id="regCustomer" value="${esc(s.customer)}"></label>
          <label>到店时间<input id="regVisit" type="datetime-local" value="${esc((s.visitAt || "").replace(" ", "T"))}"></label>
        </div>
        ${precheckLine(w)}
        <div class="actions">
          <button class="secondary btn-sm" data-act="register">登记 / 更新到店信息</button>
          <button class="green btn-sm" data-act="sign">客户签收</button>
        </div>
      </section>`;
    }

    if (s.state === I.REPAIR) {
      const reasons = (s.stoppedReasons || I.blockingReasons(w));
      return `<section class="dsec">
        ${head}
        <div class="meta">客户：${esc(s.customer)} · 到店：${esc(I.formatVisit(s.visitAt))}</div>
        <div><b style="font-size:13px;">未通过原因</b><ul class="reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>
        <div class="hint">在上方缺陷区登记「修整完成」、确认贴线进度 100% 后，重新排队回到待验。</div>
        <div class="actions">
          <button class="warn btn-sm" data-act="requeue">修整完成，重新排队</button>
        </div>
      </section>`;
    }

    // done
    return `<section class="dsec">
      ${head}
      <div class="meta">
        签字人：${esc(s.signName || s.customer)}<br>
        到店时间：${esc(I.formatVisit(s.visitAt))}<br>
        签字时间：${esc(I.formatStamp(s.signedAt))}<br>
        签字版本：${esc(w.base)} · ${esc(w.theme)} · ${esc(w.line)}
      </div>
      <div class="hint">此后若更换胎体、纹样或线条，或补记断线，本确认自动作废并重新排队；旧签字保留在作品履历。</div>
    </section>`;
  }

  function detailHistory(w) {
    const ended = w.sheets.filter(s => s.ended).slice().reverse()
      .map(s => `<li><span class="badge b-void">已作废 #${s.queueNo}</span>
        客户 ${esc(s.customer || "—")}，签字人 ${esc(s.signName || "—")}，签字时间 ${esc(I.formatStamp(s.signedAt))}<br>
        <span class="meta">作废原因：${esc(s.endedReason)}（${esc(I.formatStamp(s.voidedAt || s.endedAt))}）；旧签字留存</span></li>`)
      .join("");
    const logs = w.logs.slice().reverse().map(l => `<li>${esc(l)}</li>`).join("");
    return (ended ? `<li class="meta" style="list-style:none;margin:4px 0 2px;">历史验稿单</li>${ended}` : "") +
      `<li class="meta" style="list-style:none;margin:6px 0 2px;">流转记录</li>${logs}`;
  }

  /* ---------- 操作动作 ---------- */

  function doQuickSign(id) {
    const w = store.get(id);
    const r = I.sign(store, w);
    if (r.ok) toast(`已签收：${w.theme}（${r.sheet.signName}，#${r.sheet.queueNo}）`);
    else if (r.state === I.REPAIR) toast("未达到签收条件，停在待修整：\n" + r.reasons.join("\n"), "warn");
    else toast(r.reason, "bad");
    renderAll();
  }

  function doQuickRequeue(id) {
    const w = store.get(id);
    const r = I.requeue(store, w);
    if (r.ok) toast(`已重新排队：${w.theme}（#${r.sheet.queueNo}）`);
    else toast(r.reason, "bad");
    renderAll();
  }

  // 统一承接看板与详情弹窗里的 data-act 按钮
  document.addEventListener("click", event => {
    const btn = event.target.closest("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id || activeId;
    const w = id && store.get(id);
    const act = btn.dataset.act;

    if (act === "openDetail") { if (w) showDetail(w.id); return; }
    if (act === "quickSign") { doQuickSign(id); return; }
    if (act === "quickRequeue") { doQuickRequeue(id); return; }
    if (!w || id !== activeId) return;

    if (act === "openSheet") {
      const r = I.openSheet(store, w, {
        customer: document.querySelector("#newCustomer").value,
        visitAt: document.querySelector("#newVisit").value
      });
      if (!r.ok) { toast(r.reason, "bad"); return; }
      toast(`已开单排队 #${r.sheet.queueNo}：${r.sheet.customer} ${I.formatVisit(r.sheet.visitAt)}`);
      renderAll();
    } else if (act === "register") {
      const r = I.register(store, w, {
        customer: document.querySelector("#regCustomer").value,
        visitAt: document.querySelector("#regVisit").value
      });
      if (!r.ok) { toast(r.reason, "bad"); return; }
      toast("到店信息已登记");
      renderAll();
    } else if (act === "sign") {
      doQuickSign(w.id);
      if (dialog.open) renderDetail();
    } else if (act === "requeue") {
      const r = I.requeue(store, w);
      if (!r.ok) { toast(r.reason, "bad"); return; }
      toast(`修整完成，已重新排队 #${r.sheet.queueNo}`);
      renderAll();
    } else if (act === "addDefect") {
      const loc = document.querySelector("#newDefectLoc");
      const kind = document.querySelector("#newDefectKind").value;
      if (!loc.value.trim()) { toast("请填写缺陷位置", "bad"); loc.focus(); return; }
      const { defect } = store.addDefect(w.id, kind, loc.value);
      const voided = I.onDefectAdded(store, w, defect);
      if (voided) {
        toast(`已记录${I.KIND_LABEL[kind]}；客户已签字，原确认自动作废，重新排队 #${voided.newSheet.queueNo}`, "warn");
      } else {
        toast(`已记录${I.KIND_LABEL[kind]}：${defect.location}`);
      }
      renderAll();
    } else if (act === "fixDefect") {
      store.resolveDefect(w.id, btn.dataset.did);
      toast("已登记修整完成");
      renderAll();
    } else if (act === "editToggle") {
      detailEditing = true;
      renderDetail();
    } else if (act === "cancelEdit") {
      detailEditing = false;
      renderDetail();
    } else if (act === "saveEdit") {
      const fields = {
        base: document.querySelector("#edBase").value.trim(),
        theme: document.querySelector("#edTheme").value.trim(),
        line: document.querySelector("#edLine").value,
        progress: Number(document.querySelector("#edProgress").value),
        dryDate: document.querySelector("#edDry").value,
        gold: document.querySelector("#edGold").value,
        delivery: document.querySelector("#edDelivery").value,
        status: document.querySelector("#edStatus").value,
        note: document.querySelector("#edNote").value
      };
      if (!fields.base || !fields.theme) { toast("胎体材质与纹样主题不能为空", "bad"); return; }
      if (!(fields.progress >= 0 && fields.progress <= 100)) { toast("进度需在 0–100 之间", "bad"); return; }
      const { voided } = store.applyEdits(w.id, fields, I.onWorkDimensionsChanged);
      detailEditing = false;
      if (voided) {
        toast(`作品已修改；客户原签字确认作废，重新排队 #${voided.newSheet.queueNo}（旧签字留存履历）`, "warn");
      } else {
        toast("作品信息已保存");
      }
      renderAll();
    }
  });

  // 看板卡片内的工序按钮阻止冒泡
  board.addEventListener("click", e => {
    if (e.target.closest("[data-stop]")) e.stopPropagation();
  });

  /* ---------- 表单、筛选、导出 ---------- */

  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    store.add(data);
    form.reset();
    form.dryDate.value = today;
    form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    toast(`已加入工坊：${data.theme}`);
    renderAll();
  });

  document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { activeId = null; detailEditing = false; });

  document.querySelector("#clearFilters").addEventListener("click", () => {
    themeFilter.value = "";
    statusFilter.value = "";
    renderAll();
  });
  document.querySelector("#inspectClear").addEventListener("click", () => {
    inspectFilter.value = "";
    renderAll();
  });
  [statusFilter, themeFilter, sortMode].forEach(el => el.addEventListener("input", renderBoard));
  inspectFilter.addEventListener("input", renderInspectionBoard);

  document.querySelector("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ version: 2, works: store.works }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lacquer-thread-works.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  /* ---------- 兼容工序看板内联按钮 ---------- */

  window.updateStatus = function (id, status) {
    store.updateStatus(id, status);
    renderAll();
  };

  // 旧版「记缺陷」入口：打开详情并聚焦缺陷位置
  window.recordDefect = function (id) {
    showDetail(id);
    setTimeout(() => document.querySelector("#newDefectLoc")?.focus(), 30);
  };
  window.showDetail = showDetail;

  function renderAll() {
    renderSummaries();
    renderBoard();
    renderInspectionBoard();
    if (dialog.open && activeId) renderDetail();
  }

  renderAll();
})();
