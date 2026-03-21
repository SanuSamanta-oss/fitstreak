// ==============================
// FitStreak - Main App JS
// ==============================

const API = "/api";

// ---- STATE ----
let state = {
  token: localStorage.getItem("fs_token"),
  user: null,
  todayLog: { exercises: [], distractions: [], notes: "" },
  logs: [],
  rewards: [],
  saveTimeout: null,
};

// ---- API HELPER ----
async function api(path, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---- AUTH ----
async function doRegister() {
  const username = document.getElementById("reg-username").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const password = document.getElementById("reg-password").value;
  const err = document.getElementById("reg-error");
  err.textContent = "";
  if (!username || !email || !password) { err.textContent = "All fields required"; return; }
  if (password.length < 6) { err.textContent = "Password must be at least 6 characters"; return; }
  try {
    const data = await api("/register", "POST", { username, email, password });
    state.token = data.token;
    localStorage.setItem("fs_token", data.token);
    await loadApp();
  } catch (e) {
    err.textContent = e.message;
  }
}

async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const err = document.getElementById("login-error");
  err.textContent = "";
  if (!email || !password) { err.textContent = "All fields required"; return; }
  try {
    const data = await api("/login", "POST", { email, password });
    state.token = data.token;
    localStorage.setItem("fs_token", data.token);
    await loadApp();
  } catch (e) {
    err.textContent = e.message;
  }
}

function doLogout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("fs_token");
  showPage("login");
}

// ---- LOAD APP ----
async function loadApp() {
  try {
    state.user = await api("/me");
    state.logs = await api("/logs");
    state.rewards = await api("/rewards");
    const todayRaw = await api("/logs/today");
    state.todayLog = {
      exercises: JSON.parse(todayRaw.exercises || "[]"),
      distractions: JSON.parse(todayRaw.distractions || "[]"),
      notes: todayRaw.notes || "",
    };
    renderDashboard();
    showPage("dashboard");
  } catch (e) {
    doLogout();
  }
}

// ---- RENDER DASHBOARD ----
function renderDashboard() {
  const u = state.user;
  document.getElementById("topbar-coins").textContent = u.coins.toLocaleString();
  document.getElementById("topbar-username").textContent = u.username;
  document.getElementById("avatar-letter").textContent = u.username[0].toUpperCase();

  renderStats();
  renderStreak();
  renderExercises();
  renderDistractions();
  renderHeatmap();
  renderRewards();
  renderMilestones();
  renderSettings();
}

function renderStats() {
  const u = state.user;
  document.getElementById("stat-streak").textContent = u.streak;
  document.getElementById("stat-longest").textContent = u.longest_streak;
  document.getElementById("stat-coins").textContent = u.coins.toLocaleString();
  const totalEx = state.logs.reduce((acc, l) => acc + JSON.parse(l.exercises || "[]").length, 0);
  document.getElementById("stat-exercises").textContent = totalEx;
}

function renderStreak() {
  const u = state.user;
  const pct = Math.min(100, (u.streak / u.streak_goal) * 100);
  document.getElementById("streak-num").textContent = u.streak;
  document.getElementById("streak-goal-text").innerHTML =
    `Goal: <strong>${u.streak_goal} days</strong> &nbsp;|&nbsp; ${Math.max(0, u.streak_goal - u.streak)} days left`;
  document.getElementById("streak-progress").style.width = pct + "%";
}

// ---- EXERCISES ----
function renderExercises() {
  const list = document.getElementById("exercise-list");
  list.innerHTML = "";
  state.todayLog.exercises.forEach((ex, i) => {
    const item = document.createElement("div");
    item.className = "exercise-item";
    item.innerHTML = `
      <span class="exercise-icon">${getExerciseIcon(ex.type)}</span>
      <div class="exercise-info">
        <div class="exercise-name">${ex.name}</div>
        <div class="exercise-meta">${ex.sets ? ex.sets + " sets" : ""} ${ex.reps ? "× " + ex.reps + " reps" : ""} ${ex.duration ? ex.duration + " min" : ""}</div>
      </div>
      <input type="checkbox" class="exercise-done" ${ex.done ? "checked" : ""} onchange="toggleExerciseDone(${i})" title="Mark done">
      <button class="remove-btn" onclick="removeExercise(${i})" title="Remove">✕</button>
    `;
    list.appendChild(item);
  });
}

