from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import sqlite3, bcrypt, jwt, datetime, os

# Serve frontend from ../frontend folder
FRONTEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend')

app = Flask(__name__, static_folder=FRONTEND, static_url_path='')
CORS(app)

SECRET = os.environ.get("JWT_SECRET", "fitstreak-secret-change-in-prod")
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fitstreak.db")

# ---------- SERVE FRONTEND ----------
@app.route('/')
def index():
    return send_from_directory(FRONTEND, 'index.html')

@app.route('/<path:path>')
def static_files(path):
    full = os.path.join(FRONTEND, path)
    if os.path.exists(full):
        return send_from_directory(FRONTEND, path)
    return send_from_directory(FRONTEND, 'index.html')

# ---------- DB SETUP ----------
def get_db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            coins INTEGER DEFAULT 0,
            streak_goal INTEGER DEFAULT 7,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            exercises TEXT DEFAULT '[]',
            distractions TEXT DEFAULT '[]',
            notes TEXT DEFAULT '',
            UNIQUE(user_id, date),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS rewards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            coins INTEGER NOT NULL,
            description TEXT,
            earned_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        """)

init_db()

# ---------- AUTH HELPERS ----------
def make_token(user_id):
    payload = {
        "user_id": user_id,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(days=7)
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")

def verify_token(req):
    auth = req.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        data = jwt.decode(auth[7:], SECRET, algorithms=["HS256"])
        return data["user_id"]
    except:
        return None

# ---------- AUTH ROUTES ----------
@app.route("/api/register", methods=["POST"])
def register():
    d = request.json
    if not d or not all(k in d for k in ["username", "email", "password"]):
        return jsonify({"error": "Missing fields"}), 400
    pw = bcrypt.hashpw(d["password"].encode(), bcrypt.gensalt()).decode()
    try:
        with get_db() as db:
            cur = db.execute(
                "INSERT INTO users (username, email, password) VALUES (?,?,?)",
                (d["username"].strip(), d["email"].strip().lower(), pw)
            )
            uid = cur.lastrowid
        return jsonify({"token": make_token(uid), "username": d["username"]}), 201
    except sqlite3.IntegrityError:
        return jsonify({"error": "Username or email already exists"}), 409

@app.route("/api/login", methods=["POST"])
def login():
    d = request.json
    if not d or not all(k in d for k in ["email", "password"]):
        return jsonify({"error": "Missing fields"}), 400
    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email=?", (d["email"].lower(),)).fetchone()
    if not user or not bcrypt.checkpw(d["password"].encode(), user["password"].encode()):
        return jsonify({"error": "Invalid credentials"}), 401
    return jsonify({"token": make_token(user["id"]), "username": user["username"]})

# ---------- USER ROUTES ----------
@app.route("/api/me", methods=["GET"])
def me():
    uid = verify_token(request)
    if not uid: return jsonify({"error": "Unauthorized"}), 401
    with get_db() as db:
        user = db.execute("SELECT id,username,email,coins,streak_goal,created_at FROM users WHERE id=?", (uid,)).fetchone()
        streak, longest = calc_streak(uid, db)
    return jsonify({**dict(user), "streak": streak, "longest_streak": longest})

@app.route("/api/me/streak-goal", methods=["PUT"])
def set_streak_goal():
    uid = verify_token(request)
    if not uid: return jsonify({"error": "Unauthorized"}), 401
    goal = request.json.get("streak_goal", 7)
    goal = max(3, min(365, int(goal)))
    with get_db() as db:
        db.execute("UPDATE users SET streak_goal=? WHERE id=?", (goal, uid))
    return jsonify({"streak_goal": goal})

# ---------- LOG ROUTES ----------
@app.route("/api/logs", methods=["GET"])
def get_logs():
    uid = verify_token(request)
    if not uid: return jsonify({"error": "Unauthorized"}), 401
    with get_db() as db:
        rows = db.execute("SELECT * FROM logs WHERE user_id=? ORDER BY date DESC LIMIT 90", (uid,)).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/logs/today", methods=["GET", "POST"])
def today_log():
    uid = verify_token(request)
    if not uid: return jsonify({"error": "Unauthorized"}), 401
    today = datetime.date.today().isoformat()
    with get_db() as db:
        if request.method == "GET":
            row = db.execute("SELECT * FROM logs WHERE user_id=? AND date=?", (uid, today)).fetchone()
            return jsonify(dict(row) if row else {"date": today, "exercises": "[]", "distractions": "[]", "notes": ""})
        d = request.json or {}
        db.execute("""
            INSERT INTO logs (user_id, date, exercises, distractions, notes)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_id, date) DO UPDATE SET
              exercises=excluded.exercises,
              distractions=excluded.distractions,
              notes=excluded.notes
        """, (uid, today, d.get("exercises","[]"), d.get("distractions","[]"), d.get("notes","")))
        streak, longest = calc_streak(uid, db)
        user = db.execute("SELECT streak_goal, coins FROM users WHERE id=?", (uid,)).fetchone()
        coins_earned = check_rewards(uid, streak, user["streak_goal"], user["coins"], db)
    return jsonify({"saved": True, "streak": streak, "coins_earned": coins_earned})

@app.route("/api/rewards", methods=["GET"])
def get_rewards():
    uid = verify_token(request)
    if not uid: return jsonify({"error": "Unauthorized"}), 401
    with get_db() as db:
        rows = db.execute("SELECT * FROM rewards WHERE user_id=? ORDER BY earned_at DESC LIMIT 50", (uid,)).fetchall()
    return jsonify([dict(r) for r in rows])

# ---------- HELPERS ----------
def calc_streak(uid, db):
    rows = db.execute(
        "SELECT date FROM logs WHERE user_id=? AND exercises != '[]' ORDER BY date DESC", (uid,)
    ).fetchall()
    dates = [datetime.date.fromisoformat(r["date"]) for r in rows]
    if not dates: return 0, 0
    streak = 1
    today = datetime.date.today()
    if dates[0] < today - datetime.timedelta(days=1):
        return 0, calc_longest(dates)
    for i in range(1, len(dates)):
        if (dates[i-1] - dates[i]).days == 1:
            streak += 1
        else:
            break
    return streak, calc_longest(dates)

def calc_longest(dates):
    if not dates: return 0
    longest = cur = 1
    for i in range(1, len(dates)):
        if (dates[i-1] - dates[i]).days == 1:
            cur += 1
            longest = max(longest, cur)
        else:
            cur = 1
    return longest

def check_rewards(uid, streak, goal, coins, db):
    milestones = {3: 50, 7: 150, 14: 300, 30: 750, 60: 1500, 90: 3000, 180: 6000, 365: 15000}
    earned = 0
    for days, reward in milestones.items():
        if streak == days:
            existing = db.execute(
                "SELECT id FROM rewards WHERE user_id=? AND type=?", (uid, f"streak_{days}")
            ).fetchone()
            if not existing:
                db.execute(
                    "INSERT INTO rewards (user_id, type, coins, description) VALUES (?,?,?,?)",
                    (uid, f"streak_{days}", reward, f"🔥 {days}-Day Streak Milestone!")
                )
                db.execute("UPDATE users SET coins=coins+? WHERE id=?", (reward, uid))
                earned = reward
    if streak == goal and goal not in milestones:
        existing = db.execute(
            "SELECT id FROM rewards WHERE user_id=? AND type=?", (uid, f"goal_{goal}")
        ).fetchone()
        if not existing:
            bonus = goal * 10
            db.execute(
                "INSERT INTO rewards (user_id, type, coins, description) VALUES (?,?,?,?)",
                (uid, f"goal_{goal}", bonus, f"🎯 Custom {goal}-Day Goal Reached!")
            )
            db.execute("UPDATE users SET coins=coins+? WHERE id=?", (bonus, uid))
            earned += bonus
    return earned

if __name__ == "__main__":
    print("\n✅ FitStreak is running!")
    print("👉 Open your browser and go to: http://127.0.0.1:5000\n")
    app.run(debug=True, port=5000, host='127.0.0.1')