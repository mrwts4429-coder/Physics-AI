/* =====================================================
   Physics Assistant Dashboard — front-end logic (dynamic)
   - Chat connected to n8n Chat Trigger webhook
   - File upload connected to n8n File Upload Webhook (FormData)
   - Dynamic stats / recent activity / question bank via localStorage
   - Stop/Abort generation (AbortController)
   - Modals for Question Bank & Settings (no random chat opening)
===================================================== */

/* ---------- 1) CONFIG ---------- */
const CONFIG = {
  // نقطة اتصال محادثة الورك فلو (Chat Trigger في وضع webhook العام).
  webhookUrl: 'https://n8n-agent12.app.n8n.cloud/webhook/932fff71-a56c-4d28-aa41-4fd5d4e011f9/chat',
  // نقطة اتصال رفع الملفات (File Upload Webhook — POST FormData).
  uploadUrl: 'https://n8n-agent12.app.n8n.cloud/webhook/physics-source-upload',
  // نقطة جلب قائمة المصادر الدائمة (List Sources Webhook — POST).
  listUrl: 'https://n8n-agent12.app.n8n.cloud/webhook/physics-source-list',
  // نقطة حذف المصادر (Delete Source Webhook — POST { source_id } أو { all:true }).
  deleteUrl: 'https://n8n-agent12.app.n8n.cloud/webhook/physics-source-delete',
  // المعرّف الافتراضي للمُدرّس (مفتاح الذاكرة). يمكن تغييره من الإعدادات.
  defaultTeacherId: 'teacher-hegazy',
};

/* ---------- 2) STORAGE KEYS + STATE ---------- */
const LS = {
  teacherId: 'physics_teacher_id',
  session: 'physics_session_id',
  stats: 'physics_stats',            // { lessons, questions, saved }
  activity: 'physics_activity',      // [ { title, grade, ts } ]
  bank: 'physics_bank',              // { easy:[], medium:[], advanced:[], genius:[] }
};

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

let STATS = loadJSON(LS.stats, { lessons: 0, questions: 0, saved: 0 });
let ACTIVITY = loadJSON(LS.activity, []);
let BANK = loadJSON(LS.bank, { easy: [], medium: [], advanced: [], genius: [] });

function getTeacherId() {
  let id = localStorage.getItem(LS.teacherId);
  if (!id) { id = CONFIG.defaultTeacherId; localStorage.setItem(LS.teacherId, id); }
  return id;
}
function getSessionId() {
  let sid = localStorage.getItem(LS.session);
  if (!sid) { sid = getTeacherId(); localStorage.setItem(LS.session, sid); }
  return sid;
}
function resetSession() {
  const fresh = getTeacherId() + '-' + Date.now().toString(36);
  localStorage.setItem(LS.session, fresh);
  return fresh;
}
let SESSION_ID = getSessionId();

/* ---------- 3) DOM ---------- */
const el = (id) => document.getElementById(id);
const chatPanel = el('chatPanel');
const chatOverlay = el('chatOverlay');
const chatBody = el('chatBody');
const chatForm = el('chatForm');
const chatInput = el('chatInput');
const chatSend = el('chatSend');
const chatLauncher = el('chatLauncher');
const sessionTag = el('sessionTag');
const chatStatus = el('chatStatus');
const chatFileInput = el('chatFileInput');
const chatAttachBtn = el('chatAttachBtn');
const chatAttachPreview = el('chatAttachPreview');

let chatOpened = false;
let sending = false;
let pendingFile = null;              // File selected but not yet sent
let currentController = null;        // AbortController for the in-flight request

/* ---------- 4) OPEN / CLOSE CHAT ---------- */
function openChat(prefill) {
  chatPanel.classList.add('open');
  chatOverlay.classList.add('open');
  chatPanel.setAttribute('aria-hidden', 'false');
  if (!chatOpened) { chatOpened = true; greet(); }
  if (prefill) { chatInput.value = prefill; autoGrow(); }
  setTimeout(() => chatInput.focus(), 320);
}
function closeChat() {
  chatPanel.classList.remove('open');
  chatOverlay.classList.remove('open');
  chatPanel.setAttribute('aria-hidden', 'true');
}

/* ---------- 5) GREETING ---------- */
function greet() {
  addBot(
    'أهلاً ' + currentTeacherName() + '! 👋\n' +
    'أنا مساعد إعداد دروس الفيزياء. اكتب اسم الدرس والصف وأجهّز لك تحضيرًا متكاملاً.\n\n' +
    'مثال: **قانون نيوتن الأول - الصف الأول الثانوي**\n' +
    'ولو عايز أسئلة جديدة على آخر درس، قول: «اعمل لي أسئلة جديدة للدرس السابق».'
  );
  announceLibraryCount();
}

// يخبر المعلم داخل الشات بعدد الملفات المخزّنة فعليًا في المكتبة الدائمة.
async function announceLibraryCount() {
  try {
    const n = (typeof LIBRARY_COUNT === 'number' && LIBRARY_COUNT >= 0) ? LIBRARY_COUNT : await fetchLibraryCount();
    if (n > 0) {
      addBot('📚 المساعد يعتمد حاليًا على **' + n + '** ملف' + (n === 1 ? '' : 'ات') + ' مخزّنة في مكتبة المصادر الدائمة، وسيستفيد منها في التحضيرات. لإضافة مصادر جديدة استخدم «مكتبة المصادر» في اللوحة الرئيسية.');
    } else {
      addBot('📚 لا توجد حاليًا ملفات في مكتبة المصادر الدائمة. يمكنك رفع ملفات المنهج من قسم «مكتبة المصادر» ليعتمد عليها المساعد.');
    }
  } catch (e) { /* صامت: لا نزعج المعلم إن تعذّر جلب العدد */ }
}
function currentTeacherName() {
  const id = getTeacherId();
  return id === CONFIG.defaultTeacherId ? 'مستر حجازي' : id;
}

