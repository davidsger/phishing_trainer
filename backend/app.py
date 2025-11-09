from fastapi import FastAPI, HTTPException, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional, Tuple, Iterable
from datetime import datetime
from email import policy
from email.parser import BytesParser
import os, json, re, logging, tempfile, time, hmac, hashlib, base64, secrets

EMAIL_DIR = os.environ.get("EMAIL_DIR", "/emails")
QUESTIONS_FILE = os.path.join(EMAIL_DIR, "questions.json")
ANSWERS_FILE = os.path.join(EMAIL_DIR, "answers.jsonl")
SUPPOSED_FILE = os.path.join(EMAIL_DIR, "supposed_answers.json")

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")  # in docker-compose überschreiben!
TOKEN_TTL_SECONDS = int(os.environ.get("ADMIN_TOKEN_TTL", "43200"))  # 12h

os.makedirs(EMAIL_DIR, exist_ok=True)

app = FastAPI(title="MailStudy Backend", version="1.5.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailstudy")

CID_RE = re.compile(r'src=["\']cid:([^"\']+)["\']', re.IGNORECASE)

# ---- Token utils ----
def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")

def _b64url_decode(s: str) -> bytes:
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))

def _hmac_sign(data: bytes) -> bytes:
    return hmac.new(ADMIN_PASSWORD.encode("utf-8"), data, hashlib.sha256).digest()

def sign_admin_token(ttl: int = TOKEN_TTL_SECONDS) -> str:
    payload = {"iat": int(time.time()), "exp": int(time.time()) + int(ttl), "nonce": secrets.token_hex(8)}
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return f"{_b64url_encode(body)}.{_b64url_encode(_hmac_sign(body))}"

def verify_admin_token(token: str) -> Dict[str, Any]:
    body_b64, sig_b64 = token.split(".", 1)
    body = _b64url_decode(body_b64)
    sig = _b64url_decode(sig_b64)
    expected = _hmac_sign(body)
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401, detail="Unauthorized: invalid signature")
    payload = json.loads(body.decode("utf-8"))
    if int(payload.get("exp", 0)) < int(time.time()):
        raise HTTPException(status_code=401, detail="Unauthorized: token expired")
    return payload

def require_admin(authorization: Optional[str]):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ", 1)[1].strip()
    verify_admin_token(token)

# ---- Email parsing ----
def _parse_message(path: str):
    with open(path, "rb") as f:
        return BytesParser(policy=policy.default).parse(f)

def _extract_core(msg) -> Tuple[str, str, str, str, str, List[Dict[str, Any]], Dict[str, Any]]:
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
            if ctype == "text/html" and html_body is None:
                html_body = part.get_content()
            elif ctype == "text/plain" and text_body is None:
                text_body = part.get_content()
            if "attachment" in disp:
                size = None
                try:
                    payload = part.get_content()
                    size = len(payload if isinstance(payload, (bytes, bytearray)) else payload.encode("utf-8"))
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
        safe = (text_body or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        html_body = f"<pre style='white-space:pre-wrap;font-family:system-ui,monospace'>{safe}</pre>"

    return subject, from_, to_, date_, html_body, attachments, cid_parts

def _load_eml(path: str, eid: Optional[str] = None) -> Dict[str, Any]:
    msg = _parse_message(path)
    subject, from_, to_, date_, html_body, attachments, cid_parts = _extract_core(msg)
    if eid and cid_parts:
        def repl(m): return f'src="/api/email/{eid}/inline/{m.group(1)}"'
        html_body = CID_RE.sub(repl, html_body)
    return {"id": os.path.basename(path), "subject": subject, "from": from_, "to": to_, "date": date_, "html": html_body, "attachments": attachments}

def _list_eml_files() -> List[str]:
    try:
        return sorted([f for f in os.listdir(EMAIL_DIR) if f.lower().endswith(".eml")])
    except FileNotFoundError:
        return []

# ---- Questions & storage ----
def _load_questions_for(eid: str) -> List[Dict[str, Any]]:
    if not os.path.exists(QUESTIONS_FILE): return []
    try:
        with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        return []
    return data.get(eid, data.get("default", []))

def _iter_answers() -> Iterable[Dict[str, Any]]:
    if not os.path.exists(ANSWERS_FILE): return []
    with open(ANSWERS_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: yield json.loads(line)
            except json.JSONDecodeError: continue

def _answered_ids_for(participant: Optional[str]) -> List[str]:
    ids = set()
    for rec in _iter_answers():
        if participant and rec.get("participant_id") != participant:
            continue
        eid = rec.get("email_id")
        if eid: ids.add(eid)
    return sorted(ids)

def _read_json_file_safely(path: str) -> Dict[str, Any]:
    if not os.path.exists(path): return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}

def _atomic_write_json(path: str, data: Dict[str, Any]):
    fd, tmp = tempfile.mkstemp(prefix="tmp_", suffix=".json", dir=os.path.dirname(path) or ".")
    os.close(fd)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def _normalize_solution_entry(v: Any) -> Dict[str, Any]:
    if isinstance(v, dict) and ("solution" in v or "solution_regex" in v):
        return v
    return {"solution": v}

# ---- Schemas ----
class Answer(BaseModel):
    email_id: str = Field(..., description="E-Mail-ID, z. B. foo.eml")
    participant_id: str = Field(..., min_length=1)
    answers: Dict[str, Any]
    mode: Optional[str] = Field(None, description="test|training|admin")

class SupposedSave(BaseModel):
    solutions: Dict[str, Any]

class AdminLogin(BaseModel):
    password: str

# ---- API ----
@app.get("/api/status")
def api_status():
    return {"ok": True, "time": datetime.utcnow().isoformat() + "Z", "email_dir": EMAIL_DIR, "emails_found": len(_list_eml_files())}

@app.post("/api/admin/login")
def api_admin_login(payload: AdminLogin):
    if payload.password != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = sign_admin_token()
    return {"token": token, "ttl_seconds": TOKEN_TTL_SECONDS}

@app.get("/api/emails")
def api_emails():
    out = []
    for name in _list_eml_files():
        try:
            meta = _load_eml(os.path.join(EMAIL_DIR, name))
            out.append({"id": meta["id"], "subject": meta["subject"], "from": meta["from"], "date": meta["date"]})
        except Exception:
            continue
    return out

@app.get("/api/email/{eid}")
def api_email(eid: str):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path): raise HTTPException(404, "E-Mail nicht gefunden")
    return _load_eml(path, eid=eid)

