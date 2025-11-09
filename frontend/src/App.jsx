import { useEffect, useMemo, useState } from "react";

/* -------- tiny path router: expects /:mode/:pid? -------- */
const VALID_MODES = new Set(["test", "training", "admin"]);
function readPath() {
  const seg = window.location.pathname.split("/").filter(Boolean);
  const mode = seg[0] && VALID_MODES.has(seg[0]) ? seg[0] : "";
  const pid = seg[1] || "";
  return { mode, pid };
}
function buildPath(mode, pid) {
  if (!mode) return "/";
  if (mode === "admin") return "/admin";
  return `/${mode}/${encodeURIComponent(pid || "")}`;
}
function setPath(mode, pid, replace = false) {
  const url = buildPath(mode, pid);
  if (replace) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
}

/* -------- utils -------- */
function parseAddress(addr) {
  if (!addr) return { name: "", email: "", domain: "", initials: "?" };
  const m = addr.match(/^(?:"?([^"]*)"?\s)?<?([^<>@\s]+@[^<>@\s]+)>?$/);
  const email = m?.[2] || addr;
  const name = (m?.[1] || "").trim() || email.split("@")[0];
  const domain = email.includes("@") ? email.split("@")[1] : "";
  const initials = name.replace(/\s+/g, " ").split(" ").filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase()).join("") || "?";
  return { name, email, domain, initials };
}
const norm = (v) => (v ?? "").toString().trim();
function normalizeExpectedEntry(entry) {
  if (entry && typeof entry === "object" && ("solution" in entry || "solution_regex" in entry)) return entry;
  return { solution: entry };
}
function evalAgainst(expectedEntry, userVal) {
  const e = normalizeExpectedEntry(expectedEntry);
  const expl = e.explanation || "";
  if (e.solution_regex) {
    try {
      const re = new RegExp(e.solution_regex, e.solution_flags || "");
      return { correct: re.test(norm(userVal)), expected: `/${e.solution_regex}/${e.solution_flags || ""}`, explanation: expl };
    } catch {}
  }
  const expected = e.solution;
  if (Array.isArray(expected)) {
    const ok = expected.map(norm).includes(norm(userVal));
    return { correct: ok, expected: expected.join(" / "), explanation: expl };
  }
  if (expected === undefined || expected === null || expected === "") {
    return { correct: null, expected: "", explanation: expl };
  }
  const ok = norm(expected) === norm(userVal);
  return { correct: ok, expected: norm(expected), explanation: expl };
}

