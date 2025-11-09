# backend/app.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime
from email import policy
from email.parser import BytesParser
import os, json, re, logging
from urllib.parse import quote

# -------------------------------------------------
# Konfiguration & Pfade
# -------------------------------------------------
EMAIL_DIR = os.environ.get("EMAIL_DIR", "/emails")
QUESTIONS_FILE = os.path.join(EMAIL_DIR, "questions.json")
ANSWERS_FILE = os.path.join(EMAIL_DIR, "answers.jsonl")
os.makedirs(EMAIL_DIR, exist_ok=True)

# -------------------------------------------------
# App & Middleware
# -------------------------------------------------
app = FastAPI(title="MailStudy Backend", version="1.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # bei Bedarf enger fassen
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailstudy")

# -------------------------------------------------
# E-Mail Parsing Utilities
# -------------------------------------------------
CID_RE = re.compile(r'src=["\']cid:([^"\']+)["\']', re.IGNORECASE)

def _parse_message(path: str):
    with open(path, "rb") as f:
        return BytesParser(policy=policy.default).parse(f)

def _extract_core(msg) -> Tuple[str, str, str, str, str, List[Dict[str, Any]], Dict[str, Any]]:
    """
    Liefert: subject, from, to, date, html_body, attachments[], cid_parts{}
    attachments: filename, content_type, size
    cid_parts: Mapping Content-ID (ohne <>) -> EmailMessage-Part
    """
    subject = msg.get("subject", "(ohne Betreff)")
    from_   = msg.get("from")
    to_     = msg.get("to")
    date_   = msg.get("date")

    html_body: Optional[str] = None
    text_body: Optional[str] = None
    attachments: List[Dict[str, Any]] = []
    cid_parts: Dict[str, Any] = {}

    if msg.is_multipart():
        for part in msg.walk():
            ctype = (part.get_content_type() or "").lower()
            disp = (part.get("Content-Disposition") or "").lower()
            cid_raw = part.get("Content-ID")
            if cid_raw:
                cid_parts[cid_raw.strip("<>")] = part

            # Body
            if ctype == "text/html" and html_body is None:
                html_body = part.get_content()
            elif ctype == "text/plain" and text_body is None:
                text_body = part.get_content()

            # Anhänge (Disposition: attachment)
            if "attachment" in disp:
                # Größe ermitteln
                size = None
                try:
                    payload = part.get_content()
                    if isinstance(payload, (bytes, bytearray)):
                        size = len(payload)
                    elif isinstance(payload, str):
                        size = len(payload.encode("utf-8"))
                except Exception:
                    pass

                attachments.append({
                    "filename": part.get_filename() or "attachment",
                    "content_type": ctype or "application/octet-stream",
                    "size": size
                })
    else:
        ctype = (msg.get_content_type() or "").lower()
        if ctype == "text/html":
            html_body = msg.get_content()
        else:
            text_body = msg.get_content()

    if not html_body:
        # Plain-Fallback als <pre>
        safe = (text_body or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        html_body = f"<pre style='white-space:pre-wrap;font-family:system-ui,monospace'>{safe}</pre>"

    return subject, from_, to_, date_, html_body, attachments, cid_parts

def _load_eml(path: str, eid: Optional[str] = None) -> Dict[str, Any]:
    """Parst eine .eml-Datei, rewritet CID-Quellen auf unseren Inline-Endpunkt und gibt die Inhalte zurück."""
    msg = _parse_message(path)
    subject, from_, to_, date_, html_body, attachments, cid_parts = _extract_core(msg)

    # CIDs im HTML auf unseren Inline-Endpunkt umbiegen (damit inline-Bilder angezeigt werden)
    if eid and cid_parts:
        def repl(m):
            cid = m.group(1)
            return f'src="/api/email/{quote(eid)}/inline/{quote(cid)}"'
        html_body = CID_RE.sub(repl, html_body)

    return {
        "id": os.path.basename(path),
        "subject": subject,
        "from": from_,
        "to": to_,
        "date": date_,
        "html": html_body,
        "attachments": attachments
    }

def _list_eml_files() -> List[str]:
    try:
        return sorted([f for f in os.listdir(EMAIL_DIR) if f.lower().endswith(".eml")])
    except FileNotFoundError:
        return []

# -------------------------------------------------
# Fragen / Antworten Utilities
# -------------------------------------------------
def _load_questions_for(eid: str) -> List[Dict[str, Any]]:
    if not os.path.exists(QUESTIONS_FILE):
        return []
    try:
        with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        log.warning("questions.json ist ungültig – ignoriert.")
        return []
    return data.get(eid, data.get("default", []))

def _load_answered_ids() -> List[str]:
    ids = set()
    if os.path.exists(ANSWERS_FILE):
        with open(ANSWERS_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    eid = rec.get("email_id")
                    if eid:
                        ids.add(eid)
                except json.JSONDecodeError:
                    continue
    return sorted(ids)

class Answer(BaseModel):
    email_id: str
    answers: Dict[str, Any]

# -------------------------------------------------
# Endpoints
# -------------------------------------------------
@app.get("/api/status")
def api_status():
    return {
        "ok": True,
        "time": datetime.utcnow().isoformat() + "Z",
        "email_dir": EMAIL_DIR,
        "emails_found": len(_list_eml_files())
    }

@app.get("/api/emails")
def api_emails():
    items = []
    for name in _list_eml_files():
        path = os.path.join(EMAIL_DIR, name)
        try:
            meta = _load_eml(path)  # ohne eid -> kein CID-Rewrite nötig
            items.append({
                "id": meta["id"],
                "subject": meta["subject"],
                "from": meta["from"],
                "date": meta["date"]
            })
        except Exception as e:
            log.exception("Fehler beim Parsen %s: %s", name, e)
    return items

@app.get("/api/email/{eid}")
def api_email(eid: str):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="E-Mail nicht gefunden")
    try:
        return _load_eml(path, eid=eid)
    except Exception as e:
        log.exception("Fehler beim Laden %s: %s", eid, e)
        raise HTTPException(status_code=500, detail="Fehler beim Parsen der E-Mail")

@app.get("/api/questions/{eid}")
def api_questions(eid: str):
    return _load_questions_for(eid)

@app.get("/api/answered")
def api_answered():
    return {"answered": _load_answered_ids()}

@app.post("/api/answer")
def api_answer(payload: Answer):
    record = payload.dict()
    record["timestamp"] = datetime.utcnow().isoformat() + "Z"
    try:
        with open(ANSWERS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        return {"status": "ok", "answered": True}
    except Exception as e:
        log.exception("Fehler beim Schreiben answers.jsonl: %s", e)
        raise HTTPException(status_code=500, detail="Antwort konnte nicht gespeichert werden")

# ---------- Anhänge & Inline-CIDs ----------
@app.get("/api/email/{eid}/attachments")
def api_email_attachments(eid: str):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="E-Mail nicht gefunden")
    msg = _parse_message(path)
    _, _, _, _, _, attachments, _ = _extract_core(msg)
    return {"attachments": attachments}

@app.get("/api/email/{eid}/attachment/{index}")
def api_email_attachment(eid: str, index: int):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="E-Mail nicht gefunden")

    msg = _parse_message(path)
    parts = []
    for part in msg.walk():
        disp = (part.get("Content-Disposition") or "").lower()
        if "attachment" in disp:
            parts.append(part)

    if index < 0 or index >= len(parts):
        raise HTTPException(status_code=404, detail="Attachment nicht gefunden")

    part = parts[index]
    ctype = part.get_content_type() or "application/octet-stream"
    filename = part.get_filename() or f"attachment-{index}"
    payload = part.get_content()
    if isinstance(payload, str):
        payload = payload.encode("utf-8")

    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(content=payload, media_type=ctype, headers=headers)

@app.get("/api/email/{eid}/inline/{cid}")
def api_email_inline(eid: str, cid: str):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="E-Mail nicht gefunden")

    msg = _parse_message(path)
    target = None
    for part in msg.walk():
        cid_raw = part.get("Content-ID")
        if cid_raw and cid_raw.strip("<>") == cid:
            target = part
            break
    if not target:
        raise HTTPException(status_code=404, detail="CID nicht gefunden")

    ctype = target.get_content_type() or "application/octet-stream"
    payload = target.get_content()
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return Response(content=payload, media_type=ctype)
