(() => {
  'use strict';
  const Z = window.Z; const { html, ico, $, $$, setHtml, F } = Z;
  const get = (p, o) => Z.api.get(p, o);
  const pageHead = (...a) => Z.pageHead(...a);

  const CATEGORY = { otp: 'Verification codes', ride: 'Ride updates', account: 'Account', finance: 'Finance', marketing: 'Broadcast', admin: 'Admin messages', system: 'System' };
  const AUDIENCES = [
    { value: 'all_riders', label: 'All riders', desc: 'Active riders who accept SMS' },
    { value: 'all_drivers', label: 'All drivers', desc: 'Active drivers who accept SMS' },
    { value: 'online_drivers', label: 'Online drivers', desc: 'Drivers online right now' },
    { value: 'user', label: 'One person', desc: 'Search by name or phone' },
    { value: 'phones', label: 'Phone numbers', desc: 'Paste one or more numbers' }
  ];

  /** Client-side mirror of the server segment count so admins see cost before sending. */
  function segInfo(text) {
    const gsm = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
    const single = gsm ? 160 : 70; const multi = gsm ? 153 : 67; const n = text.length;
    return { n, enc: gsm ? 'GSM-7' : 'Unicode', seg: n === 0 ? 0 : n <= single ? 1 : Math.ceil(n / multi) };
  }

  Z.pages.sms = {
    title: 'SMS Center', subtitle: 'Delivery status, messages and automatic SMS',
    async render(ctx) {
      const [ov, log] = await Promise.all([get('/admin/sms/overview', { fresh: true }), get('/admin/sms/logs', { fresh: true, query: { limit: 25 } })]);
      if (!ctx.alive()) return;
      const t = ov.totals; const rate = t.sent30 + t.failed30 ? Math.round((t.sent30 / (t.sent30 + t.failed30)) * 100) : 100;
      const kpis = [
        ['Gateway', ov.configured ? 'Connected' : 'Not configured', ov.configured ? `${ov.provider} · sender ${ov.senderId}` : 'Set BRIQ_API_KEY on the server', 'phone', ov.configured ? 'ok' : 'danger'],
        ['Sent today', F.num(t.sent1), `${F.num(t.sent7)} in the last 7 days`, 'send', ''],
        ['Delivery rate (30d)', `${rate}%`, `${F.num(t.failed30)} failed of ${F.num(t.sent30 + t.failed30)}`, 'trend', rate >= 95 ? 'ok' : 'warn'],
        ['Segments billed (30d)', F.num(t.segments30), 'Long messages use several segments', 'chat', '']
      ];
      setHtml(ctx.el, html`${pageHead('SMS Center', 'Verification codes, ride updates and messages sent through Briq Karibu')}
        ${ov.configured ? '' : html`<div class="banner danger" style="margin-bottom:16px">${ico('alert')}<div><b>SMS is not configured</b><span>Verification codes and ride SMS cannot be delivered until BRIQ_API_KEY is set in the backend environment.</span></div></div>`}
        <div class="grid g-4">${kpis.map(([l, v, s, i, c]) => html`<div class="card kpi"><div class="row between"><span class="label">${l}</span><span class="ico ${c}">${ico(i)}</span></div><div class="value">${v}</div><div class="sub">${s}</div></div>`)}</div>
        <div class="grid g-main" style="align-items:start;margin-top:18px">
          <div class="card"><div class="card-h"><div><h3>Send a message</h3><small>Promotional messages skip people who opted out</small></div></div><div class="card-b" id="smsCompose"></div></div>
          <div class="card"><div class="card-h"><div><h3>Automatic SMS</h3><small>Switch individual messages on or off</small></div></div><div class="card-b" id="smsEvents"></div></div>
        </div>
        <div class="card" style="margin-top:18px"><div class="card-h"><div><h3>Delivery log</h3><small>Verification codes are never stored; only a masked preview is kept</small></div>
          <div class="row" style="gap:8px"><select class="input" id="logStatus" style="width:auto"><option value="">All statuses</option><option value="sent">Sent</option><option value="failed">Failed</option></select>
          <select class="input" id="logCat" style="width:auto"><option value="">All types</option>${Object.entries(CATEGORY).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
          <input class="input" id="logQ" placeholder="Search number or name" style="width:200px"></div></div>
          <div class="card-b flush tbl-wrap" id="smsLog"></div><div class="row between" style="padding:12px 16px" id="smsPager"></div></div>`);

      /* ---- compose ---- */
      let chosen = null; let people = null; let aud = 'all_riders';
      setHtml($('#smsCompose'), html`
        <div class="field"><label>Send to</label><div class="chips" id="audChips">${AUDIENCES.map((a) => html`<button type="button" class="chip ${a.value === aud ? 'active' : ''}" data-aud="${a.value}" title="${a.desc}">${a.label}</button>`)}</div></div>
        <div id="pickUser" class="hidden field"><label for="smsUq">Recipient</label><input class="input" id="smsUq" placeholder="Type a name or phone number…" autocomplete="off"><div id="smsUr" style="margin-top:6px"></div></div>
        <div id="pickPhones" class="hidden field"><label for="smsPh">Phone numbers</label><textarea class="input" id="smsPh" rows="2" placeholder="0712 345 678, +255 655 123 456"></textarea></div>
        <div class="field" style="margin-top:12px"><label for="smsMsg">Message</label><textarea class="input" id="smsMsg" rows="4" maxlength="480" placeholder="Write a short, clear message…"></textarea>
          <div class="row between" style="margin-top:6px;font-size:12.5px"><span class="muted" id="smsCount">0 characters · 0 segments</span><span class="muted" id="smsAud"></span></div></div>
        <div class="row between" style="margin-top:14px;gap:10px"><div class="row" style="gap:8px"><input class="input" id="smsTest" placeholder="Test number" style="width:170px">${Z.spinBtn(html`${ico('phone')} Send test`, '', 'id="smsTestBtn"')}</div>
          ${Z.spinBtn(html`${ico('send')} Send SMS`, 'btn-primary', 'id="smsSend"')}</div>`);
      const msg = $('#smsMsg');
      const refresh = Z.debounce(async () => {
        const s = segInfo(msg.value); $('#smsCount').textContent = `${s.n} characters · ${s.seg} segment${s.seg === 1 ? '' : 's'} · ${s.enc}`;
        if (aud === 'user' || aud === 'phones') { $('#smsAud').textContent = ''; return; }
        try { const p = await Z.api.post('/admin/sms/preview', { audience: aud, message: msg.value }); $('#smsAud').textContent = `${F.num(p.recipients)} recipient${p.recipients === 1 ? '' : 's'} · ~${F.num(p.estimatedSegments)} segments`; } catch (_) { $('#smsAud').textContent = ''; }
      }, 300);
      msg.addEventListener('input', refresh); refresh();
      $('#audChips').addEventListener('click', (e) => {
        const b = e.target.closest('[data-aud]'); if (!b) return; aud = b.dataset.aud;
        $$('#audChips .chip').forEach((c) => c.classList.toggle('active', c === b));
        $('#pickUser').classList.toggle('hidden', aud !== 'user'); $('#pickPhones').classList.toggle('hidden', aud !== 'phones'); refresh();
      });
      $('#smsUq').addEventListener('input', Z.debounce(async (e) => {
        const q = e.target.value.trim().toLowerCase(); if (q.length < 2) return setHtml($('#smsUr'), '');
        if (!people) { const [dr, ri] = await Promise.all([get('/admin/drivers', { ttl: 60000 }), get('/admin/riders', { ttl: 60000 })]); people = [...dr.map((x) => ({ id: x.id, name: x.fullName, role: 'Driver', phone: x.phone })), ...ri.map((x) => ({ id: x.id, name: x.fullName, role: 'Rider', phone: x.phone }))]; }
        const m = people.filter((p) => `${p.name} ${p.phone}`.toLowerCase().includes(q)).slice(0, 6);
        setHtml($('#smsUr'), m.length ? html`<div class="chips">${m.map((p) => html`<button type="button" class="chip" data-pick="${p.id}" data-name="${p.name}">${p.name} · ${p.role}</button>`)}</div>` : html`<span class="muted">No matches</span>`);
      }, 250));
      $('#smsCompose').addEventListener('click', (e) => { const p = e.target.closest('[data-pick]'); if (p) { chosen = { id: +p.dataset.pick, name: p.dataset.name }; setHtml($('#smsUr'), html`<span class="badge badge-success nodot">${ico('check')} ${chosen.name}</span>`); } });
      $('#smsTestBtn').addEventListener('click', async (e) => {
        const phone = $('#smsTest').value.trim(); if (!phone) return Z.toast('Enter a phone number for the test.', 'warn');
        await Z.busy(e.currentTarget, async () => { try { const r = await Z.api.post('/admin/sms/test', { phone }); Z.toast(`Test SMS sent to ${r.to}.`); Z.reloadPage(); } catch (err) { Z.toast(err.message, 'error'); } });
      });
      $('#smsSend').addEventListener('click', async (e) => {
        const message = msg.value.trim(); if (!message) return Z.toast('Write a message first.', 'warn');
        if (aud === 'user' && !chosen) return Z.toast('Choose who should receive this SMS.', 'warn');
        const target = { audience: aud, message, userId: chosen && chosen.id, phones: $('#smsPh').value };
        const who = { all_riders: 'all opted-in riders', all_drivers: 'all opted-in drivers', online_drivers: 'online drivers', user: chosen && chosen.name, phones: 'the listed numbers' }[aud];
        const ok = await Z.confirm({ title: 'Send this SMS?', message: `It will be sent to ${who} and cannot be recalled. Standard SMS charges apply.`, confirmLabel: 'Send now', tone: 'warn' }); if (!ok) return;
        await Z.busy(e.currentTarget, async () => { try { const r = await Z.api.post('/admin/sms/send', target); Z.toast(`Sent to ${r.sent} recipient${r.sent === 1 ? '' : 's'}${r.failed ? ` (${r.failed} failed)` : ''}.`); Z.reloadPage(); } catch (err) { Z.toast(err.message, 'error'); } });
      });

      /* ---- automatic SMS switches ---- */
      const draw = (events) => setHtml($('#smsEvents'), html`<div class="list">${events.map((ev) => html`<label class="row between" style="padding:10px 0;border-bottom:1px solid var(--line);gap:12px;cursor:pointer"><span style="font-size:13.5px">${ev.label}</span><input type="checkbox" data-ev="${ev.key}" ${ev.enabled ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--brand)"></label>`)}</div>
        <p class="muted" style="font-size:12.5px;margin:12px 0 0">Verification codes are always sent: they are required to sign in.</p>`);
      draw(ov.events);
      $('#smsEvents').addEventListener('change', async (e) => {
        const cb = e.target.closest('[data-ev]'); if (!cb) return;
        try { await Z.api.patch('/admin/sms/settings', { events: { [cb.dataset.ev]: cb.checked } }); Z.toast('SMS setting saved.'); }
        catch (err) { cb.checked = !cb.checked; Z.toast(err.message, 'error'); }
      });

      /* ---- log ---- */
      let page = 1; let total = log.total;
      const drawLog = (items) => setHtml($('#smsLog'), items.length ? html`<table class="tbl"><thead><tr><th>When</th><th>To</th><th>Type</th><th>Message</th><th>Status</th></tr></thead><tbody>${items.map((m) => html`<tr>
        <td>${F.dt(m.createdAt)}</td><td><b>${m.userName || '—'}</b><div class="muted" style="font-size:12.5px">${m.recipient}</div></td>
        <td><span class="badge nodot">${CATEGORY[m.category] || F.title(m.category)}</span></td><td style="max-width:340px">${F.trunc(m.preview || '', 90)}<div class="muted" style="font-size:12px">${m.segments} segment${m.segments === 1 ? '' : 's'}${m.template ? ` · ${m.template}` : ''}</div></td>
        <td>${Z.badge(m.status === 'sent' ? 'success' : m.status === 'failed' ? 'danger' : 'neutral', F.title(m.status))}${m.error ? html`<div class="muted" style="font-size:12px;max-width:200px">${F.trunc(m.error, 60)}</div>` : ''}</td></tr>`)}</tbody></table>` : Z.empty('No SMS yet', 'Messages appear here as soon as the platform sends one.', 'chat'));
      const load = async () => {
        const q = { page, limit: 25, status: $('#logStatus').value, category: $('#logCat').value, q: $('#logQ').value.trim() };
        const r = await get('/admin/sms/logs', { fresh: true, query: q }); total = r.total; drawLog(r.items);
        const pages = Math.max(1, Math.ceil(total / 25));
        setHtml($('#smsPager'), html`<span class="muted">${F.num(total)} message${total === 1 ? '' : 's'}</span><div class="row" style="gap:8px"><button class="btn btn-sm" id="pgPrev" ${page <= 1 ? 'disabled' : ''}>Previous</button><span class="muted">Page ${page} of ${pages}</span><button class="btn btn-sm" id="pgNext" ${page >= pages ? 'disabled' : ''}>Next</button></div>`);
      };
      drawLog(log.items); setHtml($('#smsPager'), '');
      load();
      ['logStatus', 'logCat'].forEach((id) => $('#' + id).addEventListener('change', () => { page = 1; load(); }));
      $('#logQ').addEventListener('input', Z.debounce(() => { page = 1; load(); }, 300));
      $('#smsPager').addEventListener('click', (e) => { if (e.target.id === 'pgPrev' && page > 1) { page--; load(); } if (e.target.id === 'pgNext') { page++; load(); } });
    }
  };
})();