/* ---------- 6) MESSAGE RENDERING ---------- */
function nowTime() {
  return new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
}
function scrollDown() { chatBody.scrollTop = chatBody.scrollHeight; }

function addUser(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.innerHTML =
    '<div class="msg-avatar"><i class="fa-solid fa-user"></i></div>' +
    '<div><div class="msg-bubble"></div><span class="msg-time">' + nowTime() + '</span></div>';
  wrap.querySelector('.msg-bubble').textContent = text;
  chatBody.appendChild(wrap);
  scrollDown();
}

function addBot(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML =
    '<div class="msg-avatar"><i class="fa-solid fa-atom"></i></div>' +
    '<div><div class="msg-bubble">' + formatRich(text) + '</div><span class="msg-time">' + nowTime() + '</span></div>';
  chatBody.appendChild(wrap);
  scrollDown();
}

// بطاقة ملف داخل الشات (رسالة المستخدم)
function addFileMessage(file, note) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const noteHtml = note ? '<div class="msg-bubble" style="margin-bottom:8px"></div>' : '';
  wrap.innerHTML =
    '<div class="msg-avatar"><i class="fa-solid fa-user"></i></div>' +
    '<div>' + noteHtml +
    '<div class="file-card">' +
      '<div class="file-icon"><i class="' + fileIcon(file.name) + '"></i></div>' +
      '<div class="file-meta"><div class="file-name"></div><div class="file-size">' + humanSize(file.size) + '</div></div>' +
    '</div>' +
    '<span class="msg-time">' + nowTime() + '</span></div>';
  wrap.querySelector('.file-name').textContent = file.name;
  if (note) wrap.querySelector('.msg-bubble').textContent = note;
  chatBody.appendChild(wrap);
  scrollDown();
}

function addTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg bot typing-row';
  wrap.id = 'typingRow';
  wrap.innerHTML =
    '<div class="msg-avatar"><i class="fa-solid fa-atom"></i></div>' +
    '<div class="msg-bubble"><div class="typing"><span></span><span></span><span></span></div></div>';
  chatBody.appendChild(wrap);
  scrollDown();
}
function removeTyping() { const t = el('typingRow'); if (t) t.remove(); }

// escape + خفيف من Markdown
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function formatRich(raw) {
  let s = escapeHtml(String(raw == null ? '' : raw));
  const lines = s.split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (let line of lines) {
    let t = line.trim();
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (t === '') { closeList(); html += '<div style="height:6px"></div>'; continue; }
    if (/^#{1,6}\s+/.test(t)) { closeList(); html += '<h4>' + t.replace(/^#{1,6}\s+/, '') + '</h4>'; continue; }
    if (/^\d+[\.\)]\s+\S/.test(t) && t.length < 60) { closeList(); html += '<h4>' + t + '</h4>'; continue; }
    if (/^[-–—_]{3,}$/.test(t)) { closeList(); html += '<hr class="sep">'; continue; }
    if (/^[-•]\s+/.test(t)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + t.replace(/^[-•]\s+/, '') + '</li>';
      continue;
    }
    closeList();
    html += '<div>' + t + '</div>';
  }
  closeList();
  return html;
}

/* ---------- 7) SEND STATE / CANCEL BUTTON ---------- */
function setSendingUI(on) {
  sending = on;
  if (on) {
    chatSend.classList.add('is-cancel');
    chatSend.type = 'button';
    chatSend.innerHTML = '<i class="fa-solid fa-stop"></i><span class="cancel-label">إلغاء التوليد</span>';
    chatSend.title = 'إلغاء التوليد';
    chatStatus.innerHTML = '<span class="chat-online-dot" style="background:#f59e0b"></span> يعمل الآن...';
  } else {
    chatSend.classList.remove('is-cancel');
    chatSend.type = 'submit';
    chatSend.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    chatSend.title = 'إرسال';
    chatStatus.innerHTML = '<span class="chat-online-dot"></span> متصل الآن';
  }
}
function cancelGeneration() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

/* ---------- 8) SEND MESSAGE TO WORKFLOW ---------- */
async function sendMessage(text) {
  if (sending) return;
  // لو فيه ملف مرفق، نرفعه أولًا
  if (pendingFile) { await uploadPendingFile(text); return; }
  if (!text) return;

  setSendingUI(true);
  addUser(text);
  chatInput.value = '';
  autoGrow();
  addTyping();

  currentController = new AbortController();
  try {
    const res = await fetch(CONFIG.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sendMessage', sessionId: SESSION_ID, chatInput: text }),
      signal: currentController.signal,
    });
    removeTyping();
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const reply = await parseReply(res);
    addBot(reply);
    // تحديث اللوحة عند نجاح تحضير/توليد
    handleAssistantReply(text, reply);
  } catch (err) {
    removeTyping();
    if (err && err.name === 'AbortError') {
      addBot('🛑 تم إلغاء الطلب. يمكنك إعادة المحاولة في أي وقت.');
      showToast('تم إلغاء التوليد', 'info');
    } else {
      addBot(
        '⚠️ تعذّر الاتصال بالمساعد حاليًا.\n' +
        'تأكدي أن الورك فلو مُفعّل (Active) في n8n، ثم أعيدي المحاولة.\n\n' +
        'تفاصيل: ' + (err && err.message ? err.message : 'خطأ غير معروف')
      );
    }
  } finally {
    currentController = null;
    setSendingUI(false);
    chatInput.focus();
  }
}

