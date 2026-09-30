"""The client report as a PDF.

The report is the deliverable the whole system exists to produce, and a
documentation owner wants to forward it, not screenshot it. So it is rendered
server-side rather than printed from the browser: the file is identical whoever
downloads it, it carries the filters that produced it on the front page, and it
does not depend on a print stylesheet behaving.

ReportLab's platypus flowables are used rather than drawing to a canvas, so the
content paginates itself. Nothing here queries the database: it is handed the
rows the API already assembled, which keeps the filtering logic in one place.
"""

from __future__ import annotations

import io
from datetime import datetime
from html import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models import Recommendation, Report

# The interface palette, so a printed report and the screen agree.
INK = colors.HexColor("#1F1D1A")
INK_SOFT = colors.HexColor("#55504A")
INK_FAINT = colors.HexColor("#8A837B")
RULE = colors.HexColor("#DFD9D0")
OXBLOOD = colors.HexColor("#7A2029")
OLIVE = colors.HexColor("#4F5D3A")
OCHRE = colors.HexColor("#9A6B12")
PAPER_SUNK = colors.HexColor("#F5F1EA")

CATEGORY_COLOUR = {
    "product": OXBLOOD,
    "documentation": OCHRE,
    "faq": OLIVE,
    "customer_issue": INK_SOFT,
}

CATEGORY_LABEL = {
    "product": "Product change",
    "documentation": "Documentation change",
    "faq": "FAQ entry",
    "customer_issue": "Customer issue",
}

CATEGORY_NOTE = {
    "product": "Customers stayed confused although the documentation covers this, "
               "so the difficulty is in the product rather than its explanation.",
    "documentation": "Retrieval confidence stayed low on this topic, which means "
                     "the corpus does not contain the answer clearly enough.",
    "faq": "High volume, already answered well. Publishing it saves the assistant "
           "the round trip.",
    "customer_issue": "Individual conversations that ended unresolved and need "
                      "someone to follow up directly.",
}

CATEGORY_ORDER = ["product", "documentation", "faq", "customer_issue"]


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "kpTitle", parent=base["Title"], fontName="Helvetica-Bold",
            fontSize=22, leading=26, textColor=INK, alignment=TA_LEFT, spaceAfter=2,
        ),
        "subtitle": ParagraphStyle(
            "kpSubtitle", parent=base["Normal"], fontName="Helvetica",
            fontSize=10, leading=14, textColor=INK_FAINT, spaceAfter=10,
        ),
        "h2": ParagraphStyle(
            "kpH2", parent=base["Heading2"], fontName="Helvetica-Bold",
            fontSize=13, leading=17, textColor=INK, spaceBefore=16, spaceAfter=2,
        ),
        "h3": ParagraphStyle(
            "kpH3", parent=base["Heading3"], fontName="Helvetica-Bold",
            fontSize=11, leading=15, textColor=INK, spaceBefore=8, spaceAfter=3,
        ),
        "body": ParagraphStyle(
            "kpBody", parent=base["Normal"], fontName="Helvetica",
            fontSize=9.5, leading=14, textColor=INK_SOFT, spaceAfter=4,
        ),
        "lead": ParagraphStyle(
            "kpLead", parent=base["Normal"], fontName="Helvetica",
            fontSize=11, leading=16, textColor=INK_SOFT, spaceAfter=6,
        ),
        "micro": ParagraphStyle(
            "kpMicro", parent=base["Normal"], fontName="Helvetica",
            fontSize=8, leading=11, textColor=INK_FAINT, spaceAfter=2,
        ),
        "quote": ParagraphStyle(
            "kpQuote", parent=base["Normal"], fontName="Helvetica-Oblique",
            fontSize=9, leading=13, textColor=INK_SOFT, leftIndent=8, spaceAfter=1,
        ),
    }


def _growth(value: float) -> str:
    if value is None:
        return "no comparison"
    if value >= 9.99:
        return "new this period"
    return f"{'+' if value >= 0 else ''}{round(value * 100)}% vs last period"


def _badge(category: str, styles) -> Table:
    label = CATEGORY_LABEL.get(category, category)
    cell = Paragraph(
        f'<font color="#FFFFFF" size="7.5"><b>{escape(label.upper())}</b></font>',
        styles["micro"],
    )
    table = Table([[cell]], colWidths=[len(label) * 5.4 + 14])
    table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), CATEGORY_COLOUR.get(category, INK_SOFT)),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ])
    )
    return table


