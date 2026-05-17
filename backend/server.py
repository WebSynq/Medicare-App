"""FastAPI app — Gruening Health & Wealth Medicare Intake."""
import os
import logging
from pathlib import Path

from fastapi import FastAPI, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from deps import get_db  # noqa: E402
from auth_router import router as auth_router  # noqa: E402
from leads_router import router as leads_router  # noqa: E402
from documents_router import router as documents_router  # noqa: E402
from commissions_router import router as commissions_router  # noqa: E402
from admin_commissions_router import router as admin_commissions_router  # noqa: E402
from soa_router import router as soa_router  # noqa: E402
from audit_router import router as audit_router  # noqa: E402
from seed import seed_admin  # noqa: E402


logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("gruening")

app = FastAPI(title="Gruening Health & Wealth — Medicare Intake API")

api_router = APIRouter(prefix="/api")


@api_router.get("/")
async def root():
    return {"app": "Gruening Health & Wealth Medicare Intake",
            "status": "ok",
            "hipaa_safeguards": ["TLS", "AES-128 at rest (docs)", "JWT", "TOTP MFA", "Audit Log", "RBAC"]}


@api_router.get("/health")
async def health(db=__import__("fastapi").Depends(get_db)):
    try:
        await db.command("ping")
        return {"status": "ok", "mongo": "ok"}
    except Exception as e:
        return {"status": "degraded", "mongo": str(e)}


app.include_router(api_router)
app.include_router(auth_router, prefix="/api")
app.include_router(leads_router, prefix="/api")
app.include_router(documents_router, prefix="/api")
app.include_router(commissions_router, prefix="/api")
app.include_router(admin_commissions_router, prefix="/api")
app.include_router(soa_router, prefix="/api")
app.include_router(audit_router, prefix="/api")


app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup():
    db = get_db()
    await db.users.create_index("email", unique=True)
    await db.leads.create_index("created_at")
    await db.documents.create_index("lead_id")
    await db.audit_logs.create_index("timestamp")
    await db.commission_syncs.create_index("agent_id")
    await db.commission_syncs.create_index("uploaded_at")
    await seed_admin(db)
    logger.info("Startup complete. Admin seeded if missing.")