async function parseReply(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) { return pickText(await res.json()); }
  const txt = await res.text();
  try { return pickText(JSON.parse(txt)); } catch (e) { return txt || 'لم يصل رد.'; }
}
function pickText(data) {
  if (data == null) return 'لم يصل رد.';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return pickText(data[0]);
  return (
    data.output || data.text || data.reply || data.message || data.answer ||
    (typeof data.json === 'object' ? pickText(data.json) : null) ||
    'لم يصل رد نصي واضح من المساعد.'
  );
}

/* ---------- 9) FILE UPLOAD (FormData) ---------- */
function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'fa-solid fa-file-pdf';
  if (ext === 'doc' || ext === 'docx') return 'fa-solid fa-file-word';
  if (ext === 'ppt' || ext === 'pptx') return 'fa-solid fa-file-powerpoint';
  if (['png','jpg','jpeg','gif','webp','bmp'].indexOf(ext) !== -1) return 'fa-solid fa-file-image';
  return 'fa-solid fa-file';
}
function humanSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function setPendingFile(file) {
  pendingFile = file;
  chatAttachBtn.classList.toggle('has-file', !!file);
  renderAttachPreview();
}
function renderAttachPreview() {
  if (!pendingFile) { chatAttachPreview.hidden = true; chatAttachPreview.innerHTML = ''; return; }
  chatAttachPreview.hidden = false;
  chatAttachPreview.innerHTML =
    '<div class="file-card">' +
      '<div class="file-icon"><i class="' + fileIcon(pendingFile.name) + '"></i></div>' +
      '<div class="file-meta"><div class="file-name"></div><div class="file-size">' + humanSize(pendingFile.size) + ' • جاهز للإرسال</div></div>' +
      '<button type="button" class="file-remove" id="fileRemoveBtn" title="إزالة"><i class="fa-solid fa-xmark"></i></button>' +
    '</div>';
  chatAttachPreview.querySelector('.file-name').textContent = pendingFile.name;
  el('fileRemoveBtn').addEventListener('click', () => { setPendingFile(null); chatFileInput.value = ''; });
}

async function uploadPendingFile(note) {
  const file = pendingFile;
  if (!file) return;

  // اعرض بطاقة الملف كرسالة + شريط تقدم
  addFileMessage(file, note);
  setPendingFile(null);
  chatFileInput.value = '';
  chatInput.value = '';
  autoGrow();

  const progWrap = document.createElement('div');
  progWrap.className = 'msg bot';
  progWrap.id = 'uploadProgRow';
  progWrap.innerHTML =
    '<div class="msg-avatar"><i class="fa-solid fa-cloud-arrow-up"></i></div>' +
    '<div><div class="msg-bubble">جارٍ رفع الملف...' +
    '<div class="file-progress"><div class="bar" id="uploadBar"></div></div></div></div>';
  chatBody.appendChild(progWrap);
  scrollDown();

  setSendingUI(true);
  currentController = new AbortController();

  const form = new FormData();
  form.append('file', file, file.name);
  form.append('sessionId', SESSION_ID);
  form.append('teacher_id', getTeacherId());
  form.append('subject', 'Physics');
  form.append('grade', 'unknown');
  form.append('topics', note || '');
  if (note) form.append('note', note);

  try {
    // XHR لإظهار تقدم الرفع الحقيقي، مع دعم الإلغاء عبر AbortController
    const result = await xhrUpload(CONFIG.uploadUrl, form, currentController.signal, (pct) => {
      const bar = el('uploadBar'); if (bar) bar.style.width = pct + '%';
    });
    const row = el('uploadProgRow'); if (row) row.remove();
    const msg = describeUploadResult(result);
    addBot(msg.text);
    showToast(msg.toast, msg.ok ? 'success' : 'error');
  } catch (err) {
    const row = el('uploadProgRow'); if (row) row.remove();
    if (err && err.name === 'AbortError') {
      addBot('🛑 تم إلغاء رفع الملف.');
      showToast('تم إلغاء الرفع', 'info');
    } else {
      addBot('⚠️ تعذّر رفع الملف. تفاصيل: ' + (err && err.message ? err.message : 'خطأ غير معروف'));
      showToast('فشل رفع الملف', 'error');
    }
  } finally {
    currentController = null;
    setSendingUI(false);
    chatInput.focus();
  }
}

// XHR upload wrapper مع تقدم + إلغاء
function xhrUpload(url, formData, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let data = xhr.responseText;
        try { data = JSON.parse(xhr.responseText); } catch (e) {}
        resolve(data);
      } else {
        reject(new Error('HTTP ' + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    if (signal) {
      if (signal.aborted) { xhr.abort(); const e = new Error('Aborted'); e.name = 'AbortError'; return reject(e); }
      signal.addEventListener('abort', () => {
        xhr.abort();
        const e = new Error('Aborted'); e.name = 'AbortError'; reject(e);
      });
    }
    xhr.send(formData);
  });
}

