/**
 * GymSpace Pro — Zero-Lag Athletic Club Controller
 * - Renders ONLY the active pane for 0ms UI latency
 * - Tracks Member Fitness Goals, Morning/Evening Batches, Payment Mode, and 30/15/5d Alerts
 */

const App = (() => {
  let currentGymMeta = null;
  let currentCryptoKey = null;
  let localFileHandle = null;
  let activeRole = 'OWNER';
  let activeView = 'dashboard';
  let reminderFilter = 'ALL';
  let searchQuery = '';
  let searchDebounce = null;

  let state = {
    gym: {},
    plans: {},
    trainers: [],
    members: []
  };

  const DEFAULT_PLANS = {
    '1M': { code: '1M', label: '1 Month Plan', days: 30, fee: 1500 },
    '3M': { code: '3M', label: '3 Months Plan', days: 90, fee: 4000 },
    '6M': { code: '6M', label: '6 Months Plan', days: 180, fee: 7200 },
    '1Y': { code: '1Y', label: '1 Year Plan', days: 365, fee: 12500 }
  };

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==================== TIMEZONE-SAFE LOCAL DATE HELPERS ====================
  function todayLocalISO() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDaysLocalISO(dateStr, daysToAdd) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + Number(daysToAdd));
    const ny = dt.getFullYear();
    const nm = String(dt.getMonth() + 1).padStart(2, '0');
    const nd = String(dt.getDate()).padStart(2, '0');
    return `${ny}-${nm}-${nd}`;
  }

  function getDaysRemaining(endDateStr) {
    const [ty, tm, td] = todayLocalISO().split('-').map(Number);
    const [ey, em, ed] = endDateStr.split('-').map(Number);
    const todayMidnight = new Date(ty, tm - 1, td);
    const endMidnight = new Date(ey, em - 1, ed);
    return Math.round((endMidnight - todayMidnight) / (1000 * 60 * 60 * 24));
  }

  function getExpiryStatus(daysLeft) {
    if (daysLeft <= 0) {
      return { code: 'EXPIRED', text: `Expired (${Math.abs(daysLeft)}d ago)`, tagClass: 'tag-expired', color: '#FF453A', key: 'EXP' };
    }
    if (daysLeft <= 5) {
      return { code: '5D', text: `${daysLeft}d left • 5-Day Alert`, tagClass: 'tag-5d', color: '#FF453A', key: '5D' };
    }
    if (daysLeft <= 15) {
      return { code: '15D', text: `${daysLeft}d left • 15-Day Alert`, tagClass: 'tag-15d', color: '#FF9F0A', key: '15D' };
    }
    if (daysLeft <= 30) {
      return { code: '30D', text: `${daysLeft}d left • 1-Month Alert`, tagClass: 'tag-30d', color: '#0A84FF', key: '30D' };
    }
    return { code: 'ACTIVE', text: `${daysLeft} days left`, tagClass: 'tag-active', color: '#30D158', key: null };
  }

  function showToast(message) {
    const box = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<svg class="icon-sm text-mint"><use href="#ico-check"></use></svg><span>${esc(message)}</span>`;
    box.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function togglePinVisibility(inputId) {
    const inp = document.getElementById(inputId);
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  }

  function checkPinStrength(val) {
    const bar = document.getElementById('pin-strength-fill');
    if (!bar) return;
    const len = val.length;
    if (len === 0) { bar.style.width = '0%'; return; }
    if (len < 4) { bar.style.width = '30%'; bar.style.backgroundColor = '#FF453A'; return; }
    if (len < 8) { bar.style.width = '68%'; bar.style.backgroundColor = '#FF9F0A'; return; }
    bar.style.width = '100%';
    bar.style.backgroundColor = '#30D158';
  }

  // ==================== INITIALIZATION & AUTH ====================
  function init() {
    populateGymSelect();
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMemberModal();
        closeTrainerModal();
      }
    });
  }

  function switchAuthTab(tab) {
    const seg = document.getElementById('auth-seg');
    if (seg) seg.dataset.active = tab === 'unlock' ? '0' : '1';
    document.getElementById('tab-unlock').classList.toggle('active', tab === 'unlock');
    document.getElementById('tab-create').classList.toggle('active', tab === 'create');
    document.getElementById('form-unlock').classList.toggle('hidden', tab !== 'unlock');
    document.getElementById('form-create').classList.toggle('hidden', tab !== 'create');
  }

  function populateGymSelect() {
    const list = CryptoVault.getSpacesList();
    const sel = document.getElementById('select-gym');
    sel.innerHTML = '';

    if (list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No Gym Space found — Create one first';
      sel.appendChild(opt);
      switchAuthTab('create');
      return;
    }

    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.gymId;
      opt.textContent = item.name;
      sel.appendChild(opt);
    });
  }

  async function createGym(e) {
    e.preventDefault();
    const name = document.getElementById('new-name').value.trim();
    const phone = document.getElementById('new-phone').value.trim();
    const currency = document.getElementById('new-currency').value;
    const pin = document.getElementById('new-pin').value;

    const gymId = 'GYM_' + Date.now().toString(36).toUpperCase();
    const salt = CryptoVault.generateSalt();
    const key = await CryptoVault.deriveKey(pin, salt, 120000);

    const today = todayLocalISO();

    const initialData = {
      gym: { gymId, name, phone, currency, createdAt: today },
      plans: JSON.parse(JSON.stringify(DEFAULT_PLANS)),
      trainers: [
        { id: 'TRN-1', name: 'Coach Arjun', role: 'Strength & Hypertrophy', shift: 'Morning Batch', phone: '+919876500011', salary: 25000 },
        { id: 'TRN-2', name: 'Coach Meera', role: 'Fat Loss & HIIT Coach', shift: 'Evening Batch', phone: '+919876500022', salary: 22000 }
      ],
      members: [
        {
          id: 'M-101',
          name: 'Aarav Sharma',
          phone: '+919876543210',
          plan: '3M',
          goal: 'Muscle Gain',
          batch: 'Morning Batch',
          payMode: 'UPI / QR',
          joinDate: addDaysLocalISO(today, -62),
          endDate: addDaysLocalISO(today, 28),
          fee: 4000,
          paid: 4000,
          due: 0,
          trainer: 'Coach Arjun',
          sentAlerts: {}
        },
        {
          id: 'M-102',
          name: 'Sneha Patel',
          phone: '+919876543211',
          plan: '1M',
          goal: 'Weight Loss',
          batch: 'Evening Batch',
          payMode: 'Cash',
          joinDate: addDaysLocalISO(today, -16),
          endDate: addDaysLocalISO(today, 14),
          fee: 1500,
          paid: 1200,
          due: 300,
          trainer: 'Coach Meera',
          sentAlerts: {}
        },
        {
          id: 'M-103',
          name: 'Rohan Malhotra',
          phone: '+919876543212',
          plan: '6M',
          goal: 'Strength',
          batch: 'Morning Batch',
          payMode: 'UPI / QR',
          joinDate: addDaysLocalISO(today, -176),
          endDate: addDaysLocalISO(today, 4),
          fee: 7200,
          paid: 7200,
          due: 0,
          trainer: 'Coach Arjun',
          sentAlerts: {}
        }
      ]
    };

    const encrypted = await CryptoVault.encryptData(initialData, key);
    await CryptoVault.saveEncryptedVault(gymId, encrypted);

    const spaces = CryptoVault.getSpacesList();
    const meta = { gymId, name, salt, kdfIterations: 120000 };
    spaces.push(meta);
    CryptoVault.saveSpacesList(spaces);

    currentGymMeta = meta;
    currentCryptoKey = key;
    state = initialData;

    enterWorkspace();
    showToast(`Created "${name}" isolated vault`);
  }

  async function unlockGym(e) {
    e.preventDefault();
    try {
      CryptoVault.checkRateLimit();
    } catch (lockErr) {
      const secs = lockErr.message.split(':')[1];
      return showToast(`Too many failed attempts. Wait ${secs}s.`);
    }

    const gymId = document.getElementById('select-gym').value;
    const pin = document.getElementById('unlock-pin').value;

    const spaces = CryptoVault.getSpacesList();
    const meta = spaces.find(s => s.gymId === gymId);
    if (!meta) return showToast('Please create a Gym Space first');

    try {
      const encrypted = await CryptoVault.loadEncryptedVault(gymId);
      if (!encrypted) throw new Error('Vault missing');

      const iters = encrypted.kdfIterations || meta.kdfIterations || 100000;
      const key = await CryptoVault.deriveKey(pin, meta.salt, iters);

      state = await CryptoVault.decryptData(encrypted, key);
      CryptoVault.recordAuthResult(true);

      currentGymMeta = meta;
      currentCryptoKey = key;
      document.getElementById('unlock-pin').value = '';

      enterWorkspace();
      showToast(`Unlocked ${state.gym.name}`);
    } catch {
      CryptoVault.recordAuthResult(false);
      showToast('Incorrect Master PIN / Password');
    }
  }

  // Non-blocking background persistence so UI never waits for encryption
  function saveStateAsync() {
    if (!currentGymMeta || !currentCryptoKey) return;
    setTimeout(async () => {
      try {
        const encrypted = await CryptoVault.encryptData(state, currentCryptoKey);
        await CryptoVault.saveEncryptedVault(currentGymMeta.gymId, encrypted);
        if (localFileHandle) {
          const writable = await localFileHandle.createWritable();
          await writable.write(JSON.stringify({ meta: currentGymMeta, vault: encrypted }, null, 2));
          await writable.close();
        }
      } catch (err) {
        console.warn('Background save warning:', err);
      }
    }, 10);
  }

  function enterWorkspace() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-shell').classList.remove('hidden');

    const initials = state.gym.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('ui-gym-initials').textContent = initials || 'GY';
    document.getElementById('ui-gym-title').textContent = state.gym.name;
    document.getElementById('hero-greeting').textContent = `${state.gym.name} — Live Operations`;
    document.getElementById('info-gym-name').textContent = state.gym.name;
    document.getElementById('info-gym-id').textContent = state.gym.gymId;

    populateTrainerFilter();
    setRole('OWNER');
    showView('dashboard');
  }

  function lockGym() {
    currentGymMeta = null;
    currentCryptoKey = null;
    localFileHandle = null;
    state = { gym: {}, plans: {}, trainers: [], members: [] };

    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    populateGymSelect();
    switchAuthTab('unlock');
    showToast('Gym Vault locked');
  }

  // ==================== OWNER vs. TRAINER MODE ====================
  function setRole(role) {
    activeRole = role;
    const roleSeg = document.getElementById('role-seg');
    if (roleSeg) roleSeg.dataset.active = role === 'OWNER' ? '0' : '1';

    document.getElementById('role-owner-btn').classList.toggle('active', role === 'OWNER');
    document.getElementById('role-trainer-btn').classList.toggle('active', role === 'TRAINER');

    const mobBtn = document.getElementById('mobile-role-btn');
    if (mobBtn) mobBtn.textContent = role === 'OWNER' ? 'Owner Mode' : 'Trainer Mode';

    document.querySelectorAll('.owner-only').forEach(el => {
      el.classList.toggle('hidden', role === 'TRAINER');
    });

    if (role === 'TRAINER' && (activeView === 'plans' || activeView === 'settings')) {
      showView('dashboard');
      return;
    }
    renderActiveView();
  }

  function toggleRoleMobile() {
    const nextRole = activeRole === 'OWNER' ? 'TRAINER' : 'OWNER';
    setRole(nextRole);
    showToast(`Switched to ${nextRole === 'OWNER' ? 'Owner Mode' : 'Trainer Mode'}`);
  }

  function showView(viewName) {
    activeView = viewName;
    document.querySelectorAll('.view-pane').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(`view-${viewName}`);
    if (target) target.classList.remove('hidden');

    document.querySelectorAll('.nav-link, .mob-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    renderActiveView();
  }

  // Only render what the user is currently looking at for 0ms latency
  function renderActiveView() {
    if (!currentGymMeta) return;
    updateSidebarAlertCounter();
    if (activeView === 'dashboard') renderOverview();
    else if (activeView === 'members') renderMembers();
    else if (activeView === 'reminders') renderReminders();
    else if (activeView === 'trainers') renderTrainers();
    else if (activeView === 'plans') renderPlans();
  }

  function updateSidebarAlertCounter() {
    const count = state.members.filter(m => getDaysRemaining(m.endDate) <= 30).length;
    document.getElementById('badge-side-alerts').textContent = count;
  }

  function populateTrainerFilter() {
    const sel = document.getElementById('filter-trainer');
    if (!sel) return;
    const currentVal = sel.value || 'ALL';
    sel.innerHTML = `<option value="ALL">All Trainers</option><option value="Unassigned">Unassigned</option>` +
      state.trainers.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
    sel.value = currentVal;
  }

  function renderOverview() {
    const cur = state.gym.currency || '₹';
    let activeCount = 0;
    let totalPaid = 0;
    let totalDue = 0;
    let morningCount = 0;
    let eveningCount = 0;

    const list30 = [];
    const list15 = [];
    const list5 = [];

    state.members.forEach(m => {
      const days = getDaysRemaining(m.endDate);
      if (days > 0) {
        activeCount++;
        if ((m.batch || '').includes('Morning')) morningCount++;
        else if ((m.batch || '').includes('Evening')) eveningCount++;
      }
      totalPaid += Number(m.paid || 0);
      totalDue += Number(m.due || 0);

      if (days >= 16 && days <= 30) list30.push({ m, days });
      else if (days >= 6 && days <= 15) list15.push({ m, days });
      else if (days <= 5) list5.push({ m, days });
    });

    const totalMembers = state.members.length;
    const expiringTotal = list30.length + list15.length + list5.length;

    const activePct = totalMembers > 0 ? Math.round((activeCount / totalMembers) * 100) : 100;
    const totalBilled = totalPaid + totalDue;
    const collectPct = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 100;

    const outerCirc = 351.8;
    const innerCirc = 251.3;
    const ringActiveEl = document.getElementById('svg-ring-active');
    const ringFeeEl = document.getElementById('svg-ring-fee');

    if (ringActiveEl && ringFeeEl) {
      ringActiveEl.style.strokeDashoffset = outerCirc - (outerCirc * activePct) / 100;
      ringFeeEl.style.strokeDashoffset = innerCirc - (innerCirc * collectPct) / 100;
    }

    document.getElementById('ring-label-active').textContent = `${activePct}%`;
    document.getElementById('ring-label-collection').textContent = `${collectPct}%`;
    document.getElementById('ring-label-batches').textContent = `${morningCount} AM • ${eveningCount} PM`;

    document.getElementById('stat-active').textContent = activeCount.toLocaleString();
    document.getElementById('stat-total').textContent = `${totalMembers} total registered`;
    document.getElementById('stat-expiring').textContent = expiringTotal.toLocaleString();
    document.getElementById('stat-pending').textContent = `${cur}${totalDue.toLocaleString()}`;
    document.getElementById('stat-revenue').textContent = `${cur}${totalPaid.toLocaleString()}`;

    document.getElementById('count-30d').textContent = list30.length;
    document.getElementById('count-15d').textContent = list15.length;
    document.getElementById('count-5d').textContent = list5.length;

    const renderRadarBox = (arr, targetId) => {
      const box = document.getElementById(targetId);
      if (arr.length === 0) {
        box.innerHTML = `<p class="muted" style="padding: 8px 0;">All clear in this window.</p>`;
        return;
      }
      box.innerHTML = arr.map(({ m, days }) => {
        const st = getExpiryStatus(days);
        const sent = m.sentAlerts && m.sentAlerts[st.key];
        return `
          <div class="mini-member-card">
            <div class="mini-top">
              <div>
                <strong>${esc(m.name)}</strong>
                <div class="muted">${esc(m.phone)} • ${esc(m.trainer || 'General Floor')}</div>
              </div>
              <span class="badge-tag ${st.tagClass}">${days <= 0 ? 'Expired' : days + 'd left'}</span>
            </div>
            <div class="mini-actions">
              <button type="button" class="btn btn-whatsapp btn-sm" onclick="App.sendReminder('${esc(m.id)}', 'WA')">
                <svg class="icon-xs"><use href="#ico-whatsapp"></use></svg>
                <span>WhatsApp ${sent ? '✓' : ''}</span>
              </button>
              <button type="button" class="btn btn-subtle btn-sm" onclick="App.sendReminder('${esc(m.id)}', 'SMS')">
                <svg class="icon-xs"><use href="#ico-sms"></use></svg>
                <span>SMS</span>
              </button>
              <button type="button" class="btn btn-primary btn-sm" onclick="App.quickExtend('${esc(m.id)}')" title="Instant 1-Click Plan Renewal">
                <svg class="icon-xs"><use href="#ico-renew"></use></svg>
                <span>+${esc(m.plan)}</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    };

    renderRadarBox(list30, 'radar-list-30d');
    renderRadarBox(list15, 'radar-list-15d');
    renderRadarBox(list5, 'radar-list-5d');
  }

  function renderMembers() {
    const cur = state.gym.currency || '₹';
    const trnFilter = document.getElementById('filter-trainer').value;
    const planFilter = document.getElementById('filter-plan').value;
    const winFilter = document.getElementById('filter-window').value;
    const q = searchQuery.toLowerCase().trim();

    const filtered = state.members.filter(m => {
      const days = getDaysRemaining(m.endDate);
      const st = getExpiryStatus(days);
      if (trnFilter !== 'ALL' && (m.trainer || 'Unassigned') !== trnFilter) return false;
      if (planFilter !== 'ALL' && m.plan !== planFilter) return false;
      if (winFilter !== 'ALL' && st.code !== winFilter) return false;
      if (q && !(`${m.name} ${m.phone} ${m.trainer} ${m.plan} ${m.goal || ''} ${m.batch || ''}`.toLowerCase().includes(q))) return false;
      return true;
    });

    const container = document.getElementById('members-list');
    if (filtered.length === 0) {
      container.innerHTML = `<div class="surface-card pad-card" style="text-align:center;"><p class="muted">No matching members found.</p></div>`;
      return;
    }

    container.innerHTML = filtered.map(m => {
      const days = getDaysRemaining(m.endDate);
      const st = getExpiryStatus(days);
      const initials = m.name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const planObj = state.plans[m.plan] || DEFAULT_PLANS[m.plan] || { label: m.plan, days: 30 };
      const pctRemaining = Math.max(0, Math.min(100, Math.round((days / planObj.days) * 100)));

      return `
        <div class="surface-card member-row-card">
          <div class="mem-primary">
            <div class="avatar-circle">${esc(initials)}</div>
            <div style="min-width:0;">
              <strong>${esc(m.name)}</strong>
              <div class="muted">${esc(m.phone)}</div>
              <div class="meta-sub-pills">
                <span class="sub-chip">${esc(m.goal || 'General Fitness')}</span>
                <span class="sub-chip">${esc(m.batch || 'All-Day Access')}</span>
              </div>
            </div>
          </div>

          <div>
            <strong>${esc(planObj.label)}</strong>
            <div class="muted">Coach: ${esc(m.trainer || 'Unassigned')}</div>
          </div>

          <div class="cycle-progress-wrap">
            <div style="display:flex;justify-content:space-between;font-size:12px;">
              <span class="muted">Ends ${esc(m.endDate)}</span>
              <strong>${pctRemaining}%</strong>
            </div>
            <div class="cycle-bar-bg">
              <div class="cycle-bar-fill" style="width:${pctRemaining}%;background:${st.color};"></div>
            </div>
          </div>

          <div>
            <span class="badge-tag ${st.tagClass}">${st.text}</span>
            ${m.due > 0
              ? `<div class="text-danger" style="font-size:12px;font-weight:600;margin-top:4px;">Balance: ${esc(cur)}${Number(m.due).toLocaleString()}</div>`
              : `<div class="muted" style="margin-top:4px;">Paid: ${esc(cur)}${Number(m.paid).toLocaleString()} (${esc(m.payMode || 'UPI')})</div>`}
          </div>

          <div class="mini-actions">
            <button type="button" class="btn btn-whatsapp btn-sm" onclick="App.sendReminder('${esc(m.id)}', 'WA')" title="Send WhatsApp Alert">
              <svg class="icon-sm"><use href="#ico-whatsapp"></use></svg>
            </button>
            <button type="button" class="btn btn-primary btn-sm" onclick="App.quickExtend('${esc(m.id)}')" title="1-Tap Extend Plan">
              <svg class="icon-xs"><use href="#ico-renew"></use></svg>
              <span>+${esc(m.plan)}</span>
            </button>
            <button type="button" class="btn btn-subtle btn-sm" onclick="App.openMemberModal('${esc(m.id)}')">
              <span>Edit</span>
            </button>
            ${activeRole === 'OWNER' ? `
              <button type="button" class="btn btn-danger btn-sm" onclick="App.deleteMember('${esc(m.id)}')" title="Remove Member">
                <svg class="icon-xs"><use href="#ico-trash"></use></svg>
              </button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // Instant 1-Click Plan Renewal without opening the form
  function quickExtend(memberId) {
    const m = state.members.find(x => x.id === memberId);
    if (!m) return;
    const planObj = state.plans[m.plan] || DEFAULT_PLANS[m.plan] || { days: 30, fee: m.fee };
    const today = todayLocalISO();
    const baseDate = getDaysRemaining(m.endDate) > 0 ? m.endDate : today;

    m.joinDate = today;
    m.endDate = addDaysLocalISO(baseDate, planObj.days);
    m.fee = Number(planObj.fee);
    m.paid = Number(planObj.fee);
    m.due = 0;
    m.sentAlerts = {};

    saveStateAsync();
    renderActiveView();
    showToast(`Extended ${m.name}'s ${m.plan} plan to ${m.endDate}`);
  }

  function onQuickSearch(val) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = val;
      if (activeView !== 'members') {
        showView('members');
      } else {
        renderMembers();
      }
    }, 80);
  }

  // ==================== 30 / 15 / 5-DAY MESSAGE DISPATCHER ====================
  function setReminderFilter(code, btn) {
    reminderFilter = code;
    document.querySelectorAll('.pill-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderReminders();
  }

  function generateMessageText(member, daysLeft, statusCode) {
    const cur = state.gym.currency || '₹';
    const planName = state.plans[member.plan]?.label || member.plan;
    const planFee = state.plans[member.plan]?.fee || member.fee;
    const gymName = state.gym.name;

    if (statusCode === '30D') {
      return `Hi ${member.name}, friendly heads-up from ${gymName}: Your ${planName} has ${daysLeft} days (~1 Month) remaining and ends on ${member.endDate}. Let your trainer (${member.trainer || 'Team'}) know when you'd like to renew!`;
    }
    if (statusCode === '15D') {
      return `Hi ${member.name}! Only ${daysLeft} days left on your ${planName} at ${gymName} (Ends: ${member.endDate}). Standard renewal fee is ${cur}${planFee}. Renew early at the front desk to keep your ${member.goal || 'fitness'} momentum going!`;
    }
    if (statusCode === '5D') {
      return `Urgent Renewal Alert from ${gymName}: Hi ${member.name}, your gym membership expires in just ${daysLeft} day(s) on ${member.endDate}.${member.due > 0 ? ` Pending balance: ${cur}${member.due}.` : ''} Please renew this week to avoid slot interruption.`;
    }
    return `Hi ${member.name}, your membership at ${gymName} ended on ${member.endDate}. We'd love to see you back in the ${member.batch || 'gym'}—visit us anytime to reactivate your plan!`;
  }

  function sendReminder(memberId, channel) {
    const m = state.members.find(x => x.id === memberId);
    if (!m) return;

    const days = getDaysRemaining(m.endDate);
    const st = getExpiryStatus(days);
    const message = generateMessageText(m, days, st.code);
    const cleanPhone = m.phone.replace(/[^0-9+]/g, '');

    if (st.key) {
      m.sentAlerts = m.sentAlerts || {};
      m.sentAlerts[st.key] = todayLocalISO();
      saveStateAsync();
      renderActiveView();
    }

    if (channel === 'WA') {
      const waNumber = cleanPhone.replace(/^\+/, '');
      window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    } else {
      window.open(`sms:${cleanPhone}?body=${encodeURIComponent(message)}`, '_self');
    }
  }

  function renderReminders() {
    const listEl = document.getElementById('reminders-list');
    const items = state.members
      .map(m => {
        const days = getDaysRemaining(m.endDate);
        const st = getExpiryStatus(days);
        return { m, days, st };
      })
      .filter(item => {
        if (reminderFilter === 'ALL') return item.days <= 30;
        return item.st.code === reminderFilter;
      })
      .sort((a, b) => a.days - b.days);

    if (items.length === 0) {
      listEl.innerHTML = `<div class="surface-card pad-card" style="text-align:center;"><p class="muted">Zero members currently waiting in this expiry milestone.</p></div>`;
      return;
    }

    listEl.innerHTML = items.map(({ m, days, st }) => {
      const preview = generateMessageText(m, days, st.code);
      const sentOn = m.sentAlerts?.[st.key];
      return `
        <div class="surface-card pad-card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">
          <div style="flex:1;min-width:240px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;">
              <strong>${esc(m.name)}</strong>
              <span class="badge-tag ${st.tagClass}">${st.text}</span>
              <span class="muted">Ends: ${esc(m.endDate)} • ${esc(m.batch || 'All-Day')} • Coach: ${esc(m.trainer || 'Unassigned')}</span>
              ${sentOn ? `<span class="badge-tag tag-active">Sent ${esc(sentOn)}</span>` : ''}
            </div>
            <p class="muted" style="font-size:13px;">"${esc(preview)}"</p>
          </div>
          <div class="mini-actions">
            <button type="button" class="btn btn-whatsapp btn-sm" onclick="App.sendReminder('${esc(m.id)}', 'WA')">
              <svg class="icon-xs"><use href="#ico-whatsapp"></use></svg>
              <span>Send WhatsApp</span>
            </button>
            <button type="button" class="btn btn-subtle btn-sm" onclick="App.sendReminder('${esc(m.id)}', 'SMS')">
              <svg class="icon-xs"><use href="#ico-sms"></use></svg>
              <span>Send SMS</span>
            </button>
            <button type="button" class="btn btn-primary btn-sm" onclick="App.quickExtend('${esc(m.id)}')">
              <svg class="icon-xs"><use href="#ico-renew"></use></svg>
              <span>Extend +${esc(m.plan)}</span>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // ==================== ZERO-LAG MODALS ====================
  function onBackdropClick(e, modalId) {
    if (e.target && e.target.id === modalId) {
      document.getElementById(modalId).classList.add('hidden');
    }
  }

  function openMemberModal(memberId = null) {
    const modal = document.getElementById('modal-member');
    const trnSelect = document.getElementById('mem-trainer');
    trnSelect.innerHTML = `<option value="Unassigned">Unassigned / General Floor</option>` +
      state.trainers.map(t => `<option value="${esc(t.name)}">${esc(t.name)} (${esc(t.role)})</option>`).join('');

    if (memberId) {
      const m = state.members.find(x => x.id === memberId);
      if (!m) return;
      document.getElementById('modal-member-title').textContent = `Edit / Renew — ${m.name}`;
      document.getElementById('mem-id').value = m.id;
      document.getElementById('mem-name').value = m.name;
      document.getElementById('mem-phone').value = m.phone;

      const radio = document.querySelector(`input[name="mem-plan"][value="${m.plan}"]`);
      if (radio) radio.checked = true;

      document.getElementById('mem-goal').value = m.goal || 'Muscle Gain';
      document.getElementById('mem-batch').value = m.batch || 'Morning Batch';
      document.getElementById('mem-paymode').value = m.payMode || 'UPI / QR';
      document.getElementById('mem-join').value = m.joinDate;
      document.getElementById('mem-end').value = m.endDate;
      document.getElementById('mem-fee').value = m.fee;
      document.getElementById('mem-paid').value = m.paid;
      document.getElementById('mem-due').value = m.due || 0;
      document.getElementById('mem-trainer').value = m.trainer || 'Unassigned';
    } else {
      document.getElementById('modal-member-title').textContent = 'New Member Admission';
      document.getElementById('form-member').reset();
      document.getElementById('mem-id').value = '';
      document.getElementById('mem-join').value = todayLocalISO();
      updateMemberFormMath();
    }

    modal.classList.remove('hidden');
  }

  function closeMemberModal() {
    document.getElementById('modal-member').classList.add('hidden');
  }

  function updateMemberFormMath() {
    const selectedPlan = document.querySelector('input[name="mem-plan"]:checked')?.value || '1M';
    const joinDate = document.getElementById('mem-join').value || todayLocalISO();
    const planObj = state.plans[selectedPlan] || DEFAULT_PLANS[selectedPlan];

    document.getElementById('mem-end').value = addDaysLocalISO(joinDate, planObj.days);
    document.getElementById('mem-fee').value = planObj.fee;
    document.getElementById('mem-paid').value = planObj.fee;
    updateBalanceMath();
  }

  function updateBalanceMath() {
    const fee = Number(document.getElementById('mem-fee').value || 0);
    const paid = Number(document.getElementById('mem-paid').value || 0);
    document.getElementById('mem-due').value = Math.max(0, fee - paid);
  }

  function saveMember(e) {
    e.preventDefault();
    const id = document.getElementById('mem-id').value || ('M-' + Date.now().toString().slice(-5));
    const selectedPlan = document.querySelector('input[name="mem-plan"]:checked')?.value || '1M';

    const memberRecord = {
      id,
      name: document.getElementById('mem-name').value.trim(),
      phone: document.getElementById('mem-phone').value.trim(),
      plan: selectedPlan,
      goal: document.getElementById('mem-goal').value,
      batch: document.getElementById('mem-batch').value,
      payMode: document.getElementById('mem-paymode').value,
      joinDate: document.getElementById('mem-join').value,
      endDate: document.getElementById('mem-end').value,
      fee: Number(document.getElementById('mem-fee').value || 0),
      paid: Number(document.getElementById('mem-paid').value || 0),
      due: Number(document.getElementById('mem-due').value || 0),
      trainer: document.getElementById('mem-trainer').value,
      sentAlerts: {}
    };

    const idx = state.members.findIndex(x => x.id === id);
    if (idx >= 0) state.members[idx] = memberRecord;
    else state.members.unshift(memberRecord);

    closeMemberModal();
    renderActiveView();
    saveStateAsync();
    showToast(`Saved membership for ${memberRecord.name}`);
  }

  function deleteMember(id) {
    if (!confirm('Remove this member from the gym space?')) return;
    state.members = state.members.filter(m => m.id !== id);
    renderActiveView();
    saveStateAsync();
    showToast('Member removed');
  }

  // ==================== TRAINERS & STAFF ====================
  function openTrainerModal() {
    document.getElementById('form-trainer').reset();
    document.getElementById('modal-trainer').classList.remove('hidden');
  }

  function closeTrainerModal() {
    document.getElementById('modal-trainer').classList.add('hidden');
  }

  function saveTrainer(e) {
    e.preventDefault();
    const trn = {
      id: 'TRN-' + Date.now().toString().slice(-4),
      name: document.getElementById('trn-name').value.trim(),
      role: document.getElementById('trn-role').value,
      shift: document.getElementById('trn-shift').value,
      phone: document.getElementById('trn-phone').value.trim(),
      salary: Number(document.getElementById('trn-salary').value || 0)
    };
    state.trainers.push(trn);
    closeTrainerModal();
    populateTrainerFilter();
    renderActiveView();
    saveStateAsync();
    showToast(`Added ${trn.name}`);
  }

  function deleteTrainer(id) {
    if (!confirm('Remove this trainer?')) return;
    state.trainers = state.trainers.filter(t => t.id !== id);
    populateTrainerFilter();
    renderActiveView();
    saveStateAsync();
  }

  function renderTrainers() {
    const cur = state.gym.currency || '₹';
    const grid = document.getElementById('trainers-grid');
    if (state.trainers.length === 0) {
      grid.innerHTML = `<div class="surface-card pad-card"><p class="muted">No trainers added yet.</p></div>`;
      return;
    }

    grid.innerHTML = state.trainers.map(t => {
      const assignedCount = state.members.filter(m => m.trainer === t.name).length;
      return `
        <div class="surface-card pad-card" style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div class="stat-icon-wrap icon-mint"><svg class="icon-sm"><use href="#ico-trainer"></use></svg></div>
              <div>
                <h3 style="font-size:16px;">${esc(t.name)}</h3>
                <span class="badge-tag tag-30d" style="margin-top:4px;">${esc(t.role)}</span>
              </div>
            </div>
            ${activeRole === 'OWNER' ? `
              <button type="button" class="btn btn-danger btn-sm" onclick="App.deleteTrainer('${esc(t.id)}')">
                <svg class="icon-xs"><use href="#ico-trash"></use></svg>
              </button>` : ''}
          </div>
          <div class="muted">${esc(t.shift)} • ${esc(t.phone)}</div>
          <div style="display:flex;justify-content:space-between;padding-top:10px;border-top:1px solid var(--border-subtle);font-size:13px;">
            <span>Assigned Trainees: <strong>${assignedCount}</strong></span>
            ${activeRole === 'OWNER' ? `<span>Salary: <strong>${esc(cur)}${Number(t.salary).toLocaleString()}</strong></span>` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // ==================== 1M / 3M / 6M / 1Y PLANS ====================
  function renderPlans() {
    const cur = state.gym.currency || '₹';
    const grid = document.getElementById('plans-grid');
    grid.innerHTML = ['1M', '3M', '6M', '1Y'].map(code => {
      const p = state.plans[code];
      return `
        <div class="surface-card pad-card" style="display:flex;flex-direction:column;gap:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span class="badge-tag tag-30d">${p.days} Days Cycle</span>
            <svg class="icon-sm text-muted"><use href="#ico-dumbbell"></use></svg>
          </div>
          <h3>${esc(p.label)}</h3>
          <div class="field" style="margin-bottom:4px;">
            <label>Standard Plan Fee (${esc(cur)})</label>
            <input type="number" id="plan-fee-${code}" value="${Number(p.fee)}" />
          </div>
          <button type="button" class="btn btn-primary btn-block" onclick="App.savePlanFee('${code}')">
            <svg class="icon-xs"><use href="#ico-check"></use></svg>
            <span>Update ${code} Fee</span>
          </button>
        </div>
      `;
    }).join('');
  }

  function savePlanFee(code) {
    const newFee = Number(document.getElementById(`plan-fee-${code}`).value || 0);
    state.plans[code].fee = newFee;
    saveStateAsync();
    showToast(`Updated ${state.plans[code].label} fee`);
  }

  // ==================== BACKUP & LOCAL DISK LINK ====================
  async function exportBackup() {
    if (!currentGymMeta) return;
    const encrypted = await CryptoVault.loadEncryptedVault(currentGymMeta.gymId);
    const payload = JSON.stringify({ meta: currentGymMeta, vault: encrypted }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentGymMeta.name.replace(/\s+/g, '_')}.gymvault`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Encrypted vault backup downloaded');
  }

  async function linkLocalFile() {
    if (!window.showSaveFilePicker) {
      return showToast('Use Download Encrypted Vault to save onto your PC or Pendrive.');
    }
    try {
      localFileHandle = await window.showSaveFilePicker({
        suggestedName: `${state.gym.name.replace(/\s+/g, '_')}.gymvault`,
        types: [{ description: 'GymSpace Vault', accept: { 'application/json': ['.gymvault'] } }]
      });
      saveStateAsync();
      document.getElementById('local-file-status').textContent = `Linked to local file: ${localFileHandle.name} (Auto-saving every change)`;
      showToast('Linked directly to computer hard drive');
    } catch {
      // Cancelled
    }
  }

  async function importBackupFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed.meta || !parsed.vault) throw new Error('Invalid file');

      await CryptoVault.saveEncryptedVault(parsed.meta.gymId, parsed.vault);
      const spaces = CryptoVault.getSpacesList();
      if (!spaces.some(s => s.gymId === parsed.meta.gymId)) {
        spaces.push(parsed.meta);
        CryptoVault.saveSpacesList(spaces);
      }
      populateGymSelect();
      document.getElementById('select-gym').value = parsed.meta.gymId;
      switchAuthTab('unlock');
      showToast(`Imported "${parsed.meta.name}" — Enter PIN to unlock`);
    } catch {
      showToast('Invalid or corrupted backup file');
    }
  }

  window.addEventListener('DOMContentLoaded', init);

  return {
    switchAuthTab,
    togglePinVisibility,
    checkPinStrength,
    createGym,
    unlockGym,
    lockGym,
    setRole,
    toggleRoleMobile,
    showView,
    onQuickSearch,
    quickExtend,
    setReminderFilter,
    sendReminder,
    onBackdropClick,
    openMemberModal,
    closeMemberModal,
    updateMemberFormMath,
    updateBalanceMath,
    saveMember,
    deleteMember,
    renderMembers,
    openTrainerModal,
    closeTrainerModal,
    saveTrainer,
    deleteTrainer,
    savePlanFee,
    exportBackup,
    linkLocalFile,
    importBackupFile
  };
})();