function getExerciseIcon(type) {
  const icons = { cardio: "🏃", strength: "💪", flexibility: "🧘", sports: "⚽", other: "🏋️" };
  return icons[type] || "🏋️";
}

function addExercise() {
  const name = document.getElementById("ex-name").value.trim();
  const type = document.getElementById("ex-type").value;
  const sets = document.getElementById("ex-sets").value;
  const reps = document.getElementById("ex-reps").value;
  const duration = document.getElementById("ex-duration").value;
  if (!name) return;
  state.todayLog.exercises.push({ name, type, sets, reps, duration, done: false });
  document.getElementById("ex-name").value = "";
  document.getElementById("ex-sets").value = "";
  document.getElementById("ex-reps").value = "";
  document.getElementById("ex-duration").value = "";
  renderExercises();
  scheduleSave();
}

function removeExercise(i) {
  state.todayLog.exercises.splice(i, 1);
  renderExercises();
  scheduleSave();
}

function toggleExerciseDone(i) {
  state.todayLog.exercises[i].done = !state.todayLog.exercises[i].done;
  scheduleSave();
}

// ---- DISTRACTIONS ----
function renderDistractions() {
  const list = document.getElementById("distraction-list");
  list.innerHTML = "";
  state.todayLog.distractions.forEach((d, i) => {
    const item = document.createElement("div");
    item.className = "distraction-item";
    item.innerHTML = `
      <span class="distraction-badge">${d.category}</span>
      <span style="flex:1;font-size:.9rem">${d.name}</span>
      <span style="font-size:.75rem;color:var(--muted)">${d.minutes ? d.minutes + " min" : ""}</span>
      <button class="remove-btn" onclick="removeDistraction(${i})">✕</button>
    `;
    list.appendChild(item);
  });
}

function addDistraction() {
  const name = document.getElementById("dis-name").value.trim();
  const category = document.getElementById("dis-cat").value;
  const minutes = document.getElementById("dis-min").value;
  if (!name) return;
  state.todayLog.distractions.push({ name, category, minutes });
  document.getElementById("dis-name").value = "";
  document.getElementById("dis-min").value = "";
  renderDistractions();
  scheduleSave();
}

function removeDistraction(i) {
  state.todayLog.distractions.splice(i, 1);
  renderDistractions();
  scheduleSave();
}

// ---- SAVE ----
function scheduleSave() {
  document.getElementById("save-status").textContent = "Unsaved changes...";
  document.getElementById("save-status").className = "save-status";
  clearTimeout(state.saveTimeout);
  state.saveTimeout = setTimeout(saveToday, 2000);
}

async function saveToday() {
  try {
    const body = {
      exercises: JSON.stringify(state.todayLog.exercises),
      distractions: JSON.stringify(state.todayLog.distractions),
      notes: document.getElementById("notes-area").value,
    };
    const res = await api("/logs/today", "POST", body);
    document.getElementById("save-status").textContent = "✓ Saved";
    document.getElementById("save-status").className = "save-status saved";

    // Refresh user data for coins/streak
    state.user = await api("/me");
    renderStats();
    renderStreak();
    renderHeatmap();

    if (res.coins_earned > 0) {
      showToast(`🪙 +${res.coins_earned} coins! Streak milestone reached!`, "toast-coin");
      renderRewards();
    }
  } catch (e) {
    showToast("Failed to save. Check connection.", "toast-error");
  }
}

// ---- HEATMAP ----
function renderHeatmap() {
  const container = document.getElementById("heatmap-grid");
  container.innerHTML = "";
  const today = new Date();
  const logDates = new Set(state.logs.filter(l => JSON.parse(l.exercises || "[]").length > 0).map(l => l.date));

  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().split("T")[0];
    const cell = document.createElement("div");
    cell.className = "heatmap-day" +
      (logDates.has(iso) ? " has-data" : "") +
      (i === 0 ? " today" : "");
    cell.title = iso;
    container.appendChild(cell);
  }
}