function describeUploadResult(data) {
  const obj = (data && typeof data === 'object') ? (Array.isArray(data) ? data[0] : data) : {};
  const status = (obj && (obj.status || (obj.json && obj.json.status))) || '';
  const name = (obj && (obj.source_name || obj.file_name || (obj.json && obj.json.source_name))) || 'الملف';
  const message = (obj && (obj.message || (obj.json && obj.json.message))) || '';
  switch (status) {
    case 'UPLOADED_SUCCESSFULLY':
      return { ok: true, toast: 'تم رفع الملف بنجاح', text: '✅ تم رفع «' + name + '» وتسجيله في مصادر المساعد بنجاح. يمكنك الآن طلب تحضير درس وسيستفيد المساعد من هذا الملف.' };
    case 'ALREADY_EXISTS':
      return { ok: true, toast: 'الملف مسجّل مسبقًا', text: 'ℹ️ «' + name + '» مسجّل بالفعل في مصادر المساعد؛ لا حاجة لإعادة رفعه.' };
    case 'UNSUPPORTED_FILE_TYPE':
      return { ok: false, toast: 'نوع ملف غير مدعوم', text: '⚠️ ' + (message || 'نوع الملف غير مدعوم. الأنواع المدعومة: PDF نصي، DOCX، PPTX.') };
    case 'INVALID_FILE':
      return { ok: false, toast: 'ملف غير صالح', text: '⚠️ ' + (message || 'الملف غير صالح.') };
    case 'UPLOAD_FAILED':
    case 'REGISTRY_FAILED':
      return { ok: false, toast: 'فشل الرفع', text: '⚠️ ' + (message || 'تعذّر إكمال رفع الملف. أعد المحاولة.') };
    default:
      return { ok: true, toast: 'تم استلام الملف', text: '✅ تم إرسال «' + name + '» إلى المساعد.' + (message ? '\n' + message : '') };
  }
}

/* ---------- 10) DYNAMIC STATS / ACTIVITY / BANK ---------- */
function renderStats() {
  el('statLessons').textContent = STATS.lessons;
  el('statQuestions').textContent = STATS.questions;
  el('statSaved').textContent = STATS.saved;
  el('statLessonsNote').textContent = STATS.lessons > 0
    ? ('آخر تحديث ' + relTime(latestActivityTs()))
    : 'لم تُحضّر دروس بعد';
}
function latestActivityTs() { return ACTIVITY.length ? ACTIVITY[0].ts : Date.now(); }

function relTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'الآن';
  if (m < 60) return 'منذ ' + m + ' دقيقة';
  const h = Math.floor(m / 60);
  if (h < 24) return 'منذ ' + h + (h === 1 ? ' ساعة' : (h === 2 ? ' ساعتين' : ' ساعات'));
  const d = Math.floor(h / 24);
  if (d < 30) return 'منذ ' + d + (d === 1 ? ' يوم' : ' أيام');
  const mo = Math.floor(d / 30);
  return 'منذ ' + mo + (mo === 1 ? ' شهر' : ' أشهر');
}

const activityIcons = ['fa-atom', 'fa-wave-square', 'fa-lightbulb', 'fa-bolt', 'fa-magnet'];
const activityColors = ['blue-bg', 'purple-bg', 'green-bg'];

function renderActivity() {
  const list = el('activityList');
  if (!ACTIVITY.length) {
    list.innerHTML = '<div class="empty-state"><i class="fa-regular fa-folder-open"></i>' +
      '<p>لا توجد تحضيرات بعد.<br>ابدأ بتحضير أول درس وسيظهر هنا تلقائيًا.</p></div>';
    return;
  }
  list.innerHTML = ACTIVITY.slice(0, 6).map((a, i) => {
    return '<div class="activity-item">' +
      '<div class="activity-icon ' + activityColors[i % activityColors.length] + '">' +
        '<i class="fa-solid ' + activityIcons[i % activityIcons.length] + '"></i></div>' +
      '<div class="activity-content"><strong></strong><span>' +
        escapeHtml(gradeLabel(a.grade)) + ' • ' + relTime(a.ts) + '</span></div>' +
      '<span class="badge completed">مكتمل</span></div>';
  }).join('');
  // set titles safely
  const items = list.querySelectorAll('.activity-content strong');
  ACTIVITY.slice(0, 6).forEach((a, i) => { if (items[i]) items[i].textContent = a.title; });
}

function gradeLabel(g) {
  if (g === 'g1') return 'الصف الأول الثانوي';
  if (g === 'g2') return 'الصف الثاني الثانوي';
  if (g === 'g3') return 'الصف الثالث الثانوي';
  return g || 'الثانوية';
}

// حفظ تحضير جديد في اللوحة
function recordLesson(title, grade, questions) {
  STATS.lessons += 1;
  STATS.saved += 1;
  STATS.questions += (questions && questions.length) || 0;
  saveJSON(LS.stats, STATS);

  ACTIVITY.unshift({ title: title || 'درس فيزياء', grade: grade || 'unknown', ts: Date.now() });
  ACTIVITY = ACTIVITY.slice(0, 30);
  saveJSON(LS.activity, ACTIVITY);

  if (questions && questions.length) {
    questions.forEach((q) => { if (BANK[q.level]) BANK[q.level].push(q); });
    // keep bank bounded
    ['easy','medium','advanced','genius'].forEach((k) => { BANK[k] = BANK[k].slice(-60); });
    saveJSON(LS.bank, BANK);
  }
  renderStats();
  renderActivity();
}

/* ---------- 11) PARSE ASSISTANT REPLY (topic/grade/questions) ---------- */
// نحاول استخراج عنوان الدرس/الصف وعدد الأسئلة من رسالة المعلم + رد المساعد،
// لتحديث الإحصائيات وبنك الأسئلة تلقائيًا. هذا استدلال تقريبي على العميل.
function handleAssistantReply(userText, reply) {
  const r = String(reply || '');
  // اعتبره "درسًا كاملًا" إذا احتوى الرد على بنية الأقسام
  const isFullLesson = /تحليل الدرس/.test(r) && /بنك أسئلة/.test(r);
  const isFollowUp = /سؤال|أسئلة/.test(r) && !isFullLesson;

  const questions = extractQuestions(r);

  if (isFullLesson) {
    const title = extractTopic(userText) || 'درس فيزياء';
    const grade = detectGrade(userText);
    recordLesson(title, grade, questions);
    showToast('تم تحضير الدرس وإضافته للوحة', 'success');
  } else if (isFollowUp && questions.length) {
    // متابعة: أضف الأسئلة للبنك وزد العداد دون عدّ درس جديد
    STATS.questions += questions.length;
    saveJSON(LS.stats, STATS);
    questions.forEach((q) => { if (BANK[q.level]) BANK[q.level].push(q); });
    ['easy','medium','advanced','genius'].forEach((k) => { BANK[k] = BANK[k].slice(-60); });
    saveJSON(LS.bank, BANK);
    renderStats();
    showToast('تمت إضافة ' + questions.length + ' سؤال لبنك الأسئلة', 'success');
  }
}

