import { useEffect, useMemo, useState } from "react";

export default function App() {
  // -------- API-Basis automatisch ableiten (oder via .env: VITE_API_BASE) --------
  const API_URL = useMemo(() => {
    const env = import.meta.env?.VITE_API_BASE;
    if (env) return env.replace(/\/$/, "");
    if (window.location.hostname === "frontend" || window.location.hostname === "0.0.0.0") {
      return "http://backend:8000"; // Docker-Compose
    }
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }, []);

  // -------- State --------
  const [emails, setEmails] = useState([]);
  const [selected, setSelected] = useState(null);
  const [emailContent, setEmailContent] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [answeredIds, setAnsweredIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("loading"); // loading | connected | error
  const [debug, setDebug] = useState({ lastUrl: "", lastError: "", lastPayload: "" });
  const [hideDone, setHideDone] = useState(false);

  // -------- Debug-Wrapper um fetch --------
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
    } catch (err) {
      setDebug((d) => ({ ...d, lastError: String(err) }));
      throw err;
    }
  }

  // -------- Initial: Mails & beantwortete IDs laden --------
  useEffect(() => {
    (async () => {
      try {
        setStatus("loading");
        const [list, ans] = await Promise.all([
          safeFetch(`${API_URL}/api/emails`),
          safeFetch(`${API_URL}/api/answered`).catch(() => ({ answered: [] }))
        ]);
        setEmails(Array.isArray(list) ? list : []);
        setAnsweredIds(new Set(ans?.answered || []));
        setStatus("connected");
      } catch {
        setStatus("error");
      }
    })();
  }, [API_URL]);

  // -------- E-Mail öffnen (inkl. Anhänge & Fragen) --------
  async function openEmail(id) {
    try {
      setLoading(true);
      setSelected(id);
      const [mail, qs, atts] = await Promise.all([
        safeFetch(`${API_URL}/api/email/${id}`),
        safeFetch(`${API_URL}/api/questions/${id}`).catch(() => []),
        safeFetch(`${API_URL}/api/email/${id}/attachments`).catch(() => ({ attachments: [] }))
      ]);
      setEmailContent(mail);
      setQuestions(Array.isArray(qs) ? qs : []);
      setAttachments(atts.attachments || []);
      setAnswers({});
    } catch {
      /* Fehler stehen im Debug-Panel */
    } finally {
      setLoading(false);
    }
  }

  // -------- Antworten speichern --------
  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await safeFetch(`${API_URL}/api/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_id: selected, answers })
      });
      setAnsweredIds((prev) => new Set(prev).add(selected));
      alert("Antwort gespeichert! Diese E-Mail ist jetzt als 'Erledigt' markiert.");
    } catch {
      alert("Fehler beim Speichern (siehe Debug-Info oben).");
    }
  }

  // -------- Utils für Header-Darstellung --------
  function parseAddress(addr) {
    // z.B. `"Name" <user@example.com>` → { name, email, domain, initials }
    if (!addr) return { name: "", email: "", domain: "", initials: "?" };
    const m = addr.match(/^(?:"?([^"]*)"?\s)?<?([^<>@\s]+@[^<>@\s]+)>?$/);
    const email = m?.[2] || addr;
    const name = (m?.[1] || "").trim() || email.split("@")[0];
    const domain = email.includes("@") ? email.split("@")[1] : "";
    const initials = name
      .replace(/\s+/g, " ")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map(s => s[0]?.toUpperCase())
      .join("") || "?";
    return { name, email, domain, initials };
  }
  const fromInfo = parseAddress(emailContent?.from || "");
  const toInfo = parseAddress(emailContent?.to || "");

  // -------- Sichtbarkeit von Unterfragen --------
  function shouldShow(q) {
    if (!q?.show_if) return true;
    for (const [key, vals] of Object.entries(q.show_if)) {
      const v = answers[key];
      if (!v || !vals.includes(v)) return false;
    }
    return true;
  }

  // -------- Schöne Frage-Karte (rekursiv) --------
  function renderPrettyQuestion(q, level = 0) {
    if (!q || !shouldShow(q)) return null;

    const borderColors = ["#c7d2fe", "#93c5fd", "#7dd3fc"];
    const color = borderColors[Math.min(level, borderColors.length - 1)];
    const cardStyle = {
      border: "1px solid #edf0f4",
      background: "#fafbfd",
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
      boxShadow: "0 1px 0 rgba(16,24,40,.03)",
      borderLeft: `4px solid ${color}`,
      marginLeft: level ? 6 : 0
    };
    const labelStyle = { fontWeight: 600, marginBottom: 6, display: "block" };
    const inputStyle = {
      width: "100%",
      background: "#fff",
      border: "1px solid #dfe4ea",
      padding: "10px 10px",
      borderRadius: 10,
      outline: "none"
    };

    return (
      <div key={q.id} style={cardStyle}>
        <label style={labelStyle}>{q.text}</label>

        {q.type === "scale" && (
          <select
            style={inputStyle}
            value={answers[q.id] || ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
          >
            <option value="">Bitte wählen …</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={String(n)}>{n}</option>
            ))}
          </select>
        )}

        {q.type === "choice" && (
          <select
            style={inputStyle}
            value={answers[q.id] || ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
          >
            <option value="">Bitte wählen …</option>
            {(q.options || []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        )}

        {q.type === "text" && (
          <textarea
            rows="3"
            style={{ ...inputStyle, resize: "vertical" }}
            value={answers[q.id] || ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
          />
        )}

        {q.help && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>{q.help}</div>}

        {(q.subquestions || []).map((sub) => renderPrettyQuestion(sub, level + 1))}
      </div>
    );
  }

  // -------- Fortschritt zählen (nur sichtbare Fragen) --------
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
        if (visible) {
          out.push(q);
          if (q.subquestions) walk(q.subquestions);
        }
      });
    };
    walk(arr);
    return out;
  }
  const visibleQs = flattenVisible(questions);
  const totalQs = visibleQs.length || 0;
  const answeredCount = visibleQs.reduce((n, q) => n + (answers[q.id]?.toString().trim() ? 1 : 0), 0);
  const pct = totalQs ? Math.round((answeredCount / totalQs) * 100) : 0;

  // -------- UI --------
  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* Status/Debug-Bar */}
      <div style={{ padding: "8px 12px", background: "#f3f3f3", borderBottom: "1px solid #ddd", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <strong>API:</strong> <code>{API_URL}</code>
        <span>
          {status === "loading" && "⏳ Verbinde …"}
          {status === "connected" && <span style={{ color: "green" }}>✅ Backend verbunden</span>}
          {status === "error" && <span style={{ color: "red" }}>❌ Keine Verbindung</span>}
        </span>
        {debug.lastUrl && <span style={{ color: "#666" }}><strong>Last URL:</strong> {debug.lastUrl}</span>}
        {debug.lastError && <span style={{ color: "red" }}><strong>Fehler:</strong> {debug.lastError}</span>}
      </div>

      {/* 3-Spalten-Layout */}
      <div style={{ display: "grid", gridTemplateColumns: "25% 50% 25%", height: "calc(100vh - 42px)" }}>
        {/* Links: Posteingang */}
        <div style={{ borderRight: "1px solid #ddd", background: "#fff", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px", background: "#eee", borderBottom: "1px solid #ddd" }}>
            <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, flex: 1 }}>Posteingang</h2>
            <label style={{ fontSize: 12, color: "#374151", display: "flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={hideDone} onChange={(e)=>setHideDone(e.target.checked)} />
              Erledigte ausblenden
            </label>
          </div>

          {status !== "connected" ? (
            <p style={{ padding: "12px", color: "#666" }}>Verbindung prüfen …</p>
          ) : emails.length === 0 ? (
            <p style={{ padding: "12px", color: "#666" }}>Keine E-Mails gefunden</p>
          ) : (
            emails
              .filter(m => !hideDone || !answeredIds.has(m.id))
              .map((mail) => {
                const done = answeredIds.has(mail.id);
                return (
                  <div
                    key={mail.id}
                    onClick={() => openEmail(mail.id)}
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid #f0f0f0",
                      cursor: "pointer",
                      background: selected === mail.id ? "#e8f0ff" : "transparent",
                      opacity: done ? 0.9 : 1
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 600, flex: 1 }}>{mail.subject}</div>
                      {done && (
                        <span style={{
                          fontSize: 12, background: "#e6f7e6", color: "#2e7d32",
                          border: "1px solid #bfe6bf", borderRadius: 10, padding: "2px 8px"
                        }}>
                          Erledigt
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "#666" }}>{mail.from}</div>
                    <div style={{ fontSize: 12, color: "#999" }}>{mail.date}</div>
                  </div>
                );
              })
          )}
        </div>

        {/* Mitte: Header + E-Mail-Inhalt + Anhänge */}
        <div style={{ borderRight: "1px solid #ddd", background: "#fff", display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Realistischer Mail-Header */}
          {emailContent ? (
            <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid #eee", background: "#fff" }}>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 8 }}>
                {emailContent.subject || "(ohne Betreff)"}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                {/* Avatar */}
                <div style={{
                  width: 36, height: 36, borderRadius: "50%",
                  background: "#e5edff", color: "#2b4ae2",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700
                }}>
                  {fromInfo.initials}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ fontWeight: 600 }}>{fromInfo.name}</div>
                    <div style={{ color: "#6b7280" }}>&lt;{fromInfo.email}&gt;</div>
                  </div>
                  <div style={{ fontSize: 12, color: "#374151", marginTop: 2 }}>
                    <strong>Gesendet an:</strong> {toInfo.email || emailContent.to || "—"}
                  </div>
                </div>

                <div style={{ textAlign: "right", color: "#6b7280", fontSize: 12 }}>
                  {emailContent.date || ""}
                  {fromInfo.domain && (
                    <div style={{ marginTop: 2 }}>
                      <span style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 6, border: "1px solid #e5e7eb" }}>
                        gesendet von {fromInfo.domain}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* kleine Aktionsleiste, rein optisch */}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" title="Antworten"
                  style={{ border: "1px solid #d1d5db", background: "#fff", padding: "6px 10px", borderRadius: 8, cursor: "pointer" }}>
                  ↩️ Antworten
                </button>
                <button type="button" title="Weiterleiten"
                  style={{ border: "1px solid #d1d5db", background: "#fff", padding: "6px 10px", borderRadius: 8, cursor: "pointer" }}>
                  ➡️ Weiterleiten
                </button>
              </div>
            </div>
          ) : (
            <div style={{ padding: 12, borderBottom: "1px solid #eee" }}>
              <div style={{ fontWeight: 600, color: "#666" }}>Wähle links eine E-Mail aus</div>
            </div>
          )}

          {/* HTML-Body */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            {loading ? (
              <p style={{ padding: 12, color: "#666" }}>Lade E-Mail …</p>
            ) : emailContent ? (
              <iframe srcDoc={emailContent.html} title="email" style={{ width: "100%", height: "100%", border: "none" }} />
            ) : (
              <p style={{ padding: 12, color: "#666" }}>–</p>
            )}
          </div>

          {/* Anhänge-Leiste */}
          {emailContent && attachments && attachments.length > 0 && (
            <div style={{ padding: "8px 12px", borderTop: "1px solid #eee", background: "#fafafa" }}>
              <div style={{ fontSize: 12, marginBottom: 6, color: "#374151" }}>Anhänge</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {attachments.map((att, i) => (
                  <a
                    key={i}
                    href={`${API_URL}/api/email/${encodeURIComponent(emailContent.id)}/attachment/${i}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      padding: "6px 10px",
                      borderRadius: 8,
                      textDecoration: "none",
                      color: "#111"
                    }}
                    download
                  >
                    📎 {att.filename || `Anhang ${i+1}`}
                    <span style={{ fontSize: 11, color: "#6b7280" }}>
                      {att.content_type?.split(";")[0] || "Datei"}
                      {typeof att.size === "number" ? ` · ${Math.ceil(att.size/1024)} KB` : ""}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Rechts: Fragen – schöner Panel mit Fortschritt & Save-Bar */}
        <div style={{ display: "flex", flexDirection: "column", background: "#fff", minHeight: 0 }}>
          {/* Kopf mit Fortschritt */}
          <div style={{
            position: "sticky", top: 0, background: "#ffffffcc",
            backdropFilter: "saturate(180%) blur(6px)",
            borderBottom: "1px solid #eee", padding: "12px 12px 10px", zIndex: 2
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 700, flex: 1 }}>Fragen</h2>
              <div title="Fortschritt" style={{ flex: 1, height: 8, background: "#f2f4f7", borderRadius: 999, overflow: "hidden", outline: "1px solid #eef0f3" }}>
                <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#3b82f6,#2563eb)" }} />
              </div>
              <div style={{ fontSize: 12, color: "#374151", width: 90, textAlign: "right" }}>
                {answeredCount}/{totalQs} beantwortet
              </div>
            </div>
          </div>

          {/* Inhalt */}
          <div style={{ padding: 12, overflow: "auto" }}>
            {emailContent ? (
              questions.length ? (
                <form id="qform" onSubmit={handleSubmit}>
                  {questions.map((q) => renderPrettyQuestion(q, 0))}
                </form>
              ) : (
                <p style={{ color: "#666" }}>Keine Fragen für diese E-Mail.</p>
              )
            ) : (
              <p style={{ color: "#666" }}>Wähle links eine E-Mail aus.</p>
            )}
          </div>

          {/* Save-Bar */}
          {emailContent && (
            <div style={{
              position: "sticky", bottom: 0, display: "flex", gap: 8, justifyContent: "flex-end",
              padding: "10px 12px", background: "#ffffffd9", borderTop: "1px solid #eee",
              backdropFilter: "saturate(180%) blur(6px)", zIndex: 2
            }}>
              <button type="button"
                onClick={() => setAnswers({})}
                style={{ background: "transparent", color: "#374151", padding: "10px 14px", border: "1px solid #d1d5db", borderRadius: 10, cursor: "pointer" }}>
                Zurücksetzen
              </button>
              <button form="qform"
                style={{ background: "#2563eb", color: "#fff", padding: "10px 14px", border: 0, borderRadius: 10, cursor: "pointer", fontWeight: 600 }}>
                Speichern
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Optional: Roh-Response unten als Debug */}
      {debug.lastPayload && (
        <pre style={{ margin: 0, padding: 8, fontSize: 12, background: "#fafafa", borderTop: "1px solid #eee", color: "#333", maxHeight: 160, overflowY: "auto" }}>
{debug.lastPayload}
        </pre>
      )}
    </div>
  );
}