// ---- REWARDS ----
function renderRewards() {
  const list = document.getElementById("rewards-list");
  list.innerHTML = "";
  if (state.rewards.length === 0) {
    list.innerHTML = `<p style="color:var(--muted);font-size:.875rem;text-align:center;padding:1rem">Complete streaks to earn coins!</p>`;
    return;
  }
  state.rewards.slice(0, 20).forEach(r => {
    const item = document.createElement("div");
    item.className = "reward-item";
    item.innerHTML = `
      <span class="reward-icon">🪙</span>
      <div class="reward-info">
        <div class="reward-desc">${r.description}</div>
        <div class="reward-date">${r.earned_at.split("T")[0]}</div>
      </div>
      <div class="reward-coins">+${r.coins}</div>
    `;
    list.appendChild(item);
  });
}

// ---- MILESTONES ----
const MILESTONES = [
  { days: 3, icon: "🔥", coins: 50 },
  { days: 7, icon: "⚡", coins: 150 },
  { days: 14, icon: "💎", coins: 300 },
  { days: 30, icon: "🏆", coins: 750 },
  { days: 60, icon: "👑", coins: 1500 },
  { days: 90, icon: "🌟", coins: 3000 },
  { days: 180, icon: "🚀", coins: 6000 },
  { days: 365, icon: "🏅", coins: 15000 },
];

function renderMilestones() {
  const grid = document.getElementById("milestones-grid");
  grid.innerHTML = "";
  const earned = new Set(state.rewards.map(r => r.type));
  MILESTONES.forEach(m => {
    const unlocked = earned.has(`streak_${m.days}`);
    const div = document.createElement("div");
    div.className = "milestone-badge" + (unlocked ? " unlocked" : "");
    div.innerHTML = `
      <div class="m-icon">${m.icon}</div>
      <div class="m-days">${m.days}</div>
      <div class="m-label">day streak</div>
      <div class="m-coins">🪙 ${m.coins}</div>
    `;
    grid.appendChild(div);
  });
}

// ---- SETTINGS ----
function renderSettings() {
  const sel = document.getElementById("streak-goal-select");
  sel.value = state.user.streak_goal;
  document.getElementById("settings-username").textContent = state.user.username;
  document.getElementById("settings-email").textContent = state.user.email;
  document.getElementById("settings-joined").textContent = state.user.created_at.split("T")[0];
}

async function updateStreakGoal() {
  const goal = parseInt(document.getElementById("streak-goal-select").value);
  try {
    await api("/me/streak-goal", "PUT", { streak_goal: goal });
    state.user.streak_goal = goal;
    renderStreak();
    showToast(`✅ Streak goal set to ${goal} days!`, "toast-success");
  } catch (e) {
    showToast("Failed to update goal", "toast-error");
  }
}

// ---- NAVIGATION ----
function navTo(section) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.querySelectorAll(".section-page").forEach(p => p.classList.remove("active"));
  document.querySelector(`[data-nav="${section}"]`).classList.add("active");
  document.getElementById(`section-${section}`).classList.add("active");
}

// ---- PAGE MANAGEMENT ----
function showPage(page) {
  document.querySelectorAll(".app > div").forEach(d => d.classList.add("hidden"));
  document.getElementById(`page-${page}`).classList.remove("hidden");
}

// ---- TOAST ----
function showToast(msg, type = "toast-success") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---- ENTER KEY HANDLERS ----
document.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    const active = document.activeElement;
    if (active.id === "login-email" || active.id === "login-password") doLogin();
    if (active.id === "reg-username" || active.id === "reg-email" || active.id === "reg-password") doRegister();
  }
});

// ---- NOTES AUTOSAVE ----
document.addEventListener("DOMContentLoaded", () => {
  const notesArea = document.getElementById("notes-area");
  if (notesArea) {
    notesArea.addEventListener("input", scheduleSave);
  }
});

// ---- INIT ----
window.addEventListener("DOMContentLoaded", () => {
  if (state.token) {
    loadApp();
  } else {
    showPage("login");
  }
});