function extractTopic(text) {
  let t = String(text || '');
  const m = t.match(/^\s*\[sid:[^\]]*\]\s*/); if (m) t = t.slice(m[0].length);
  // خذ ما قبل شرطة الفصل بين الموضوع والصف
  let topic = t.split(/[-–—]/)[0];
  topic = topic.replace(/(لل|ل)?\s*صف\s+(ال)?(أول|اول|ثاني|ثانى|ثالث)\s*(الثانوي|الثانوية)?/g, ' ')
               .replace(/(الصف|الثانوي|الثانوية)/g, ' ')
               .replace(/\b(اعمل|اعملي|حضر|جهز|اكتب|من فضلك|لي|درس)\b/g, ' ')
               .replace(/\s+/g, ' ').trim();
  return topic.length > 2 ? topic.slice(0, 60) : '';
}
function detectGrade(text) {
  const t = String(text || '');
  if (/(أول|اول|اولى|أولى)\s*(ثانوي|الثانوي)|صف\s*(ال)?(أول|اول)/.test(t)) return 'g1';
  if (/(ثاني|ثانى|الثاني)\s*(ثانوي|الثانوي)|صف\s*(ال)?(ثاني|ثانى)/.test(t)) return 'g2';
  if (/(ثالث|الثالث)\s*(ثانوي|الثانوي)|صف\s*(ال)?(ثالث)/.test(t)) return 'g3';
  return 'unknown';
}

// استخراج تقريبي للأسئلة مع تصنيف الصعوبة من نص الرد
function extractQuestions(reply) {
  const out = [];
  const lines = String(reply || '').split('\n');
  let currentLevel = 'medium';
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // كشف مستوى الصعوبة من العنوان/الوسم
    if (/عبقري/.test(line)) currentLevel = 'genius';
    else if (/متقدم|صعب/.test(line)) currentLevel = 'advanced';
    else if (/متوسط/.test(line)) currentLevel = 'medium';
    else if (/سهل/.test(line)) currentLevel = 'easy';

    // سطر سؤال مرقّم
    const qm = line.match(/^(?:\d+[\.\)]|[-•])\s+(.{8,})/);
    if (qm) {
      const level = detectLineLevel(line) || currentLevel;
      out.push({ text: qm[1].replace(/\*\*/g, '').slice(0, 400), level: level, ts: Date.now() });
    }
  }
  return out.slice(0, 40);
}
function detectLineLevel(line) {
  if (/عبقري/.test(line)) return 'genius';
  if (/متقدم|صعب/.test(line)) return 'advanced';
  if (/متوسط/.test(line)) return 'medium';
  if (/سهل/.test(line)) return 'easy';
  return '';
}

/* ---------- 12) MODALS ---------- */
function openModal(id) { const m = el(id); if (m) m.classList.add('open'); m.setAttribute('aria-hidden', 'false'); }
function closeModal(id) { const m = el(id); if (m) { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); } }

// bank
let bankLevel = 'easy';
function openBank() {
  bankLevel = 'easy';
  document.querySelectorAll('#bankTabs .modal-tab').forEach((t) => t.classList.toggle('active', t.dataset.level === 'easy'));
  renderBank();
  openModal('bankModal');
}
function renderBank() {
  const body = el('bankBody');
  const list = BANK[bankLevel] || [];
  if (!list.length) {
    body.innerHTML = '<div class="empty-state"><i class="fa-regular fa-circle-question"></i>' +
      '<p>لا توجد أسئلة محفوظة بهذا المستوى بعد.<br>حضّر درسًا أو اطلب أسئلة جديدة وستُضاف هنا تلقائيًا.</p></div>';
    return;
  }
  body.innerHTML = list.slice().reverse().map((q) => {
    return '<div class="q-card"><div class="q-text"></div>' +
      '<div class="q-meta"><span class="q-tag">' + levelLabel(q.level) + '</span>' +
      '<span>' + relTime(q.ts) + '</span></div></div>';
  }).join('');
  const nodes = body.querySelectorAll('.q-text');
  list.slice().reverse().forEach((q, i) => { if (nodes[i]) nodes[i].textContent = q.text; });
}
function levelLabel(l) {
  return { easy: 'سهل', medium: 'متوسط', advanced: 'متقدم', genius: 'عبقري' }[l] || l;
}

// lessons / memory
function openLessons() {
  const body = el('lessonsBody');
  if (!ACTIVITY.length) {
    body.innerHTML = '<div class="empty-state"><i class="fa-regular fa-folder-open"></i>' +
      '<p>لا توجد دروس محفوظة بعد.<br>حضّر أول درس وسيظهر هنا.</p></div>';
  } else {
    body.innerHTML = ACTIVITY.map((a) => {
      return '<div class="lesson-card"><div class="lesson-top"><div>' +
        '<strong></strong><div class="lesson-sub">' + escapeHtml(gradeLabel(a.grade)) + ' • ' + relTime(a.ts) + '</div>' +
        '</div><button class="lesson-open" data-followup="1">أسئلة جديدة</button></div></div>';
    }).join('');
    const strongs = body.querySelectorAll('.lesson-card strong');
    ACTIVITY.forEach((a, i) => { if (strongs[i]) strongs[i].textContent = a.title; });
    // زر «أسئلة جديدة» يفتح الشات ويطلب متابعة على الدرس السابق
    body.querySelectorAll('[data-followup]').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        closeModal('lessonsModal');
        openChat();
        sendMessage('اعمل لي خمسة أسئلة جديدة من الدرس السابق');
      });
    });
  }
  openModal('lessonsModal');
}