def _summary_table(report: Report, styles) -> Table:
    figures = [
        ("Conversations", f"{report.conversation_count:,}"),
        ("Questions", f"{report.query_count:,}"),
        ("Unanswered rate", f"{report.unanswered_rate * 100:.1f}%"),
    ]
    rows = [
        [Paragraph(label.upper(), styles["micro"]) for label, _ in figures],
        [Paragraph(f'<font size="16" color="#1F1D1A"><b>{value}</b></font>', styles["body"])
         for _, value in figures],
    ]
    table = Table(rows, colWidths=[56 * mm] * 3)
    table.setStyle(
        TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PAPER_SUNK),
            ("BOX", (0, 0), (-1, -1), 0.5, RULE),
            ("INNERGRID", (0, 0), (-1, -1), 0.5, RULE),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ])
    )
    return table


def _recommendation(rec: Recommendation, styles) -> list:
    """One recommendation, kept on a single page where it fits."""
    parts: list = [
        _badge(rec.category, styles),
        Spacer(1, 4),
        Paragraph(escape(rec.headline), styles["h3"]),
        Paragraph(escape(rec.body), styles["body"]),
    ]

    if rec.faq_answer:
        parts += [
            Spacer(1, 3),
            Paragraph("DRAFT ANSWER, READY TO PUBLISH", styles["micro"]),
            Paragraph(escape(rec.faq_answer), styles["quote"]),
        ]

    if rec.expected_effect:
        parts += [
            Spacer(1, 3),
            Paragraph(
                f'<font color="#8A837B">If you do this: </font>{escape(rec.expected_effect)}',
                styles["body"],
            ),
        ]

    queries = rec.supporting_queries or []
    if queries:
        parts += [
            Spacer(1, 3),
            Paragraph(f"THE {len(queries)} CUSTOMER QUESTIONS BEHIND THIS", styles["micro"]),
        ]
        parts += [Paragraph(f"&ldquo;{escape(q)}&rdquo;", styles["quote"]) for q in queries]

    parts += [
        Spacer(1, 4),
        HRFlowable(width="100%", thickness=0.5, color=RULE, spaceBefore=0, spaceAfter=3),
        Paragraph(
            f"{rec.volume} questions &nbsp;&nbsp;·&nbsp;&nbsp; {_growth(rec.growth)}"
            f" &nbsp;&nbsp;·&nbsp;&nbsp; Topic: {escape(rec.cluster_name)}",
            styles["micro"],
        ),
        Spacer(1, 12),
    ]
    return [KeepTogether(parts)]


def _filter_line(filters: dict[str, object]) -> str:
    described = [f"{key}: {value}" for key, value in filters.items() if value]
    return " &nbsp;·&nbsp; ".join(escape(d) for d in described) or "No filters applied"


def render_report_pdf(
    reports: list[Report],
    recommendations_by_report: dict[str, list[Recommendation]],
    filters: dict[str, object],
    workspace_name: str,
) -> bytes:
    """Render one or more periods into a single PDF and return its bytes."""
    buffer = io.BytesIO()
    styles = _styles()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm,
        topMargin=16 * mm, bottomMargin=16 * mm,
        title="KnowledgePulse client report",
        author="KnowledgePulse",
    )

    story: list = [
        Paragraph("KnowledgePulse", styles["title"]),
        Paragraph(
            f"Client report &nbsp;·&nbsp; {escape(workspace_name)} &nbsp;·&nbsp; "
            f"generated {datetime.now().strftime('%d %B %Y, %H:%M')}",
            styles["subtitle"],
        ),
        HRFlowable(width="100%", thickness=1, color=INK, spaceAfter=8),
        Paragraph(_filter_line(filters), styles["micro"]),
        Spacer(1, 10),
    ]

    if not reports:
        story.append(
            Paragraph(
                "No report matches these filters. Reports are written by the analytics "
                "batch: run it for a period once that period has enough logged questions.",
                styles["lead"],
            )
        )
        doc.build(story)
        return buffer.getvalue()

    for index, report in enumerate(reports):
        if index:
            story.append(PageBreak())

        scope = report.source_label or "All sources"
        story += [
            Paragraph(f"{escape(report.period)} &nbsp;·&nbsp; {escape(scope)}", styles["h2"]),
            Paragraph(escape(report.summary or ""), styles["lead"]),
            Spacer(1, 6),
            _summary_table(report, styles),
            Spacer(1, 6),
        ]

        recommendations = recommendations_by_report.get(report.id, [])
        if not recommendations:
            story.append(
                Paragraph(
                    "No recommendations in this period matched the selected categories.",
                    styles["body"],
                )
            )
            continue

        for category in CATEGORY_ORDER:
            group = [r for r in recommendations if r.category == category]
            if not group:
                continue
            story += [
                Paragraph(CATEGORY_LABEL.get(category, category), styles["h2"]),
                Paragraph(CATEGORY_NOTE.get(category, ""), styles["micro"]),
                Spacer(1, 6),
            ]
            for rec in group:
                story += _recommendation(rec, styles)

    def footer(canvas, document):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(INK_FAINT)
        canvas.drawString(18 * mm, 10 * mm, "KnowledgePulse client report")
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"Page {document.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
