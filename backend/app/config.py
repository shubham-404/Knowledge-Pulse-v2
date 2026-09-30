"""Every tunable value in the system, read from the environment once.

Nothing else in the codebase reads os.environ. If you want to change how the
crawler behaves or how insights are weighted, this is the only file to open.
"""

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- Storage ---------------------------------------------------------
    # SQLite by default so the project runs with nothing installed. Point this
    # at Postgres for deployment: postgresql+psycopg://user:pass@host/db
    database_url: str = "sqlite:///./data/knowledgepulse.db"
    chroma_path: str = "./data/chroma"
    upload_path: str = "./data/uploads"

    # --- Multi-tenancy -----------------------------------------------------
    # The organisation that owns everything created before tenancy existed, and
    # the one scripts use when no --organization-id is given. HTTP requests never
    # fall back to it: the organisation comes from the signed-in user's session.
    # See docs/TENANCY.md and docs/AUTH.md.
    default_organization_id: str = "org_default"

    # --- Sign-in -------------------------------------------------------------
    # How long a session lasts after sign-in.
    session_ttl_hours: int = 336  # 14 days
    # A demo account created (or its password reset) on every start, belonging to
    # the default organisation. Leave the password empty to create no demo user.
    # Change the password for any deployment anyone else can reach.
    demo_user_email: str = "demo@knowledgepulse.local"
    demo_user_password: str = "knowledgepulse"
    demo_user_name: str = "Sinchana"
    # Server-to-server callers (a Next.js backend, test harnesses) may name the
    # organisation with X-Organization-Id instead of a session, but only when they
    # also send this key as X-Internal-Key. Empty disables that path entirely.
    internal_api_key: str = ""

    # --- Language model --------------------------------------------------
    # "groq" for development, "gemini" for the demo. One interface, two adapters.
    llm_provider: str = "groq"
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-1.5-flash"
    llm_timeout_seconds: int = 60

    # --- Embeddings ------------------------------------------------------
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # --- Crawling and chunking -------------------------------------------
    crawl_max_pages: int = 120
    crawl_max_depth: int = 3
    crawl_delay_seconds: float = 0.4
    crawl_timeout_seconds: int = 20
    chunk_target_words: int = 220
    chunk_overlap_words: int = 40

    # --- Retrieval -------------------------------------------------------
    retrieval_top_k: int = 5
    # Ask the vector store for this many times top_k, then drop near-duplicate
    # passages and keep the first top_k that remain. Overlapping windows and two
    # sites carrying the same page otherwise fill the citation list with copies.
    retrieval_fetch_multiplier: int = 3
    # Confidence blends the single best match with the spread of the rest, so a
    # lucky one-off hit surrounded by noise does not read as high confidence.
    confidence_top_weight: float = 0.6
    low_confidence_threshold: float = 0.40

    # --- Analytics -------------------------------------------------------
    umap_neighbours: int = 12
    umap_components: int = 5
    hdbscan_min_cluster_size: int = 6
    # Two clusters in consecutive periods are the same topic above this centroid
    # cosine similarity. Tuned by hand; see docs/ARCHITECTURE.md.
    topic_match_threshold: float = 0.72
    emerging_growth_threshold: float = 0.60
    emerging_max_previous: int = 25

    # --- Evaluation ------------------------------------------------------
    # A judge call that fails (quota, timeout, unparseable reply) is retried
    # this many times before the question is dropped from the run. It is never
    # scored zero: a rate-limited run would otherwise read as a bad assistant.
    eval_judge_retries: int = 3
    eval_pause_seconds: float = 2.0
    # NFR4. Faithfulness is the one the report commits to; the other two are
    # reported against their own targets.
    eval_target_faithfulness: float = 0.80
    eval_target_answer_relevance: float = 0.80
    eval_target_context_relevance: float = 0.80

    # Priority weights: volume, growth, confidence deficit, severity.
    w_volume: float = 0.30
    w_growth: float = 0.30
    w_confidence: float = 0.25
    w_severity: float = 0.15

    # --- API -------------------------------------------------------------
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