// settings
function openSettings() {
  el('teacherIdInput').value = getTeacherId();
  openModal('settingsModal');
}
function saveSettings() {
  const val = el('teacherIdInput').value.trim();
  if (!val) { showToast('أدخل معرّفًا صالحًا', 'error'); return; }
  localStorage.setItem(LS.teacherId, val);
  SESSION_ID = resetSession();               // مفتاح ذاكرة جديد لهذا المُدرّس
  applyTeacherName();
  closeModal('settingsModal');
  showToast('تم حفظ الإعدادات', 'success');
}
function clearHistory() {
  if (!confirm('سيتم مسح الإحصائيات وبنك الأسئلة وقائمة الأنشطة من هذا المتصفح. متابعة؟')) return;
  STATS = { lessons: 0, questions: 0, saved: 0 };
  ACTIVITY = [];
  BANK = { easy: [], medium: [], advanced: [], genius: [] };
  saveJSON(LS.stats, STATS);
  saveJSON(LS.activity, ACTIVITY);
  saveJSON(LS.bank, BANK);
  SESSION_ID = resetSession();
  renderStats();
  renderActivity();
  closeModal('settingsModal');
  showToast('تم مسح السجل المحلي', 'info');
}

function applyTeacherName() {
  const name = currentTeacherName();
  ['teacherNameSide', 'teacherNameTop', 'teacherNameProfile'].forEach((id) => {
    const node = el(id); if (node) node.textContent = name;
  });
}

/* ---------- 13) TOASTS ---------- */
function showToast(text, type) {
  const c = el('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info');
  const icon = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
  t.innerHTML = '<i class="fa-solid ' + icon + '"></i><span></span>';
  t.querySelector('span').textContent = text;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-20px)'; setTimeout(() => t.remove(), 300); }, 3200);
}

/* ---------- 14) INPUT HELPERS ---------- */
function autoGrow() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
}

/* ---------- 15) EVENTS ---------- */
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (sending) return;
  sendMessage(chatInput.value.trim());
});
// زر الإرسال/الإلغاء (يتحول لـ button أثناء العمل)
chatSend.addEventListener('click', (e) => {
  if (sending) { e.preventDefault(); cancelGeneration(); }
});
chatInput.addEventListener('input', autoGrow);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sending) sendMessage(chatInput.value.trim());
  }
});

// إرفاق ملف
chatAttachBtn.addEventListener('click', () => chatFileInput.click());
chatFileInput.addEventListener('change', () => {
  const f = chatFileInput.files && chatFileInput.files[0];
  if (f) setPendingFile(f);
});

chatLauncher.addEventListener('click', () => openChat());
el('chatClose').addEventListener('click', closeChat);
chatOverlay.addEventListener('click', closeChat);
el('chatNewSession').addEventListener('click', () => {
  SESSION_ID = resetSession();
  chatBody.innerHTML = '';
  chatOpened = true;
  greet();
  addBot('✅ بدأنا محادثة جديدة. (الذاكرة السابقة لن تُستخدم في هذه المحادثة).');
});

// شرائح الاقتراحات
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => { openChat(); sendMessage(chip.dataset.prompt); });
});

// أزرار فتح الشات المباشر (تحضير درس / أسئلة عليا فقط)
const intentPrompts = {
  new: '',
  genius: 'اعمل لي أسئلة تفكير عليا (مستوى عبقري) للدرس السابق.',
};
document.querySelectorAll('[data-action="open-chat"]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const intent = btn.dataset.intent;
    if (intent === 'genius') { openChat(); sendMessage(intentPrompts.genius); }
    else { openChat(); } // تحضير درس جديد يفتح الشات فقط بدون إرسال
  });
});

// أزرار بنك الأسئلة (Modal — لا يفتح الشات)
document.querySelectorAll('[data-action="open-bank"]').forEach((btn) => {
  btn.addEventListener('click', (e) => { e.preventDefault(); openBank(); });
});
// أزرار الدروس المحفوظة / الذاكرة (Modal)
document.querySelectorAll('[data-action="open-lessons"]').forEach((btn) => {
  btn.addEventListener('click', (e) => { e.preventDefault(); openLessons(); });
});
// أزرار الإعدادات (Modal)
document.querySelectorAll('[data-action="open-settings"]').forEach((btn) => {
  btn.addEventListener('click', (e) => { e.preventDefault(); openSettings(); });
});

// تبويبات بنك الأسئلة
document.querySelectorAll('#bankTabs .modal-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    bankLevel = tab.dataset.level;
    document.querySelectorAll('#bankTabs .modal-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    renderBank();
  });
});

// إغلاق المودالات (زر الإغلاق + النقر على الخلفية)
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
document.querySelectorAll('.modal-overlay').forEach((ov) => {
  ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(ov.id); });
});

// أزرار الإعدادات
el('saveSettingsBtn').addEventListener('click', saveSettings);
el('clearHistoryBtn').addEventListener('click', clearHistory);

// خانة البحث العلوية = تحضير سريع
const quickAsk = el('quickAsk');
if (quickAsk) {
  quickAsk.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && quickAsk.value.trim()) {
      const q = quickAsk.value.trim();
      quickAsk.value = '';
      openChat();
      sendMessage(q);
    }
  });
}

// ✅ الكود النهائي المحسن للتحكم بالقائمة الجانبية وزر الإغلاق X:
const menuToggle = el('menuToggle');
const sidebar = document.querySelector('.sidebar');
const sidebarCloseBtn = el('sidebarCloseBtn');

