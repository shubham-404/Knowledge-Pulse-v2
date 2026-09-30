from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Chunk, Conversation, Message, Source, Workspace
from app.rag import engine
from app.schemas import ChatRequest, CitationOut, ConversationOut, MessageOut
from app.workspaces import current_workspace

router = APIRouter(prefix="/api", tags=["chat"])

HISTORY_LIMIT = 200


def _citations(db: Session, message: Message) -> list[CitationOut]:
    """The citations stored with the turn. Turns from before they were stored are
    rebuilt from their chunk ids, for whichever chunks still exist."""
    if message.role != "assistant":
        return []
    if message.citations is not None:
        return [CitationOut(**c) for c in message.citations]
    out = []
    scores = message.retrieved_scores or []
    for n, chunk_id in enumerate(message.retrieved_chunk_ids or []):
        chunk = db.get(Chunk, chunk_id)
        if chunk is None:
            continue
        source = db.get(Source, chunk.source_id)
        out.append(
            CitationOut(
                chunkId=chunk.id,
                sourceLabel=source.label if source else "unknown",
                headingPath=chunk.heading_path,
                similarity=round(scores[n], 4) if n < len(scores) else 0.0,
                excerpt=chunk.text[:320],
            )
        )
    return out


def _utc(value):
    """SQLite stores naive datetimes; they are UTC, so say so or browsers guess."""
    return value if value is None or value.tzinfo else value.replace(tzinfo=timezone.utc)


def _out(db: Session, message: Message) -> MessageOut:
    return MessageOut(
        id=message.id,
        role=message.role,
        text=message.text,
        # Stored without a zone on SQLite; always UTC, so say so, or browsers read it as local time.
        createdAt=message.created_at if message.created_at.tzinfo else message.created_at.replace(tzinfo=timezone.utc),
        confidence=message.confidence if message.role == "assistant" else None,
        citations=_citations(db, message),
    )


@router.post("/chat", response_model=MessageOut)
def chat(payload: ChatRequest, db: Session = Depends(get_db), ws: Workspace = Depends(current_workspace)):
    if payload.source_id:
        source = db.get(Source, payload.source_id)
        if source is None or source.workspace_id != ws.id:
            raise HTTPException(404, "No knowledge source with that id in this workspace")
    message = engine.answer(
        db,
        payload.question,
        payload.session_id,
        workspace_id=ws.id,
        source_id=payload.source_id,
    )
    return _out(db, message)


CONVERSATION_LIMIT = 50
TITLE_LENGTH = 70


@router.get("/chat/conversations", response_model=list[ConversationOut])
def conversations(
    limit: int = Query(CONVERSATION_LIMIT, ge=1, le=200),
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    """Past conversations in this workspace, most recent first.

    Starting a new conversation used to be the end of the old one as far as the
    interface was concerned: the turns stayed in the database but nothing listed
    them, so there was no way back. This is that list. Synthetic conversations
    from the seeding script are left out — there are hundreds of them and none
    of them were typed by the person reading this.

    The title is the first question asked, which is what anyone would recognise
    the conversation by.
    """
    rows = (
        db.query(
            Conversation.session_id,
            Conversation.started_at,
            func.max(Message.created_at).label("last_at"),
            func.count(Message.id).label("turns"),
            func.avg(Message.confidence).label("confidence"),
        )
        .join(Message, Message.conversation_id == Conversation.id)
        .filter(
            Conversation.workspace_id == ws.id,
            Conversation.synthetic.is_(False),
        )
        .group_by(Conversation.id, Conversation.session_id, Conversation.started_at)
        .order_by(func.max(Message.created_at).desc())
        .limit(limit)
        .all()
    )
    if not rows:
        return []

    # One query for the opening question of each conversation, rather than one
    # query per conversation.
    sessions = [r.session_id for r in rows]
    openers: dict[str, str] = {}
    first_questions = (
        db.query(Conversation.session_id, Message.text, Message.created_at)
        .join(Message, Message.conversation_id == Conversation.id)
        .filter(
            Conversation.workspace_id == ws.id,
            Conversation.session_id.in_(sessions),
            Message.role == "customer",
        )
        .order_by(Message.created_at.asc())
        .all()
    )
    for session_id, text, _ in first_questions:
        openers.setdefault(session_id, text)

    out = []
    for row in rows:
        title = (openers.get(row.session_id) or "New conversation").strip()
        if len(title) > TITLE_LENGTH:
            title = title[: TITLE_LENGTH - 1].rstrip() + "\u2026"
        out.append(
            ConversationOut(
                sessionId=row.session_id,
                startedAt=_utc(row.started_at),
                lastMessageAt=_utc(row.last_at),
                turnCount=row.turns,
                title=title,
                meanConfidence=round(float(row.confidence), 4) if row.confidence is not None else None,
            )
        )
    return out


@router.get("/chat/history", response_model=list[MessageOut])
def history(
    session_id: str = Query(..., min_length=1, max_length=80),
    db: Session = Depends(get_db),
    ws: Workspace = Depends(current_workspace),
):
    """Every turn of one conversation in this workspace, oldest first.

    Empty for a session that has not asked anything yet, rather than 404, so the
    frontend can load history for a brand-new session without special-casing it.
    """
    conversation = (
        db.query(Conversation)
        .filter(Conversation.session_id == session_id, Conversation.workspace_id == ws.id)
        .one_or_none()
    )
    if conversation is None:
        return []
    turns = (
        db.query(Message)
        .filter(Message.conversation_id == conversation.id)
        .order_by(Message.created_at.desc())
        .limit(HISTORY_LIMIT)
        .all()
    )
    # A question and its answer share a timestamp; the question comes first.
    turns.sort(key=lambda m: (m.created_at, m.role != "customer"))
    return [_out(db, m) for m in turns]