@app.get("/api/questions/{eid}")
def api_questions(eid: str):
    return _load_questions_for(eid)

@app.get("/api/answered")
def api_answered(participant: Optional[str] = Query(default=None)):
    return {"answered": _answered_ids_for(participant)}

@app.post("/api/answer")
def api_answer(payload: Answer):
    if payload.mode == "test":
        for rec in _iter_answers():
            if rec.get("mode") == "test" and rec.get("participant_id") == payload.participant_id and rec.get("email_id") == payload.email_id:
                raise HTTPException(status_code=409, detail="Bereits beantwortet (Test).")
    record = payload.dict()
    record["timestamp"] = datetime.utcnow().isoformat() + "Z"
    with open(ANSWERS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return {"status": "ok", "answered": True}

@app.get("/api/email/{eid}/attachments")
def api_email_attachments(eid: str):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path): raise HTTPException(404, "E-Mail nicht gefunden")
    msg = _parse_message(path)
    _, _, _, _, _, attachments, _ = _extract_core(msg)
    return {"attachments": attachments}

@app.get("/api/email/{eid}/attachment/{index}")
def api_email_attachment(eid: str, index: int):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path): raise HTTPException(404, "E-Mail nicht gefunden")
    msg = _parse_message(path)
    parts = []
    for part in msg.walk():
        if "attachment" in (part.get("Content-Disposition") or "").lower():
            parts.append(part)
    if index < 0 or index >= len(parts): raise HTTPException(404, "Attachment nicht gefunden")
    part = parts[index]
    payload = part.get_content()
    if isinstance(payload, str): payload = payload.encode("utf-8")
    return Response(content=payload, media_type=part.get_content_type() or "application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{part.get_filename() or f"attachment-{index}"}"'})

@app.get("/api/email/{eid}/inline/{cid}")
def api_email_inline(eid: str, cid: str):
    path = os.path.join(EMAIL_DIR, eid)
    if not os.path.exists(path): raise HTTPException(404, "E-Mail nicht gefunden")
    msg = _parse_message(path)
    for part in msg.walk():
        cid_raw = part.get("Content-ID")
        if cid_raw and cid_raw.strip("<>") == cid:
            payload = part.get_content()
            if isinstance(payload, str): payload = payload.encode("utf-8")
            return Response(content=payload, media_type=part.get_content_type() or "application/octet-stream")
    raise HTTPException(404, "CID nicht gefunden")

@app.get("/api/supposed/{eid}")
def api_get_supposed(eid: str):
    data = _read_json_file_safely(SUPPOSED_FILE)
    merged = dict(data.get("default", {}))
    merged.update(data.get(eid, {}) or {})
    return {"email_id": eid, "solutions": merged}

@app.post("/api/supposed/{eid}")
def api_set_supposed(eid: str, payload: SupposedSave, authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)
    data = _read_json_file_safely(SUPPOSED_FILE)
    data.setdefault("default", {})
    block = { qid: _normalize_solution_entry(val) for qid, val in payload.solutions.items() }
    data[eid] = block
    _atomic_write_json(SUPPOSED_FILE, data)
    return {"status": "ok", "email_id": eid, "count": len(block)}

@app.get("/api/participants")
def api_participants(authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)
    pids = sorted({rec.get("participant_id") for rec in _iter_answers() if rec.get("participant_id")})
    return {"participants": pids}

@app.get("/api/export/answers")
def api_export_answers(participant: Optional[str] = None, authorization: Optional[str] = Header(default=None)):
    require_admin(authorization)
    def gen():
        if not os.path.exists(ANSWERS_FILE): return
        with open(ANSWERS_FILE, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip(): continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if participant and rec.get("participant_id") != participant:
                    continue
                yield (json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8")
    return StreamingResponse(gen(), media_type="application/x-ndjson")