// 1. وظيفة إغلاق القائمة
function closeSidebar() {
  if (sidebar) {
    sidebar.classList.remove('open');
    sidebar.classList.remove('active');
  }
}

// 2. زر فتح/إغلاق القائمة (زر القائمة الرئيسي في الهيدر)
if (menuToggle && sidebar) {
  menuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('open');
  });
}

// 3. ربط زر الإغلاق المباشر (علامة X) داخل القائمة الجانبية
if (sidebarCloseBtn) {
  sidebarCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSidebar();
  });
}

// 4. إغلاق القائمة فوراً عند الضغط على أي رابط/زر داخلها (مع استثناء زر الإغلاق X)
document.querySelectorAll('.sidebar .nav-link, .sidebar button, .sidebar a').forEach((link) => {
  link.addEventListener('click', function () {
    if (this.id === 'sidebarCloseBtn') return; // لا نغير الكلاس النشط عند ضغط زر X
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    this.classList.add('active');
    closeSidebar();
  });
});

// 5. إغلاق القائمة تلقائياً عند الضغط خارجها
document.addEventListener('click', (e) => {
  if (sidebar && sidebar.classList.contains('open')) {
    if (!sidebar.contains(e.target) && e.target !== menuToggle && !menuToggle.contains(e.target)) {
      closeSidebar();
    }
  }
});
/* ---------- 17) SOURCE LIBRARY (STANDALONE DASHBOARD SECTION) ---------- */
let LIBRARY_COUNT = -1;              // آخر عدد معروف للمصادر (للإعلان داخل الشات)
let libBusy = false;

const dropzone = el('dropzone');
const libFileInput = el('libFileInput');
const libraryList = el('libraryList');
const bulkProgress = el('bulkProgress');
const bulkBarFill = el('bulkBarFill');
const bulkProgressCount = el('bulkProgressCount');
const bulkProgressLabel = el('bulkProgressLabel');
const bulkFileList = el('bulkFileList');
const libRefreshBtn = el('libRefreshBtn');
const libDeleteAllBtn = el('libDeleteAllBtn');

function gradeShort(g) {
  if (g === 'g1') return 'أولى ثانوي';
  if (g === 'g2') return 'ثانية ثانوي';
  if (g === 'g3') return 'ثالثة ثانوي';
  return '';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }); }
  catch (e) { return d.toISOString().slice(0, 10); }
}

// جلب عدد المصادر فقط (يحدّث LIBRARY_COUNT)
async function fetchLibraryCount() {
  const res = await fetch(CONFIG.listUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const obj = Array.isArray(data) ? data[0] : data;
  const list = (obj && (obj.sources || (obj.json && obj.json.sources))) || [];
  LIBRARY_COUNT = list.length;
  return LIBRARY_COUNT;
}

// تحميل + رسم قائمة المصادر الدائمة
async function loadLibrary() {
  if (!libraryList) return;
  libraryList.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>جارٍ تحميل قائمة المصادر...</p></div>';
  try {
    const res = await fetch(CONFIG.listUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const obj = Array.isArray(data) ? data[0] : data;
    const sources = (obj && (obj.sources || (obj.json && obj.json.sources))) || [];
    LIBRARY_COUNT = sources.length;
    renderLibrary(sources);
  } catch (err) {
    libraryList.innerHTML = '<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i>' +
      '<p>تعذّر تحميل المصادر.<br>تأكد أن الورك فلو مُفعّل (Active) ثم اضغط تحديث.</p></div>';
  }
}

function renderLibrary(sources) {
  if (!sources.length) {
    libraryList.innerHTML = '<div class="empty-state"><i class="fa-regular fa-folder-open"></i>' +
      '<p>لا توجد مصادر مخزّنة بعد.<br>ارفع ملفات المنهج من منطقة الرفع أعلاه وستظهر هنا.</p></div>';
    return;
  }
  libraryList.innerHTML = sources.map((s) => {
    const ext = (s.source_name || '').split('.').pop().toLowerCase();
    const iconCls = ext === 'pdf' ? 'pdf' : (ext === 'docx' || ext === 'doc' ? 'docx' : (ext === 'pptx' || ext === 'ppt' ? 'pptx' : ''));
    const partial = s.source_access === 'PARTIALLY_ACCESSIBLE';
    const badge = partial
      ? '<span class="s-badge partial"><i class="fa-solid fa-circle-check"></i> مخزّن دائمًا (نص غير مستخرج)</span>'
      : '<span class="s-badge active"><i class="fa-solid fa-circle-check"></i> مُفعّل ومخزّن دائمًا</span>';
    const subParts = [];
    if (s.file_size) subParts.push(escapeHtml(s.file_size));
    if (gradeShort(s.grade)) subParts.push(escapeHtml(gradeShort(s.grade)));
    if (s.topics) subParts.push(escapeHtml(s.topics));
    if (fmtDate(s.upload_date)) subParts.push('<i class="fa-regular fa-calendar"></i> ' + escapeHtml(fmtDate(s.upload_date)));
    return '<div class="source-card" data-sid="' + escapeHtml(s.source_id) + '">' +
      '<div class="source-file-icon ' + iconCls + '"><i class="' + fileIcon(s.source_name || '') + '"></i></div>' +
      '<div class="source-meta"><div class="s-name"></div>' +
        '<div class="s-sub">' + subParts.join('<span>•</span>') + '</div></div>' +
      '<div class="source-badges">' + badge +
        '<button class="s-delete" title="حذف المصدر" data-del="' + escapeHtml(s.source_id) + '"><i class="fa-solid fa-trash-can"></i></button>' +
      '</div></div>';
  }).join('');
  // set names safely (avoid HTML injection from file names)
  const nameNodes = libraryList.querySelectorAll('.s-name');
  sources.forEach((s, i) => { if (nameNodes[i]) nameNodes[i].textContent = s.source_name || 'ملف بدون اسم'; });
  // wire delete buttons
  libraryList.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteSource(btn.getAttribute('data-del')));
  });
}