/* -------- App -------- */
export default function App() {
  // Initialzustand aus URL-Pfad (/:mode/:pid?)
  const initial = readPath();
  const [mode, setMode] = useState(() => initial.mode || localStorage.getItem("mailstudy_mode") || "");
  const [pid, setPid] = useState(() => (initial.mode && initial.mode !== "admin" ? initial.pid : "") || localStorage.getItem("mailstudy_pid") || "");
  const [showModePicker, setShowModePicker] = useState(!(mode && (mode === "admin" || pid)));

  // Browser back/forward: Pfad überwachen
  useEffect(() => {
    const onPop = () => {
      const p = readPath();
      // Guard: test/training ohne pid -> zurück auf root + Picker
      if ((p.mode === "test" || p.mode === "training") && !p.pid) {
        window.history.replaceState({}, "", "/");
        setMode("");
        setPid("");
        setShowModePicker(true);
        return;
      }
      if (p.mode && (p.mode === "admin" || p.pid)) {
        setMode(p.mode); setPid(p.pid); setShowModePicker(false);
      } else {
        setShowModePicker(true);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const API_URL = useMemo(() => {
    const env = import.meta.env?.VITE_API_BASE;
    if (env) return env.replace(/\/$/, "");
    if (window.location.hostname === "frontend" || window.location.hostname === "0.0.0.0") return "http://backend:8000";
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }, []);

  // --- Admin-Login (Backend-Token) ---
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminPwd, setAdminPwd] = useState("");
  const [adminToken, setAdminToken] = useState("");

  // State
  const [emails, setEmails] = useState([]);
  const [selected, setSelected] = useState(null);
  const [emailContent, setEmailContent] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [explanations, setExplanations] = useState({});
  const [supposed, setSupposed] = useState({});
  const [answeredIds, setAnsweredIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("loading");
  const [debug, setDebug] = useState({ lastUrl: "", lastError: "", lastPayload: "" });
  const [hideDone, setHideDone] = useState(false);
  const [trainingResult, setTrainingResult] = useState(null);

  // Darf die App E-Mails laden/anzeigen?
  const canListEmails = useMemo(() => {
    if (mode === "admin") return true;
    if ((mode === "test" || mode === "training") && pid && pid.trim()) return true;
    return false;
  }, [mode, pid]);

  // *** HARTE ROUTE-SPERRE beim Initial-Load: /test oder /training ohne PID -> sofort auf "/" ***
  useEffect(() => {
    if ((mode === "test" || mode === "training") && !pid) {
      window.history.replaceState({}, "", "/");
      setMode("");
      setPid("");
      setShowModePicker(true);
    }
  }, []); // nur einmal beim Mount

  async function safeFetch(url, opts) {
    try {
      setDebug((d) => ({ ...d, lastUrl: url, lastError: "" }));
      const res = await fetch(url, opts);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const msg = `HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0,200)}` : ""}`;
        setDebug((d) => ({ ...d, lastError: msg, lastPayload: "" }));
        throw new Error(msg);
      }
      const data = await res.json();
      setDebug((d) => ({ ...d, lastPayload: JSON.stringify(data).slice(0, 500) }));
      return data;
    } catch (e) {
      setDebug((d) => ({ ...d, lastError: String(e) }));
      throw e;
    }
  }

  // Init/Reload: nur laden, wenn erlaubt
  useEffect(() => {
    (async () => {
      try {
        if (!canListEmails) {
          setEmails([]);
          setAnsweredIds(new Set());
          setSelected(null);
          setEmailContent(null);
          setStatus("connected");
          return;
        }
        setStatus("loading");
        const list = await safeFetch(`${API_URL}/api/emails`);
        setEmails(Array.isArray(list) ? list : []);
        const ans = await safeFetch(`${API_URL}/api/answered${pid ? `?participant=${encodeURIComponent(pid)}` : ""}`)
          .catch(() => ({ answered: [] }));
        setAnsweredIds(new Set(ans?.answered || []));
        setStatus("connected");
      } catch {
        setStatus("error");
      }
    })();
  }, [API_URL, pid, canListEmails]);

  // E-Mail öffnen (Guard)
  async function openEmail(id) {
    if (!canListEmails) return;
    try {
      setLoading(true);
      setSelected(id);
      setTrainingResult(null);
      setExplanations({});
      setAnswers({});
      const [mail, qs, sup] = await Promise.all([
        safeFetch(`${API_URL}/api/email/${id}`),
        safeFetch(`${API_URL}/api/questions/${id}`).catch(() => []),
        safeFetch(`${API_URL}/api/supposed/${id}`).catch(() => ({ solutions: {} }))
      ]);
      setEmailContent(mail);
      setQuestions(Array.isArray(qs) ? qs : []);
      setSupposed(sup.solutions || {});
      const expInit = {};
      Object.entries(sup.solutions || {}).forEach(([qid, entry]) => {
        const e = (entry && typeof entry === "object" && ("solution" in entry || "solution_regex" in entry)) ? entry : { solution: entry };
        if (e.explanation) expInit[qid] = e.explanation;
      });
      setExplanations(expInit);
    } catch {
      /* debug shows error */
    } finally {
      setLoading(false);
    }
  }

  // Antworten speichern
  async function handleSubmit(e) {
    e.preventDefault();
    const isLocked = mode === "test" && selected && answeredIds.has(selected);
    if (isLocked) return;
    if ((mode === "test" || mode === "training") && !pid) {
      alert("Bitte Teilnehmer-ID angeben."); return;
    }
    try {
      await safeFetch(`${API_URL}/api/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_id: selected, participant_id: pid || "admin", answers, mode })
      });
      if (mode === "test") {
        setAnsweredIds((p) => new Set(p).add(selected));
        alert("Antwort gespeichert! (Test) – E-Mail für diese Teilnehmer-ID gesperrt.");
        return;
      }
      if (mode === "training") {
        const perQuestion = {};
        let correctCount = 0;
        const vis = flattenVisible(questions);
        vis.forEach((q) => {
          const res = evalAgainst(supposed[q.id], answers[q.id]);
          perQuestion[q.id] = res;
          if (res.correct === true) correctCount++;
        });
        setTrainingResult({ perQuestion, correctCount, total: vis.length });
        alert("Antwort gespeichert! (Training) – Auswertung angezeigt.");
      }
      if (mode === "admin") {
        alert("Antwort gespeichert! (Admin). Du kannst diese Antworten als Lösungen sichern.");
      }
    } catch (err) {
      if (String(err).includes("409")) alert("Diese E-Mail wurde für diese Teilnehmer-ID im Test bereits beantwortet.");
      else alert("Fehler beim Speichern (siehe Debug).");
    }
  }

  // Admin-Login -> Token holen (für Start-Overlay verwendet)
  async function doAdminLoginInline() {
    // schon eingeloggt?
    if (adminAuthed && adminToken) return true;
    if (!adminPwd.trim()) { alert("Bitte Admin-Passwort eingeben."); return false; }
    try {
      const data = await safeFetch(`${API_URL}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPwd })
      });
      setAdminToken(data.token);
      setAdminAuthed(true);
      setAdminPwd("");
      return true;
    } catch {
      alert("Login fehlgeschlagen.");
      return false;
    }
  }

  // Admin: aktuelle Antworten als Lösungen speichern (inkl. Erklärung) – mit Token
  async function saveAsSupposed() {
    if (!selected) return;
    if (!adminAuthed || !adminToken) { alert("Admin-Login erforderlich."); return; }
    const vis = flattenVisible(questions);
    const payload = {};
    vis.forEach((q) => {
      if (answers[q.id] !== undefined) {
        const entry = { solution: answers[q.id] };
        const exp = (explanations[q.id] || "").trim();
        if (exp) entry.explanation = exp;
        payload[q.id] = entry;
      }
    });
    await safeFetch(`${API_URL}/api/supposed/${selected}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminToken}`
      },
      body: JSON.stringify({ solutions: payload })
    });
    const sup = await safeFetch(`${API_URL}/api/supposed/${selected}`).catch(() => ({ solutions: {} }));
    setSupposed(sup.solutions || {});
    const expInit = {};
    Object.entries(sup.solutions || {}).forEach(([qid, entry]) => {
      const e = (entry && typeof entry === "object" && ("solution" in entry || "solution_regex" in entry)) ? entry : { solution: entry };
      if (e.explanation) expInit[qid] = e.explanation;
    });
    setExplanations(expInit);
    alert("Lösungen (inkl. Erklärungen) gespeichert!");
  }

  // Sichtbarkeit & Fortschritt
  function shouldShow(q) {
    if (!q?.show_if) return true;
    for (const [key, vals] of Object.entries(q.show_if)) {
      const v = answers[key];
      if (!v || !vals.includes(v)) return false;
    }
    return true;
  }
  function flattenVisible(arr) {
    const out = [];
    const walk = (qs) => {
      (qs || []).forEach((q) => {
        let visible = true;
        if (q?.show_if) {
          for (const [k, vals] of Object.entries(q.show_if)) {
            const v = answers[k];
            if (!v || !vals.includes(v)) { visible = false; break; }
          }
        }
        if (visible) { out.push(q); if (q.subquestions) walk(q.subquestions); }
      });
    };
    walk(arr);
    return out;
  }

  const visibleQs = flattenVisible(questions);
  const totalQs = visibleQs.length || 0;
  const answeredCount = visibleQs.reduce((n, q) => n + (answers[q.id]?.toString().trim() ? 1 : 0), 0);
  const pct = totalQs ? Math.round((answeredCount / totalQs) * 100) : 0;
  const isLocked = mode === "test" && selected && answeredIds.has(selected);

  function renderPrettyQuestion(q, level = 0) {
    if (!q || !shouldShow(q)) return null;
    const colors = ["#c7d2fe", "#93c5fd", "#7dd3fc"];
    const color = colors[Math.min(level, colors.length - 1)];
    const card = { border: "1px solid #edf0f4", background: "#fafbfd", borderRadius: 12, padding: 12, marginBottom: 12,
                   boxShadow: "0 1px 0 rgba(16,24,40,.03)", borderLeft: `4px solid ${color}`, marginLeft: level ? 6 : 0, opacity: isLocked ? 0.5 : 1 };
    const label = { fontWeight: 600, marginBottom: 6, display: "block" };
    const input = { width: "100%", background: "#fff", border: "1px solid #dfe4ea", padding: "10px 10px", borderRadius: 10, outline: "none" };

    const fb = trainingResult?.perQuestion?.[q.id];
    const showFB = mode === "training" && trainingResult && fb && fb.correct !== null;

    return (
      <div key={q.id} style={card}>
        <label style={label}>{q.text}</label>

        {q.type === "scale" && (
          <select style={input} disabled={isLocked} value={answers[q.id] || ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}>
            <option value="">Bitte wählen …</option>
            {[1,2,3,4,5].map(n => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        )}

        {q.type === "choice" && (
          <select style={input} disabled={isLocked} value={answers[q.id] || ""}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}>
            <option value="">Bitte wählen …</option>
            {(q.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        )}

        {q.type === "text" && (
          <textarea rows="3" style={{ ...input, resize: "vertical" }} disabled={isLocked}
                    value={answers[q.id] || ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}/>
        )}

        {mode === "admin" && adminAuthed && (
          <div style={{ marginTop: 8 }}>
            <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>
              Erklärung (optional, erscheint im Training)
            </label>
            <textarea rows="2" placeholder="Kurze Begründung/Hinweis …"
                      style={{ ...input, padding: "8px 10px", resize: "vertical" }}
                      value={explanations[q.id] || ""}
                      onChange={(e) => setExplanations({ ...explanations, [q.id]: e.target.value })}/>
          </div>
        )}

        {showFB && (
          <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 10,
                        border: `1px solid ${fb.correct ? "#bfe6bf" : "#ffc9c9"}`,
                        background: fb.correct ? "#e6f7e6" : "#fff5f5",
                        color: fb.correct ? "#2e7d32" : "#b42318", fontSize: 13 }}>
            {fb.correct ? "✅ Richtig" : "❌ Falsch"}
            {fb.expected && <div style={{ marginTop: 4, color: "#374151" }}><strong>Erwartet:</strong> <code>{fb.expected}</code></div>}
            {fb.explanation && <div style={{ marginTop: 4, color: "#374151" }}><strong>Erklärung:</strong> {fb.explanation}</div>}
          </div>
        )}

        {(q.subquestions || []).map(sub => renderPrettyQuestion(sub, level + 1))}
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* Start-Overlay (Admin: Passwort erforderlich) */}
      {showModePicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 20, width: 500, boxShadow: "0 10px 30px rgba(0,0,0,.2)" }}>
            <h2 style={{ marginTop: 0 }}>Start</h2>
            <p style={{ color: "#555", marginTop: 0 }}>Bitte Modus wählen. Für <strong>Test</strong>/<strong>Training</strong> eine <strong>Teilnehmer-ID</strong> angeben. Für <strong>Admin</strong> ist ein Passwort nötig.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
              <button onClick={() => setMode("test")}     style={{ background: mode==="test"?"#111827":"#333", color:"#fff", padding:"10px 14px", border:0, borderRadius:10, cursor:"pointer", fontWeight:600 }}>🎯 Test</button>
              <button onClick={() => setMode("training")} style={{ background: mode==="training"?"#2563eb":"#3b82f6", color:"#fff", padding:"10px 14px", border:0, borderRadius:10, cursor:"pointer", fontWeight:600 }}>📘 Training</button>
              <button onClick={() => setMode("admin")}    style={{ background: mode==="admin"?"#0b7":"#13a", color:"#fff", padding:"10px 14px", border:0, borderRadius:10, cursor:"pointer", fontWeight:600 }}>🛠️ Admin</button>
            </div>

            {/* Test/Training: PID */}
            {mode !== "admin" && (
              <div style={{ margin: "8px 0 14px" }}>
                <label style={{ display: "block", fontSize: 13, color: "#374151", marginBottom: 6 }}>Teilnehmer-ID</label>
                <input value={pid} onChange={(e)=>setPid(e.target.value)} placeholder="z. B. P001-Alpha"
                       style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db" }}/>
              </div>
            )}

            {/* Admin: Passwortfeld direkt im Overlay */}
            {mode === "admin" && (
              <div style={{ margin: "8px 0 14px" }}>
                <label style={{ display: "block", fontSize: 13, color: "#374151", marginBottom: 6 }}>Admin-Passwort</label>
                <input
                  type="password"
                  placeholder="Passwort eingeben"
                  value={adminPwd}
                  onChange={(e)=>setAdminPwd(e.target.value)}
                  style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid #d1d5db" }}
                />
                {!adminAuthed && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>Zum Fortfahren ist ein gültiges Admin-Login erforderlich.</p>}
                {adminAuthed && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#16a34a" }}>✅ Eingeloggt</p>}
              </div>
            )}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={async () => {
                  // Guards
                  if (mode === "admin") {
                    const ok = await doAdminLoginInline();
                    if (!ok) return; // bei Fehler im Overlay bleiben
                    // erfolgreich -> fortfahren
                    localStorage.setItem("mailstudy_mode", "admin");
                    setShowModePicker(false);
                    setPath("admin", "", false);
                    return;
                  }
                  if ((mode==="test" || mode==="training") && !pid.trim()) {
                    alert("Bitte Teilnehmer-ID eingeben."); return;
                  }
                  localStorage.setItem("mailstudy_mode", mode || "");
                  if (mode !== "admin") localStorage.setItem("mailstudy_pid", pid.trim());
                  setShowModePicker(false);
                  setPath(mode, pid, false);
                }}
                style={{ background: "#16a34a", color: "#fff", padding: "10px 14px", border: 0, borderRadius: 10, cursor: "pointer", fontWeight: 600 }}
              >
                Starten
              </button>
            </div>

            <p style={{ fontSize: 12, color: "#666", marginTop: 8 }}>Deep-Link: <code>/test/P001</code>, <code>/training/alice</code>, <code>/admin</code></p>
          </div>
        </div>
      )}

      {/* Status/Top-Bar */}
      <div style={{ padding: "6px 10px", background: "#f7f7f7", borderBottom: "1px solid #e6e6e6", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>API:</strong> <code style={{ fontSize: 12 }}>{API_URL}</code>
        <span style={{ fontSize: 12 }}>
          {status === "loading" && "⏳ Verbinde …"}
          {status === "connected" && <span style={{ color: "green" }}>✅ Backend</span>}
          {status === "error" && <span style={{ color: "red" }}>❌ Keine Verbindung</span>}
        </span>
        <span style={{ fontSize: 12 }}><strong>Modus:</strong> {mode || "—"}</span>
        {mode !== "admin" && <span style={{ fontSize: 12 }}><strong>Teilnehmer-ID:</strong> {pid || "—"}</span>}
        <span style={{ marginLeft: "auto" }}>
          <button
            onClick={() => setShowModePicker(true)}
            title="Modus/ID ändern"
            style={{ fontSize: 11, lineHeight: 1, padding: "2px 6px", background: "transparent", color: "#9ca3af",
                     border: "1px solid #e5e7eb", borderRadius: 6, cursor: "pointer", opacity: 0.6 }}
          >
            ändern
          </button>
        </span>
      </div>

      {/* 3 Spalten */}
      <div style={{ display: "grid", gridTemplateColumns: "25% 50% 25%", height: "calc(100vh - 40px)" }}>
        {/* Inbox */}
        <div style={{ borderRight: "1px solid #ddd", background: "#fff", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px", background: "#eee", borderBottom: "1px solid #ddd" }}>
            <h2 style={{ margin: 0, fontSize: "1.02rem", fontWeight: 700, flex: 1 }}>Posteingang</h2>
            <label style={{ fontSize: 11, color: "#374151", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={hideDone} onChange={(e)=>setHideDone(e.target.checked)} /> Erledigte ausblenden
            </label>
          </div>

          {!canListEmails ? (
            <p style={{ padding: 12, color: "#666" }}>
              Für {mode || "—"} bitte eine Teilnehmer-ID in der URL angeben
              (z. B. <code>/test/P001</code> oder <code>/training/alice</code>).
            </p>
          ) : status !== "connected" ? (
            <p style={{ padding: 12, color: "#666" }}>Verbindung prüfen …</p>
          ) : emails.length === 0 ? (
            <p style={{ padding: 12, color: "#666" }}>Keine E-Mails gefunden</p>
          ) : (
            emails.filter(m => !hideDone || !answeredIds.has(m.id)).map(mail => {
              const done = answeredIds.has(mail.id);
              return (
                <div key={mail.id} onClick={() => openEmail(mail.id)} style={{
                  padding: "10px 12px", borderBottom: "1px solid #f0f0f0", cursor: "pointer",
                  background: selected === mail.id ? "#e8f0ff" : "transparent", opacity: done ? 0.9 : 1
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontWeight: 600, flex: 1 }}>{mail.subject}</div>
                    {done && <span style={{ fontSize: 11, background: "#e6f7e6", color: "#2e7d32", border: "1px solid #bfe6bf", borderRadius: 10, padding: "1px 6px" }}>Erledigt</span>}
                  </div>
                  <div style={{ fontSize: 12, color: "#666" }}>{mail.from}</div>
                  <div style={{ fontSize: 12, color: "#999" }}>{mail.date}</div>
                </div>
              );
            })
          )}
        </div>

        {/* Mitte: Mailkopf + Body + Anhänge */}
        <div style={{ borderRight: "1px solid #ddd", background: "#fff", display: "flex", flexDirection: "column", minHeight: 0 }}>
          {emailContent ? (
            <div style={{ padding: "12px 12px 8px", borderBottom: "1px solid #eee", background: "#fff" }}>
              <div style={{ fontSize: "1.08rem", fontWeight: 700, marginBottom: 6 }}>{emailContent.subject || "(ohne Betreff)"}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#e5edff", color: "#2b4ae2", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
                  {parseAddress(emailContent.from).initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 600 }}>{parseAddress(emailContent.from).name}</div>
                    <div style={{ color: "#6b7280" }}>&lt;{parseAddress(emailContent.from).email}&gt;</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#374151", marginTop: 2 }}>
                    <strong>Gesendet an:</strong> {parseAddress(emailContent.to).email || emailContent.to || "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right", color: "#6b7280", fontSize: 12 }}>
                  {emailContent.date || ""}
                  {parseAddress(emailContent.from).domain && (
                    <div style={{ marginTop: 2 }}>
                      <span style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 6, border: "1px solid #e5e7eb" }}>
                        gesendet von {parseAddress(emailContent.from).domain}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding: 10, borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 600, color: "#666" }}>
                {!canListEmails ? "Bitte Teilnehmer-ID angeben (siehe linke Spalte)." : "Wähle links eine E-Mail aus"}
              </div>
            </div>
          )}

          <div style={{ flex: 1, overflow: "hidden" }}>
            {loading ? <p style={{ padding: 12, color: "#666" }}>Lade E-Mail …</p> :
              emailContent ? <iframe srcDoc={emailContent.html} title="email" style={{ width: "100%", height: "100%", border: "none" }}/> :
              <p style={{ padding: 12, color: "#666" }}>–</p>}
          </div>

          {emailContent && emailContent.attachments && emailContent.attachments.length > 0 && (
            <div style={{ padding: "6px 10px", borderTop: "1px solid #eee", background: "#fafafa" }}>
              <div style={{ fontSize: 12, marginBottom: 6, color: "#374151" }}>Anhänge</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {emailContent.attachments.map((att, i) => (
                  <a key={i} href={`${API_URL}/api/email/${encodeURIComponent(emailContent.id)}/attachment/${i}`} target="_blank" rel="noopener noreferrer"
                     style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e5e7eb", background: "#fff", padding: "4px 8px", borderRadius: 8, textDecoration: "none", color: "#111" }} download>
                    📎 {att.filename || `Anhang ${i + 1}`}
                    <span style={{ fontSize: 11, color: "#6b7280" }}>
                      {att.content_type?.split(";")[0] || "Datei"}{typeof att.size === "number" ? ` · ${Math.ceil(att.size / 1024)} KB` : ""}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Rechts: Fragen + Admin-Gate */}
        <div style={{ display: "flex", flexDirection: "column", background: "#fff", minHeight: 0 }}>
          <div style={{ position: "sticky", top: 0, background: "#ffffffcc", backdropFilter: "saturate(180%) blur(6px)", borderBottom: "1px solid #eee", padding: "10px 10px 8px", zIndex: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.02rem", fontWeight: 700, flex: 1 }}>
                Fragen {mode === "test" && (isLocked ? "— gesperrt (Test)" : "")}{mode === "admin" && "— Admin"}
              </h2>
              <div title="Fortschritt" style={{ flex: 1, height: 6, background: "#f2f4f7", borderRadius: 999, overflow: "hidden", outline: "1px solid #eef0f3" }}>
                <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#3b82f6,#2563eb)" }}/>
              </div>
              <div style={{ fontSize: 11, color: "#374151", width: 140, textAlign: "right" }}>
                {answeredCount}/{totalQs} beantwortet
              </div>
            </div>
          </div>

          <div style={{ padding: 10, overflow: "auto", flex: 1 }}>
            {/* Admin-spezifischer Hinweis falls jemand irgendwie am Overlay vorbei kam */}
            {mode === "admin" && !adminAuthed ? (
              <p style={{ color: "#b42318" }}>Admin-Bereich gesperrt. Bitte über den Start-Dialog anmelden.</p>
            ) : !canListEmails ? (
              <p style={{ color: "#666" }}>Für diesen Modus bitte erst eine Teilnehmer-ID angeben.</p>
            ) : !emailContent ? (
              <p style={{ color: "#666" }}>Wähle links eine E-Mail aus.</p>
            ) : questions.length === 0 ? (
              <p style={{ color: "#666" }}>Keine Fragen für diese E-Mail.</p>
            ) : (
              <>
                {/* Admin-Panel (nur wenn eingeloggt) */}
                {mode === "admin" && adminAuthed && (
                  <div style={{ marginBottom: 12, padding: 12, border: "1px solid #e5e7eb", borderRadius: 10, background: "#f8fafc" }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Admin</div>
                    {Object.keys(supposed || {}).length === 0 ? (
                      <div style={{ fontSize: 13, color: "#374151" }}>Keine Lösungen hinterlegt.</div>
                    ) : (
                      <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                        {Object.entries(supposed).map(([qid, entry]) => {
                          const e = normalizeExpectedEntry(entry);
                          const label = Array.isArray(e.solution) ? e.solution.join(" / ") : (e.solution ?? e.solution_regex ?? "").toString();
                          return (
                            <li key={qid} style={{ fontSize: 13, marginBottom: 4 }}>
                              <code>{qid}</code>: {label}{e.explanation ? <span style={{ color: "#555" }}> — {e.explanation}</span> : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <button onClick={saveAsSupposed}
                              style={{ background: "#0b7", color: "#fff", padding: "8px 12px", border: 0, borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
                        Aktuelle Antworten als Lösungen speichern
                      </button>
                    </div>
                  </div>
                )}

                <form id="qform" onSubmit={handleSubmit} style={{ pointerEvents: isLocked ? "none" : "auto", filter: isLocked ? "grayscale(0.2) opacity(0.6)" : "none" }}>
                  {questions.map((q) => renderPrettyQuestion(q, 0))}
                </form>

                {mode === "training" && trainingResult && (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: "1px solid #e5e7eb", background: "#f8fafc" }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Ergebnis: {trainingResult.correctCount} / {trainingResult.total} korrekt</div>
                    <div style={{ fontSize: 13, color: "#374151" }}>
                      Korrekte Antworten grün; falsche mit erwarteter Lösung und Erklärung je Frage.
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div style={{ position: "sticky", bottom: 0, display: "flex", gap: 8, justifyContent: "flex-end", padding: "8px 10px",
                        background: "#ffffffd9", borderTop: "1px solid #eee", backdropFilter: "saturate(180%) blur(6px)", zIndex: 2 }}>
            {emailContent && (
              <>
                <button type="button" onClick={() => setAnswers({})}
                        disabled={isLocked}
                        style={{ background: "transparent", color: "#374151", padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 10,
                                 cursor: isLocked ? "not-allowed" : "pointer", opacity: isLocked ? 0.6 : 1 }}>
                  Zurücksetzen
                </button>
                <button form="qform" disabled={isLocked}
                        style={{ background: "#2563eb", color: "#fff", padding: "8px 12px", border: 0, borderRadius: 10, cursor: isLocked ? "not-allowed" : "pointer", fontWeight: 600, opacity: isLocked ? 0.6 : 1 }}>
                  Speichern
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {debug.lastPayload && (
        <pre style={{ margin: 0, padding: 6, fontSize: 11, background: "#fafafa", borderTop: "1px solid #eee", color: "#333", maxHeight: 140, overflowY: "auto" }}>
{debug.lastPayload}
        </pre>
      )}
    </div>
  );
}