// ===== Bulk upload: كل ملف في طلب مستقل =====
async function bulkUpload(files) {
  if (libBusy) return;
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  libBusy = true;

  bulkProgress.hidden = false;
  bulkBarFill.style.width = '0%';
  bulkProgressCount.textContent = '0 / ' + list.length;
  bulkProgressLabel.textContent = 'جارٍ رفع ' + list.length + ' ملف...';
  bulkFileList.innerHTML = list.map((f, i) =>
    '<div class="bulk-file-row" id="bfrow' + i + '"><i class="' + fileIcon(f.name) + '"></i>' +
    '<span class="bf-name"></span><span class="bf-state pending" id="bfst' + i + '">في الانتظار</span></div>'
  ).join('');
  list.forEach((f, i) => { const n = document.querySelector('#bfrow' + i + ' .bf-name'); if (n) n.textContent = f.name; });

  let done = 0, ok = 0, exists = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const stEl = el('bfst' + i);
    if (stEl) { stEl.className = 'bf-state uploading'; stEl.textContent = 'جارٍ الرفع...'; }
    try {
      const result = await uploadOneToLibrary(list[i]);
      const status = (result && (result.status || (result.json && result.json.status))) || '';
      if (status === 'UPLOADED_SUCCESSFULLY') { ok++; if (stEl) { stEl.className = 'bf-state done'; stEl.textContent = 'تم الحفظ'; } }
      else if (status === 'ALREADY_EXISTS') { exists++; if (stEl) { stEl.className = 'bf-state exists'; stEl.textContent = 'موجود مسبقًا'; } }
      else { failed++; if (stEl) { stEl.className = 'bf-state failed'; stEl.textContent = 'فشل'; } }
    } catch (err) {
      failed++; if (stEl) { stEl.className = 'bf-state failed'; stEl.textContent = 'فشل'; }
    }
    done++;
    bulkBarFill.style.width = Math.round((done / list.length) * 100) + '%';
    bulkProgressCount.textContent = done + ' / ' + list.length;
  }

  bulkProgressLabel.textContent = 'اكتمل الرفع';
  const summary = '✅ ' + ok + ' جديد' + (exists ? '، ℹ️ ' + exists + ' موجود مسبقًا' : '') + (failed ? '، ⚠️ ' + failed + ' فشل' : '');
  showToast(summary, failed ? 'error' : 'success');
  libBusy = false;
  libFileInput.value = '';
  await loadLibrary();
  setTimeout(() => { bulkProgress.hidden = true; }, 4000);
}

// رفع ملف واحد للمكتبة (FormData → File Upload Webhook)
function uploadOneToLibrary(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('teacher_id', getTeacherId());
  form.append('subject', 'Physics');
  form.append('grade', 'unknown');
  form.append('topics', '');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', CONFIG.uploadUrl, true);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let data = xhr.responseText; try { data = JSON.parse(xhr.responseText); } catch (e) {}
        resolve(data);
      } else { reject(new Error('HTTP ' + xhr.status)); }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(form);
  });
}

// حذف مصدر واحد
async function deleteSource(sourceId) {
  if (!sourceId) return;
  if (!confirm('سيتم حذف هذا المصدر نهائيًا من المكتبة الدائمة. متابعة؟')) return;
  try {
    const res = await fetch(CONFIG.deleteUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: sourceId }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const obj = Array.isArray(data) ? data[0] : data;
    const status = (obj && (obj.status || (obj.json && obj.json.status))) || '';
    if (status === 'DELETED') { showToast('تم حذف المصدر', 'success'); }
    else { showToast('تعذّر الحذف', 'error'); }
  } catch (err) {
    showToast('تعذّر الاتصال للحذف', 'error');
  }
  await loadLibrary();
}

// حذف جميع المصادر
async function deleteAllSources() {
  if (!confirm('سيتم حذف جميع المصادر من المكتبة الدائمة نهائيًا. لا يمكن التراجع. متابعة؟')) return;
  try {
    const res = await fetch(CONFIG.deleteUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const obj = Array.isArray(data) ? data[0] : data;
    const status = (obj && (obj.status || (obj.json && obj.json.status))) || '';
    if (status === 'DELETED_ALL') { showToast('تم حذف جميع المصادر', 'success'); }
    else { showToast('تعذّر حذف الكل', 'error'); }
  } catch (err) {
    showToast('تعذّر الاتصال للحذف', 'error');
  }
  await loadLibrary();
}

// ===== Library events =====
if (dropzone) {
  dropzone.addEventListener('click', () => libFileInput.click());
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); libFileInput.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => { const files = e.dataTransfer && e.dataTransfer.files; if (files && files.length) bulkUpload(files); });
}
if (libFileInput) libFileInput.addEventListener('change', () => { if (libFileInput.files && libFileInput.files.length) bulkUpload(libFileInput.files); });
if (libRefreshBtn) libRefreshBtn.addEventListener('click', loadLibrary);
if (libDeleteAllBtn) libDeleteAllBtn.addEventListener('click', deleteAllSources);

// رابط القائمة الجانبية «مكتبة المصادر» → تمرير للقسم
document.querySelectorAll('[data-action="scroll-library"]').forEach((btn) => {
  btn.addEventListener('click', (e) => { e.preventDefault(); const p = el('libraryPanel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
});

/* ---------- 16) INIT ---------- */
applyTeacherName();
renderStats();
renderActivity();
loadLibrary();
